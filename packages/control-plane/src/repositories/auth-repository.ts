import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PoolClient } from 'pg';
import { getPool } from '../db';

const scrypt = promisify(scryptCallback) as
  (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.AUTH_SESSION_TTL_SECONDS || 7 * 24 * 3600) * 1_000);
const MAX_FAILED_ATTEMPTS = Math.max(3, Number(process.env.AUTH_MAX_FAILED_ATTEMPTS || 5));
const LOCK_MS = Math.max(60_000, Number(process.env.AUTH_LOCK_SECONDS || 900) * 1_000);

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
}

export interface SessionAuth {
  user: AuthUser;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** scrypt$N$r$p$saltB64$hashB64; no plaintext is ever stored. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rowToUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    role: String(row.role) as UserRole,
    status: String(row.status) as 'active' | 'disabled',
    mustChangePassword: Boolean(row.must_change_password),
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  mustChangePassword?: boolean;
}

export async function countUsers(): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM users`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function findUserForLogin(username: string): Promise<{
  user: AuthUser;
  passwordHash: string;
  lockedUntil: string | null;
  failedAttempts: number;
} | null> {
  const result = await getPool().query(
    `SELECT id, username, password_hash, role, status, must_change_password, locked_until, failed_attempts
     FROM users WHERE lower(username) = lower($1) LIMIT 1`,
    [username],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    user: rowToUser(row),
    passwordHash: String(row.password_hash),
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null,
    failedAttempts: Number(row.failed_attempts ?? 0),
  };
}

export async function recordLoginFailure(userId: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE users
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3::int * interval '1 millisecond') ELSE locked_until END,
         updated_at = now()
     WHERE id = $1
     RETURNING failed_attempts`,
    [userId, MAX_FAILED_ATTEMPTS, LOCK_MS],
  );
  void result;
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1`,
    [userId],
  );
}

export async function hasAnyUsers(): Promise<boolean> {
  return (await countUsers()) > 0;
}

export async function createUser(input: CreateUserInput): Promise<AuthUser> {
  const passwordHash = await hashPassword(input.password);
  const result = await getPool().query(
    `INSERT INTO users (username, password_hash, role, must_change_password)
     VALUES ($1,$2,$3,$4)
     RETURNING id, username, role, status, must_change_password`,
    [input.username.trim(), passwordHash, input.role, input.mustChangePassword ?? false],
  );
  return rowToUser(result.rows[0]);
}

export async function createSession(
  userId: string,
  userAgent: string | undefined,
  ip: string | undefined,
): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await getPool().query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, hashToken(token), csrfToken, expiresAt, userAgent?.slice(0, 500) ?? null, ip ?? null],
  );
  return { token, csrfToken, expiresAt };
}

export async function findSessionAuth(token: string): Promise<{ user: AuthUser; csrfToken: string; expiresAt: string } | null> {
  if (!token) return null;
  const result = await getPool().query(
    `SELECT u.id, u.username, u.role, u.status, u.must_change_password, s.csrf_token, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active' LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await getPool().query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [hashToken(token)]).catch(() => undefined);
  return {
    user: rowToUser(row),
    csrfToken: String(row.csrf_token),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function findSessionUser(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  const result = await getPool().query(
    `SELECT u.id, u.username, u.role, u.status, u.must_change_password, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active' LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await getPool().query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [hashToken(token)]).catch(() => undefined);
  return rowToUser(row);
}

export async function sessionCsrfMatches(token: string, csrfToken: string): Promise<boolean> {
  if (!token || !csrfToken) return false;
  const result = await getPool().query(
    `SELECT 1 FROM sessions WHERE token_hash = $1 AND csrf_token = $2 AND expires_at > now() LIMIT 1`,
    [hashToken(token), csrfToken],
  );
  return result.rowCount === 1;
}

export async function deleteSession(token: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

export async function changeOwnPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await getPool().query(
    `UPDATE users SET password_hash = $2, must_change_password = false, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [userId, hash],
  );
  await revokeUserSessions(userId);
}

/**
 * Single-user deployment: seed one admin account on first start. The password
 * is intentionally the documented bootstrap password and `must_change_password`
 * is set, so the first login must replace it with a compliant password.
 * Existing deployments are never touched (no users => seed only).
 */
export const DEFAULT_ADMIN_USERNAME = (process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim();
export const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

export async function ensureDefaultAdmin(): Promise<{ created: boolean; username: string }> {
  if (await hasAnyUsers()) return { created: false, username: DEFAULT_ADMIN_USERNAME };
  await createUser({
    username: DEFAULT_ADMIN_USERNAME,
    password: DEFAULT_ADMIN_PASSWORD,
    role: 'admin',
    mustChangePassword: true,
  });
  return { created: true, username: DEFAULT_ADMIN_USERNAME };
}

export async function recordAdminAudit(input: {
  actorUserId?: string | null;
  actorName: string;
  action: string;
  targetType: string;
  targetIdHash?: string | null;
  detail?: Record<string, unknown>;
}, client?: PoolClient): Promise<void> {
  const db = client ?? getPool();
  await db.query(
    `INSERT INTO admin_audit (actor_user_id, actor_name, action, target_type, target_id_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.actorUserId ?? null, input.actorName, input.action, input.targetType, input.targetIdHash ?? null, JSON.stringify(input.detail ?? {})],
  );
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const AUTH_SESSION_COOKIE = 'src_agent_session';
export const AUTH_SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
