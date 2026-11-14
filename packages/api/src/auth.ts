import type http from 'node:http';
import {
  AUTH_SESSION_COOKIE,
  AUTH_SESSION_MAX_AGE_SECONDS,
  findSessionAuth,
  getApproval,
  type UserRole,
} from '@src-agent/control-plane';

// ── API authentication / authorization ──────────────────────
// Service tokens remain for workers and automation. Humans use a server-side
// session cookie; cookie-authenticated mutations require a CSRF token.

const AUTH_TOKEN = process.env.API_AUTH_TOKEN?.trim() || '';
const ADMIN_TOKEN = process.env.API_ADMIN_TOKEN?.trim() || '';
const READ_TOKEN = process.env.API_READ_TOKEN?.trim() || '';
export const AUTH_MODE = (process.env.AUTH_MODE || 'accounts').trim().toLowerCase();

export interface AuthContext {
  kind: 'service' | 'user' | 'dev';
  role: UserRole;
  actor: string;
  userId: string | null;
  csrfToken: string | null;
  sessionToken: string | null;
  /** True while the account still carries the bootstrap password. */
  mustChangePassword: boolean;
}

export interface JsonResultWithHeaders {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(token: string): string {
  const secure = process.env.AUTH_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${AUTH_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_SESSION_MAX_AGE_SECONDS}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.AUTH_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${AUTH_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function bearer(request: http.IncomingMessage): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function isPublicPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/auth/login';
}

/**
 * Paths an account with the bootstrap password may still use. Everything else
 * is rejected with `password_change_required` until the password is replaced,
 * so a shared bootstrap password cannot be used to drive the console.
 */
const PASSWORD_CHANGE_PATHS = new Set(['/api/health', '/api/auth/me', '/api/auth/password', '/api/auth/logout']);

export function passwordChangeRequired(auth: AuthContext, pathname: string): boolean {
  return auth.kind === 'user' && auth.mustChangePassword && !PASSWORD_CHANGE_PATHS.has(pathname);
}

/** Resolves the caller without revealing whether a token exists. */
export async function authenticateRequest(
  request: http.IncomingMessage,
  url: URL,
): Promise<AuthContext | null> {
  const token = bearer(request);
  if (token) {
    if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { kind: 'service', role: 'admin', actor: 'service:admin', userId: null, csrfToken: null, sessionToken: null, mustChangePassword: false };
    if (token === AUTH_TOKEN) return { kind: 'service', role: 'admin', actor: 'service:api', userId: null, csrfToken: null, sessionToken: null, mustChangePassword: false };
    if (READ_TOKEN && token === READ_TOKEN) return { kind: 'service', role: 'viewer', actor: 'service:read', userId: null, csrfToken: null, sessionToken: null, mustChangePassword: false };
  }
  // EventSource cannot attach Authorization; keep the v1 ?token= stream path.
  const queryToken = url.pathname.endsWith('/stream') ? (url.searchParams.get('token') ?? '') : '';
  if (queryToken) {
    if ((ADMIN_TOKEN && queryToken === ADMIN_TOKEN) || queryToken === AUTH_TOKEN) {
      return { kind: 'service', role: 'admin', actor: 'service:stream', userId: null, csrfToken: null, sessionToken: null, mustChangePassword: false };
    }
  }
  const cookieToken = parseCookies(request.headers.cookie)[AUTH_SESSION_COOKIE] ?? '';
  if (cookieToken) {
    const session = await findSessionAuth(cookieToken);
    if (session) {
      return {
        kind: 'user',
        role: session.user.role,
        actor: session.user.username,
        userId: session.user.id,
        csrfToken: session.csrfToken,
        sessionToken: cookieToken,
        mustChangePassword: session.user.mustChangePassword,
      };
    }
  }
  // Legacy dev mode preserves the pre-accounts behavior only when no token
  // configuration exists at all.
  if (AUTH_MODE === 'legacy' && !AUTH_TOKEN && !ADMIN_TOKEN) {
    return { kind: 'dev', role: 'admin', actor: 'dev', userId: null, csrfToken: null, sessionToken: null, mustChangePassword: false };
  }
  if (AUTH_MODE === 'legacy' && !AUTH_TOKEN && ADMIN_TOKEN) {
    return null;
  }
  return null;
}

function roleRank(role: UserRole): number {
  return role === 'admin' ? 3 : role === 'operator' ? 2 : 1;
}

function denied(): JsonResultWithHeaders {
  return { status: 403, body: { error: 'forbidden' } };
}

/** Central route policy. Public routes are handled before this call. */
export async function authorizeRoute(
  request: http.IncomingMessage,
  url: URL,
  auth: AuthContext,
): Promise<JsonResultWithHeaders | null> {
  const method = request.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean);
  const path = url.pathname;
  // Session mutations require CSRF. Service tokens are trusted automation.
  if (auth.kind === 'user' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const supplied = String(request.headers['x-csrf-token'] ?? '');
    if (!auth.csrfToken || supplied !== auth.csrfToken) return denied();
  }
  if (path.startsWith('/api/admin/')) {
    return auth.role === 'admin' ? null : denied();
  }
  if (path.startsWith('/api/model-configs')) {
    return auth.role === 'admin' ? null : denied();
  }
  if (path.startsWith('/api/auth/')) {
    return null;
  }
  if (path === '/api/approvals' && method === 'GET') {
    return roleRank(auth.role) >= 2 ? null : denied();
  }
  if (parts[1] === 'approvals' && method === 'POST') {
    if (roleRank(auth.role) < 2) return denied();
    if (parts.length === 4 && parts[3] === 'decide') {
      const approval = await getApproval(String(parts[2]));
      if (!approval) return { status: 404, body: { error: 'approval not found' } };
      if (approval.type === 'scope_upgrade' && auth.role !== 'admin') return denied();
    }
    return null;
  }
  if (parts[1] === 'missions' && parts.length === 4 && parts[3] === 'scope-upgrade' && method === 'POST') {
    return auth.role === 'admin' ? null : denied();
  }
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }
  // Mutations not covered above are operator-level.
  return roleRank(auth.role) >= 2 ? null : denied();
}
