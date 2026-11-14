// Standalone SRC-Agent HTTP API (P2 extraction).
// Paths, payloads and error envelopes are the frozen v1 contract in
// docs/api/frontend-api.md. All /api routes except /api/health require a
// Bearer token when API_AUTH_TOKEN is configured.
import http from 'node:http';
import { z } from 'zod';
import {
  CreateApprovalSchema,
  CreateHintSchema,
  CreateManualTaskSchema,
  CreateMissionSchema,
  DecideApprovalSchema,
  ScopeUpgradeRequestSchema,
  createApproval,
  createHint,
  createMission,
  decideApproval,
  getFinding,
  getFindingLineage,
  getMetrics,
  getMission,
  listArtifacts,
  getMissionBoard,
  getMissionTraceSummary,
  getMissionFrontier,
  getMissionIntel,
  getMissionExploreGraph,
  getMissionOverview,
  searchMissionWorkerTraces,
  getMissionAssetGraph,
  getMissionSummary,
  EvalRunInputSchema,
  recordEvalRun,
  listEvalRuns,
  listLatestEvalRuns,
  getEvalRun,
  listRecentMissionIds,
  getModelConfig,
  listModelConfigs,
  listModelConfigAudit,
  createModelConfig,
  updateModelConfig as updateModelConfigRecord,
  deleteModelConfig,
  revealModelConfig,
  ModelConfigWriteSchema,
  ModelConfigUpdateSchema,
  listMissionFacts,
  recallMissionFacts,
  listApprovals,
  listFindings,
  listHints,
  listMissions,
  listTrace,
  listTriggers,
  pauseMission,
  replayMission,
  requestScopeUpgrade,
  resumeMission,
  applySchema,
  ensureDefaultAdmin,
  getPool,
  findUserForLogin,
  verifyPassword,
  recordLoginFailure,
  recordLoginSuccess,
  createSession,
  deleteSession,
  changeOwnPassword,
  recordAdminAudit,
  createManualTask,
  cancelTask,
  confirmTaskRetry,
  listTaskActions,
  listMissionActions,
  listSteering,
  findCommandReview,
  requestCommandReview,
  hashIdentifier,
  getRuntimeSettings,
  updateRuntimeSettings,
  deleteMissionCascade,
  getWatchdogDashboard,
  cancelMissionTasksForDeletion,
  getMissionNameForDeletion,
  listAdminAudit,
} from '@src-agent/control-plane';
import { handleModelProxy } from './model-proxy.js';
import { handleArtifactUpload } from './artifact-upload.js';
import { handleMissionMultipart } from './mission-multipart.js';
import { ModelConfigTestSchema, testModelConfig } from './model-config-test.js';
import { gcArtifacts, removeMissionArtifacts } from './artifact-cleanup.js';
import { handleToolsProxy } from './tools-proxy.js';
import { authenticateRequest, authorizeRoute, clearSessionCookie, isPublicPath, passwordChangeRequired, sessionCookie, AUTH_MODE, type AuthContext } from './auth.js';
import { PASSWORD_MAX_LENGTH, passwordPolicyMessage, passwordViolations } from './password-policy.js';

const PORT = Number(process.env.API_PORT || 3001);
const AUTH_TOKEN = process.env.API_AUTH_TOKEN?.trim() || '';
// P3-B2: optional separate admin token for model-config management/reveal.
// When unset, the normal API token also acts as admin (dev-only fallback).
const ADMIN_TOKEN = process.env.API_ADMIN_TOKEN?.trim() || '';
// Read-only token used by Worker mission tools. It can read mission/trace
// projections but can never decide approvals or reveal model configuration.
const READ_TOKEN = process.env.API_READ_TOKEN?.trim() || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(item => item.trim()).filter(Boolean);
const MAX_BODY_BYTES = 1024 * 1024;
// Internal command-review endpoint is called by the executor's command guard.
// The plugin already holds this model-proxy token; it is not exposed to the UI.
const MODEL_PROXY_TOKEN = process.env.MODEL_PROXY_TOKEN?.trim() || '';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LoginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(500),
}).strict();
const PasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
}).strict()
  .superRefine((value, context) => {
    // Server is authoritative; the SPA mirrors these rules only for inline hints.
    for (const violation of passwordViolations(value.newPassword)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: violation.message, path: ['newPassword'] });
    }
    if (value.newPassword === value.currentPassword) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '新密码不能与当前密码相同', path: ['newPassword'] });
    }
  });
const DeleteMissionSchema = z.object({
  confirmName: z.string().min(1).max(200),
}).strict();
const SettingsPatchSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  values: z.record(z.string(), z.unknown()),
}).strict();

function publicUser(user: { id: string; username: string; role: string; status: string; mustChangePassword: boolean }) {
  return { id: user.id, username: user.username, role: user.role, status: user.status, mustChangePassword: user.mustChangePassword };
}

/** Returns fallback when the parameter is absent; null when it is present but invalid. */
function parseBoundedInt(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

interface JsonResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function json(status: number, body: unknown): JsonResult {
  return { status, body };
}
function validationError(error: { issues: unknown }): JsonResult {
  return json(400, { error: 'validation failed', issues: error.issues });
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function routeParts(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !CORS_ORIGINS.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-actor,x-csrf-token,x-setup-token',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function bearerToken(request: http.IncomingMessage): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}


/** Model-config management requires the admin token (fallback = regular token). */
// Admin surface is reachable through the automation bearer AND through an
// `accounts` session whose user has the admin role (ADR-0038). Bearer-only
// checking made the approvals/model-config pages 403 for a logged-in admin.
function isAdmin(request: http.IncomingMessage, auth: AuthContext | null): boolean {
  if (auth?.role === 'admin') return true;
  const adminToken = ADMIN_TOKEN || AUTH_TOKEN;
  if (!adminToken) return true; // dev mode
  return bearerToken(request) === adminToken;
}

function adminDenied(request: http.IncomingMessage, auth: AuthContext | null): JsonResult | null {
  return isAdmin(request, auth) ? null : json(403, { error: 'admin token required for model configuration' });
}

function actorOf(request: http.IncomingMessage): string {
  const raw = request.headers['x-actor'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim().slice(0, 120) || 'api-admin';
}

function configUpdateBody(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  if (copy.apiKey === '' || copy.apiKey === null) delete copy.apiKey;
  return copy;
}

function missionScopeUpgrade(missionId: string, body: unknown): Promise<JsonResult> {
  const parsed = ScopeUpgradeRequestSchema.safeParse(body);
  if (!parsed.success) return Promise.resolve(validationError(parsed.error));
  return requestScopeUpgrade(missionId, parsed.data)
    .then(result => json(201, result))
    .catch(error => json(/not found/.test(String(error)) ? 404 : 400, { error: String(error) }));
}

async function handleRoute(request: http.IncomingMessage, url: URL, auth: AuthContext | null): Promise<JsonResult> {
  const parts = routeParts(url.pathname);
  const method = request.method ?? 'GET';
  // ── /api/admin (admin-only; also guarded centrally) ───────
  if (parts[1] === 'admin') {
    if (parts.length === 4 && parts[2] === 'artifacts' && parts[3] === 'gc' && method === 'POST') {
      const body = await readJson(request).catch(() => ({})) as { days?: unknown };
      return json(200, await gcArtifacts(typeof body.days === 'number' ? body.days : undefined));
    }
    // /api/admin/watchdog — watchdog dashboard (ADR-0039)
    if (parts.length === 3 && parts[2] === 'watchdog' && method === 'GET') {
      const days = parseBoundedInt(url.searchParams.get('days'), 7, 1, 90);
      const limit = parseBoundedInt(url.searchParams.get('limit'), 50, 1, 200);
      if (days === null || limit === null) return json(400, { error: 'days/limit must be integers' });
      return json(200, { watchdog: await getWatchdogDashboard(days, limit) });
    }
    if (parts.length === 3 && parts[2] === 'audit' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 100, 1, 500);
      if (limit === null) return json(400, { error: 'limit must be an integer' });
      const audit = await listAdminAudit(limit);
      return json(200, { audit, total: audit.length });
    }
    if (parts.length === 3 && parts[2] === 'settings' && method === 'GET') {
      return json(200, { settings: await getRuntimeSettings() });
    }
    if (parts.length === 3 && parts[2] === 'settings' && method === 'PATCH') {
      const parsed = SettingsPatchSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      const current = await getRuntimeSettings();
      if (parsed.data.expectedVersion !== undefined && parsed.data.expectedVersion !== current.version) {
        return json(409, { error: 'settings version changed; reload before saving' });
      }
      try {
        const settings = await updateRuntimeSettings(parsed.data.values, { actorUserId: auth?.userId ?? null, actorName: auth?.actor ?? 'admin' });
        return json(200, { settings });
      } catch (error) {
        return json(400, { error: String(error) });
      }
    }
    if (parts.length === 4 && parts[2] === 'missions' && method === 'DELETE') {
      const id = parts[3]!;
      if (!UUID_PATTERN.test(id)) return json(400, { error: 'id must be a UUID' });
      const parsed = DeleteMissionSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      try {
        // Validate the confirmation before touching state: a typo must not
        // cancel a running mission's tasks.
        const name = await getMissionNameForDeletion(id);
        if (name === null) return json(404, { error: 'mission not found' });
        if (name !== parsed.data.confirmName) {
          return json(400, { error: 'mission name confirmation does not match' });
        }
        // Let the worker observe the cancellation and abort its executor job
        // before the cascade removes the task rows (see ADR-0037).
        if ((await cancelMissionTasksForDeletion(id)) > 0) {
          await new Promise(resolve => setTimeout(resolve, 4_000));
        }
        const deleted = await deleteMissionCascade(id, parsed.data.confirmName);
        await removeMissionArtifacts(id).catch(error => console.error('[api] artifact cleanup failed', String(error)));
        await recordAdminAudit({ actorUserId: auth?.userId ?? null, actorName: auth?.actor ?? 'admin', action: 'mission.delete', targetType: 'mission', targetIdHash: hashIdentifier(id), detail: { nameHash: hashIdentifier(deleted.name), counts: deleted.counts } });
        const executorUrl = process.env.SRC_AGENT_EXECUTOR_URL?.trim();
        if (executorUrl && deleted.taskIds.length > 0) {
          await fetch(`${executorUrl}/internal/cleanup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(process.env.EXECUTOR_TOKEN ? { 'x-executor-token': process.env.EXECUTOR_TOKEN } : {}) },
            body: JSON.stringify({ taskIds: deleted.taskIds }),
            signal: AbortSignal.timeout(5_000),
          }).catch(() => undefined);
        }
        return json(200, { deleted: { ...deleted, taskIds: undefined } });
      } catch (error) {
        const message = String(error);
        return json(/not found/.test(message) ? 404 : /confirmation/.test(message) ? 400 : 409, { error: message });
      }
    }
    return json(404, { error: 'not found' });
  }
  // ── /api/auth ─────────────────────────────────────────────
  if (parts[1] === 'auth') {
    if (parts.length === 3 && parts[2] === 'login' && method === 'POST') {
      const parsed = LoginSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      const found = await findUserForLogin(parsed.data.username);
      if (!found || found.user.status !== 'active') return json(401, { error: 'invalid credentials' });
      if (found.lockedUntil && new Date(found.lockedUntil).getTime() > Date.now()) {
        return json(429, { error: 'account temporarily locked' });
      }
      if (!(await verifyPassword(parsed.data.password, found.passwordHash))) {
        await recordLoginFailure(found.user.id);
        return json(401, { error: 'invalid credentials' });
      }
      await recordLoginSuccess(found.user.id);
      const session = await createSession(found.user.id, String(request.headers['user-agent'] ?? ''), request.socket.remoteAddress ?? undefined);
      return {
        status: 200,
        body: { user: publicUser(found.user), csrfToken: session.csrfToken, expiresAt: session.expiresAt },
        headers: { 'set-cookie': sessionCookie(session.token) },
      };
    }
    if (parts.length === 3 && parts[2] === 'me' && method === 'GET') {
      if (!auth) return json(401, { error: 'unauthorized' });
      return json(200, {
        user: {
          id: auth.userId,
          username: auth.actor,
          role: auth.role,
          mustChangePassword: auth.mustChangePassword,
        },
        authKind: auth.kind,
        csrfToken: auth.csrfToken,
        authMode: AUTH_MODE,
      });
    }
    if (parts.length === 3 && parts[2] === 'logout' && method === 'POST') {
      if (auth?.sessionToken) await deleteSession(auth.sessionToken);
      return { status: 200, body: { ok: true }, headers: { 'set-cookie': clearSessionCookie() } };
    }
    if (parts.length === 3 && parts[2] === 'password' && method === 'POST') {
      if (!auth || auth.kind !== 'user' || !auth.userId) return json(403, { error: 'user session required' });
      const parsed = PasswordSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      const found = await findUserForLogin(auth.actor);
      if (!found || !(await verifyPassword(parsed.data.currentPassword, found.passwordHash))) {
        // First login still carries the bootstrap password; say so instead of
        // leaving the operator to guess what "current password" means.
        const message = auth.mustChangePassword
          ? '当前密码不正确：首次登录的当前密码仍是初始密码（默认 admin123），新密码才是你要设置的那个'
          : '当前密码不正确';
        return json(400, { error: message, field: 'currentPassword' });
      }
      await changeOwnPassword(found.user.id, parsed.data.newPassword);
      await recordAdminAudit({ actorUserId: auth.userId, actorName: auth.actor, action: 'auth.password_changed', targetType: 'user', targetIdHash: hashIdentifier(found.user.id), detail: {} });
      // The change revokes every session; issue a fresh one so the operator
      // lands inside the console instead of being bounced to the login form.
      const session = await createSession(found.user.id, String(request.headers['user-agent'] ?? ''), request.socket.remoteAddress ?? undefined);
      return {
        status: 200,
        body: { ok: true, user: publicUser({ ...found.user, mustChangePassword: false }), csrfToken: session.csrfToken },
        headers: { 'set-cookie': sessionCookie(session.token) },
      };
    }
    return json(404, { error: 'not found' });
  }
  // ── /api/evals (P3-A6 structured eval history + dashboard) ──
  if (parts.length >= 2 && parts[1] === 'evals') {
    if (parts.length === 3 && parts[2] === 'dashboard' && method === 'GET') {
      const historyLimit = parseBoundedInt(url.searchParams.get('limit'), 5, 1, 20);
      const replayLimit = parseBoundedInt(url.searchParams.get('replayLimit'), 5, 1, 10);
      if (historyLimit === null || replayLimit === null) return json(400, { error: 'limit/replayLimit must be valid integers' });
      const [latest, metrics, missionIds] = await Promise.all([
        listLatestEvalRuns(),
        getMetrics(),
        listRecentMissionIds(replayLimit),
      ]);
      const items = [];
      for (const missionId of missionIds) {
        const replay = await replayMission(missionId).catch(() => null);
        if (replay) items.push(replay);
      }
      return json(200, {
        evals: latest,
        metrics,
        replay: {
          checked: items.length,
          matched: items.filter(item => item.matchesCurrent).length,
          mismatched: items.filter(item => !item.matchesCurrent).length,
          items,
        },
        generatedAt: new Date().toISOString(),
      });
    }
    if (parts.length === 2) {
      if (method === 'GET') {
        const kind = url.searchParams.get('kind') ?? undefined;
        const limit = parseBoundedInt(url.searchParams.get('limit'), 20, 1, 100);
        if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 100' });
        const evals = await listEvalRuns({ kind, limit });
        return json(200, { evals, total: evals.length });
      }
      if (method === 'POST') {
        const parsed = EvalRunInputSchema.safeParse(await readJson(request));
        if (!parsed.success) return validationError(parsed.error);
        const evalRun = await recordEvalRun(parsed.data);
        return json(201, { eval: evalRun });
      }
      return json(405, { error: 'method not allowed' });
    }
    if (parts.length === 3 && method === 'GET') {
      const id = parts[2]!;
      if (!UUID_PATTERN.test(id)) return json(400, { error: 'id must be a UUID' });
      const evalRun = await getEvalRun(id);
      return evalRun ? json(200, { eval: evalRun }) : json(404, { error: 'eval run not found' });
    }
    return json(405, { error: 'method not allowed' });
  }
  // ── /api/model-configs (P3-B2, admin token; keys are plaintext + audited) ──
  if (parts.length >= 2 && parts[1] === 'model-configs') {
    const denied = adminDenied(request, auth);
    if (denied) return denied;
    // /api/model-configs/audit
    if (parts.length === 3 && parts[2] === 'audit' && method === 'GET') {
      const audit = await listModelConfigAudit(200);
      return json(200, { audit, total: audit.length });
    }
    // /api/model-configs
    if (parts.length === 2) {
      if (method === 'GET') {
        const configs = await listModelConfigs();
        return json(200, { configs, total: configs.length });
      }
      if (method === 'POST') {
        const parsed = ModelConfigWriteSchema.safeParse(await readJson(request));
        if (!parsed.success) return validationError(parsed.error);
        try {
          const config = await createModelConfig(parsed.data, actorOf(request));
          return json(201, { config });
        } catch (error) {
          const message = String(error);
          return json(/duplicate key/.test(message) ? 409 : 400, { error: message });
        }
      }
      return json(405, { error: 'method not allowed' });
    }
    // /api/model-configs/test (ad-hoc draft) and /:id/test (stored config)
    if (parts.length === 3 && parts[2] === 'test' && method === 'POST') {
      const parsed = ModelConfigTestSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      try {
        return json(200, await testModelConfig(parsed.data));
      } catch (error) {
        return json(/not found/.test(String(error)) ? 404 : 400, { error: String(error) });
      }
    }
    if (parts.length === 4 && parts[3] === 'test' && method === 'POST') {
      const id = parts[2]!;
      if (!UUID_PATTERN.test(id)) return json(400, { error: 'id must be a UUID' });
      const body = await readJson(request).catch(() => ({}));
      const parsed = ModelConfigTestSchema.safeParse({ ...(body as Record<string, unknown>), id });
      if (!parsed.success) return validationError(parsed.error);
      try {
        return json(200, await testModelConfig(parsed.data));
      } catch (error) {
        return json(/not found/.test(String(error)) ? 404 : 400, { error: String(error) });
      }
    }
    // /api/model-configs/:id/reveal
    if (parts.length === 4 && parts[3] === 'reveal' && method === 'POST') {
      const id = parts[2]!;
      if (!UUID_PATTERN.test(id)) return json(400, { error: 'id must be a UUID' });
      const config = await revealModelConfig(id, actorOf(request));
      return config ? json(200, { config }) : json(404, { error: 'model config not found' });
    }
    // /api/model-configs/:id
    if (parts.length === 3) {
      const id = parts[2]!;
      if (!UUID_PATTERN.test(id)) return json(400, { error: 'id must be a UUID' });
      if (method === 'GET') {
        const config = await getModelConfig(id);
        return config ? json(200, { config }) : json(404, { error: 'model config not found' });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const parsed = ModelConfigUpdateSchema.safeParse(configUpdateBody(await readJson(request)));
        if (!parsed.success) return validationError(parsed.error);
        try {
          const config = await updateModelConfigRecord(id, parsed.data, actorOf(request));
          return config ? json(200, { config }) : json(404, { error: 'model config not found' });
        } catch (error) {
          const message = String(error);
          return json(/duplicate key/.test(message) ? 409 : 400, { error: message });
        }
      }
      if (method === 'DELETE') {
        const deleted = await deleteModelConfig(id, actorOf(request));
        return deleted ? json(200, { deleted: true }) : json(404, { error: 'model config not found' });
      }
      return json(405, { error: 'method not allowed' });
    }
    return json(404, { error: 'not found' });
  }
  // /api/health
  if (method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'health') {
    return json(200, { ok: true, service: 'src-agent-api', egressMode: (process.env.EGRESS_MODE || 'scope').toLowerCase() });
  }
  // /api/metrics
  if (method === 'GET' && parts.length === 2 && parts[1] === 'metrics') {
    return json(200, { metrics: await getMetrics() });
  }
  // /api/missions
  if (parts.length === 2 && parts[1] === 'missions') {
    if (method === 'GET') {
      const missions = await listMissions();
      return json(200, { missions, total: missions.length });
    }
    if (method === 'POST') {
      const raw = await readJson(request) as Record<string, unknown>;
      if (raw?.targetMode === 'attachment') return json(400, { error: 'targetMode=attachment requires multipart/form-data with at least one artifact' });
      const parsed = CreateMissionSchema.safeParse(raw);
      if (!parsed.success) return validationError(parsed.error);
      try {
        return json(201, await createMission(parsed.data));
      } catch (error) {
        const message = String(error);
        return json(/target must use the real target host/.test(message) ? 400 : 503, { error: message });
      }
    }
    return json(405, { error: 'method not allowed' });
  }
  // /api/missions/:id...
  if (parts.length >= 3 && parts[1] === 'missions') {
    const missionId = parts[2]!;
    if (parts.length === 3 && method === 'GET') {
      const mission = await getMission(missionId);
      return mission ? json(200, { mission }) : json(404, { error: 'mission not found' });
    }
    if (parts.length === 4 && parts[3] === 'artifacts' && method === 'GET') {
      const artifacts = await listArtifacts(undefined, missionId);
      return json(200, { artifacts });
    }
    // P1 1.7: manual spawn/cancel/retry-confirmation (operator mutations).
    if (parts.length === 4 && parts[3] === 'tasks' && method === 'POST') {
      const parsed = CreateManualTaskSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      const actor = auth?.actor ?? 'unknown';
      try {
        return json(201, await createManualTask(missionId, parsed.data, actor));
      } catch (error) {
        return json(/not found/.test(String(error)) ? 404 : 409, { error: String(error) });
      }
    }
    if (parts.length === 6 && parts[3] === 'tasks' && parts[5] === 'cancel' && method === 'POST') {
      const taskId = parts[4]!;
      if (!UUID_PATTERN.test(taskId)) return json(400, { error: 'taskId must be a UUID' });
      const body = await readJson(request).catch(() => ({})) as { reason?: unknown };
      const actor = auth?.actor ?? 'unknown';
      try {
        return json(200, await cancelTask(missionId, taskId, actor,
          typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined));
      } catch (error) {
        return json(/not found/.test(String(error)) ? 404 : 409, { error: String(error) });
      }
    }
    if (parts.length === 6 && parts[3] === 'tasks' && parts[5] === 'confirm-retry' && method === 'POST') {
      const taskId = parts[4]!;
      if (!UUID_PATTERN.test(taskId)) return json(400, { error: 'taskId must be a UUID' });
      const actor = auth?.actor ?? 'unknown';
      try {
        return json(200, await confirmTaskRetry(missionId, taskId, actor));
      } catch (error) {
        return json(/not found/.test(String(error)) ? 404 : 409, { error: String(error) });
      }
    }
    if (parts.length === 6 && parts[3] === 'tasks' && parts[5] === 'actions' && method === 'GET') {
      const taskId = parts[4]!;
      if (!UUID_PATTERN.test(taskId)) return json(400, { error: 'taskId must be a UUID' });
      const limit = parseBoundedInt(url.searchParams.get('limit'), 50, 1, 200);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 200' });
      const actions = await listTaskActions(undefined, missionId, taskId, limit);
      return json(200, { actions, total: actions.length });
    }
    if (parts.length === 4 && parts[3] === 'steering' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 100, 1, 200);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 200' });
      const commands = await listSteering(missionId, limit);
      return json(200, { commands, total: commands.length });
    }
    if (parts.length === 4 && parts[3] === 'action-ledger' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 100, 1, 200);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 200' });
      const actions = await listMissionActions(undefined, missionId, limit);
      return json(200, { actions, total: actions.length });
    }
    if (parts.length === 4 && parts[3] === 'pause' && method === 'POST') {
      try { return json(200, { mission: await pauseMission(missionId) }); }
      catch (error) { return json(/not found/.test(String(error)) ? 404 : 409, { error: String(error) }); }
    }
    if (parts.length === 4 && parts[3] === 'resume' && method === 'POST') {
      try { return json(200, { mission: await resumeMission(missionId) }); }
      catch (error) { return json(/not found/.test(String(error)) ? 404 : 409, { error: String(error) }); }
    }
    if (parts.length === 4 && parts[3] === 'scope-upgrade' && method === 'POST') {
      return missionScopeUpgrade(missionId, await readJson(request));
    }
    if (parts.length === 4 && parts[3] === 'board' && method === 'GET') {
      const board = await getMissionBoard(missionId);
      return board ? json(200, { board }) : json(404, { error: 'mission not found' });
    }
    if (parts.length === 4 && parts[3] === 'replay' && method === 'GET') {
      const raw = url.searchParams.get('toSeq');
      const toSeq = raw === null ? undefined : Number(raw);
      if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 0)) return json(400, { error: 'toSeq must be a non-negative integer' });
      const replay = await replayMission(missionId, toSeq);
      return replay ? json(200, { replay }) : json(404, { error: 'mission not found' });
    }
    // /api/missions/:id/trace-summaries — P3-A1 prior-work projection.
    if (parts.length === 4 && parts[3] === 'trace-summaries' && method === 'GET') {
      const excludeTaskId = url.searchParams.get('excludeTaskId') ?? undefined;
      if (excludeTaskId !== undefined && !UUID_PATTERN.test(excludeTaskId)) {
        return json(400, { error: 'excludeTaskId must be a UUID' });
      }
      const summary = await getMissionTraceSummary(undefined, missionId, { excludeTaskId });
      return summary ? json(200, { summary }) : json(404, { error: 'mission not found' });
    }
    // M5-1 project overview (Planner/Worker/console shared read model).
    if (parts.length === 4 && parts[3] === 'overview' && method === 'GET') {
      const maxChars = parseBoundedInt(url.searchParams.get('maxChars'), 8_000, 500, 50_000);
      if (maxChars === null) return json(400, { error: 'maxChars must be an integer between 500 and 50000' });
      const overview = await getMissionOverview(undefined, missionId, { maxChars });
      return overview ? json(200, { overview }) : json(404, { error: 'mission not found' });
    }
    // M5-5 project asset graph + coverage (same mission only).
    if (parts.length === 4 && parts[3] === 'summary' && method === 'GET') {
      const summary = await getMissionSummary(undefined, String(parts[2]));
      if (!summary) {
        const mission = await getMission(String(parts[2]));
        return mission ? json(200, { summary: null }) : json(404, { error: 'mission not found' });
      }
      return json(200, { summary });
    }
    if (parts.length === 5 && parts[3] === 'assets' && parts[4] === 'graph' && method === 'GET') {
      const graph = await getMissionAssetGraph(undefined, missionId);
      return graph ? json(200, { graph }) : json(404, { error: 'mission not found' });
    }
    // M5-4 cross-worker trace search (same mission, summaries only).
    if (parts.length === 5 && parts[3] === 'worker-traces' && parts[4] === 'search' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 20, 1, 20);
      if (limit === null) return json(400, { error: 'limit must be between 1 and 20' });
      const result = await searchMissionWorkerTraces(undefined, missionId, {
        q: url.searchParams.get('q') ?? '',
        ...(url.searchParams.get('excludeTaskId') ? { excludeTaskId: url.searchParams.get('excludeTaskId')! } : {}),
        limit,
      });
      return result ? json(200, { search: result }) : json(404, { error: 'mission not found' });
    }
    // P3-B3 same-mission intel (read-only; no cross-mission path).
    if (parts.length === 4 && parts[3] === 'intel' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 100, 1, 200);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 200' });
      const intel = await getMissionIntel(undefined, missionId, limit);
      return intel ? json(200, { intel }) : json(404, { error: 'mission not found' });
    }
    // P3-A3 explore graph read projection + digest folding.
    if (parts.length === 4 && parts[3] === 'explore-graph' && method === 'GET') {
      const threshold = parseBoundedInt(url.searchParams.get('threshold'), 150, 10, 500);
      if (threshold === null) return json(400, { error: 'threshold must be an integer between 10 and 500' });
      const graph = await getMissionExploreGraph(undefined, missionId, { threshold });
      return graph ? json(200, { graph }) : json(404, { error: 'mission not found' });
    }
    // P3-B1 typed blackboard read model (derived views; credential values are
    // plaintext per ADR-0010 and marked sensitive=true for console masking).
    if (parts.length === 4 && parts[3] === 'facts' && method === 'GET') {
      const limit = parseBoundedInt(url.searchParams.get('limit'), 200, 1, 500);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 500' });
      const facts = await listMissionFacts(undefined, missionId, {
        kind: url.searchParams.get('kind') ?? undefined,
        trust: url.searchParams.get('trust') ?? undefined,
        limit,
      });
      return facts ? json(200, facts) : json(404, { error: 'mission not found' });
    }
    if (parts.length === 4 && parts[3] === 'frontier' && method === 'GET') {
      const factLimit = parseBoundedInt(url.searchParams.get('factLimit'), 30, 1, 100);
      const intentLimit = parseBoundedInt(url.searchParams.get('intentLimit'), 30, 1, 100);
      if (factLimit === null || intentLimit === null) {
        return json(400, { error: 'factLimit/intentLimit must be integers between 1 and 100' });
      }
      const frontier = await getMissionFrontier(undefined, missionId, { factLimit, intentLimit });
      return frontier ? json(200, { frontier }) : json(404, { error: 'mission not found' });
    }
    if (parts.length === 4 && parts[3] === 'recall' && method === 'GET') {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!query) return json(400, { error: 'q is required' });
      if (query.length > 200) return json(400, { error: 'q must be at most 200 characters' });
      const limit = parseBoundedInt(url.searchParams.get('limit'), 50, 1, 100);
      if (limit === null) return json(400, { error: 'limit must be an integer between 1 and 100' });
      const facts = await recallMissionFacts(undefined, missionId, query, {
        kind: url.searchParams.get('kind') ?? undefined,
        limit,
      });
      return facts ? json(200, facts) : json(404, { error: 'mission not found' });
    }
    return json(404, { error: 'not found' });
  }
  // /api/findings
  if (parts.length === 2 && parts[1] === 'findings' && method === 'GET') {
    const missionId = url.searchParams.get('missionId') ?? undefined;
    if (missionId && !UUID_PATTERN.test(missionId)) return json(400, { error: 'missionId must be a UUID' });
    const limitRaw = Number(url.searchParams.get('limit') ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 100;
    const findings = await listFindings(limit, missionId);
    return json(200, { findings, total: findings.length });
  }
  if (parts.length === 3 && parts[1] === 'findings' && method === 'GET') {
    const finding = await getFinding(parts[2]!);
    return finding ? json(200, { finding }) : json(404, { error: 'finding not found' });
  }
  if (parts.length === 4 && parts[1] === 'findings' && parts[3] === 'lineage' && method === 'GET') {
    if (!UUID_PATTERN.test(parts[2]!)) return json(400, { error: 'id must be a UUID' });
    const lineage = await getFindingLineage(parts[2]!);
    return lineage ? json(200, { lineage }) : json(404, { error: 'finding not found' });
  }
  // /api/approvals
  if (parts[1] === 'approvals') {
    const denied = adminDenied(request, auth);
    if (denied) return denied;
  }
  if (parts.length === 2 && parts[1] === 'approvals') {
    if (method === 'GET') {
      const approvals = await listApprovals(100, url.searchParams.get('status') ?? undefined);
      return json(200, { approvals, total: approvals.length });
    }
    if (method === 'POST') {
      const parsed = CreateApprovalSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      return json(201, await createApproval(parsed.data));
    }
    return json(405, { error: 'method not allowed' });
  }
  if (parts.length === 4 && parts[1] === 'approvals' && parts[3] === 'decide' && method === 'POST') {
    const parsed = DecideApprovalSchema.safeParse(await readJson(request));
    if (!parsed.success) return validationError(parsed.error);
    try { return json(200, { approval: await decideApproval(parts[2]!, parsed.data) }); }
    catch (error) { return json(409, { error: String(error) }); }
  }
  // /api/hints
  if (parts.length === 2 && parts[1] === 'hints') {
    if (method === 'GET') {
      const missionId = url.searchParams.get('missionId');
      if (!missionId) return json(400, { error: 'missionId is required' });
      const hints = await listHints(missionId);
      return json(200, { hints, total: hints.length });
    }
    if (method === 'POST') {
      const parsed = CreateHintSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      return json(201, await createHint(parsed.data));
    }
    return json(405, { error: 'method not allowed' });
  }
  // /api/triggers
  if (parts.length === 2 && parts[1] === 'triggers' && method === 'GET') {
    const missionId = url.searchParams.get('missionId');
    if (!missionId) return json(400, { error: 'missionId is required' });
    const triggers = await listTriggers(missionId);
    return json(200, { triggers, total: triggers.length });
  }
  // /api/traces
  if (parts.length === 2 && parts[1] === 'traces' && method === 'GET') {
    const subjectType = url.searchParams.get('subjectType');
    const subjectId = url.searchParams.get('subjectId');
    if ((subjectType !== 'worker' && subjectType !== 'planner') || !subjectId) {
      return json(400, { error: 'subjectType (worker|planner) and subjectId are required' });
    }
    const trace = await listTrace(subjectType, subjectId);
    return json(200, { trace, total: trace.length });
  }
  return json(404, { error: 'not found' });
}

function internalModelToken(request: http.IncomingMessage): string {
  const header = request.headers['x-model-proxy-token'];
  const raw = Array.isArray(header) ? header[0] : header;
  return (raw ?? bearerToken(request)).trim();
}

const COMMAND_REVIEW_SCHEMA = z.object({
  missionId: z.string().uuid(),
  taskId: z.string().uuid(),
  command: z.string().min(1).max(4_000),
  commandHash: z.string().regex(/^[0-9a-f]{64}$/i),
  reason: z.string().max(500).optional(),
}).strict();

/**
 * Internal command-review fallback. The command guard calls this only when its
 * cheap model could not decide. A human decision is required only in that case;
 * normal ALLOW/BLOCK verdicts never create approvals.
 */
async function handleCommandApproval(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/internal/command-approval') return false;
  if (!MODEL_PROXY_TOKEN || internalModelToken(request) !== MODEL_PROXY_TOKEN) {
    writeJson(response, 401, { error: 'model proxy token required' }, {});
    return true;
  }
  if (request.method === 'POST') {
    let raw: unknown;
    try { raw = await readJson(request); } catch (error) {
      writeJson(response, 400, { error: String(error) }, {});
      return true;
    }
    const parsed = COMMAND_REVIEW_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      writeJson(response, 400, { error: 'invalid command review', issues: parsed.error.issues }, {});
      return true;
    }
    try {
      const approval = await requestCommandReview({
        ...parsed.data,
        reason: parsed.data.reason ?? 'command guard could not obtain a model verdict',
      });
      writeJson(response, 200, { approval }, {});
    } catch (error) {
      writeJson(response, 500, { error: String(error) }, {});
    }
    return true;
  }
  if (request.method === 'GET') {
    const missionId = url.searchParams.get('missionId') ?? '';
    const taskId = url.searchParams.get('taskId') ?? '';
    const commandHash = url.searchParams.get('commandHash') ?? '';
    if (!UUID_PATTERN.test(missionId) || !UUID_PATTERN.test(taskId) || !/^[0-9a-f]{64}$/i.test(commandHash)) {
      writeJson(response, 400, { error: 'missionId, taskId and commandHash are required' }, {});
      return true;
    }
    try {
      const approval = await findCommandReview(missionId, taskId, commandHash);
      writeJson(response, 200, { approval }, {});
    } catch (error) {
      writeJson(response, 500, { error: String(error) }, {});
    }
    return true;
  }
  writeJson(response, 405, { error: 'method not allowed' }, {});
  return true;
}

function writeJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  response.end(payload);
}

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const origin = request.headers.origin;
  const cors = corsHeaders(origin);
  // Internal command-review fallback: only reachable with the executor's token.
  if (await handleCommandApproval(request, response, url)) return;
  // Internal OpenAI-compatible model proxy: executor/Agent only, never public.
  if (await handleToolsProxy(request, response, url)) return;
  if (await handleModelProxy(request, response, url)) return;
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  let auth: AuthContext | null = null;
  if (!isPublicPath(url.pathname)) {
    auth = await authenticateRequest(request, url);
    if (!auth) {
      writeJson(response, 401, { error: 'unauthorized' }, cors);
      return;
    }
    if (passwordChangeRequired(auth, url.pathname)) {
      writeJson(response, 403, { error: 'password_change_required', message: passwordPolicyMessage() }, cors);
      return;
    }
    const denied = await authorizeRoute(request, url, auth);
    if (denied) {
      writeJson(response, denied.status, denied.body, { ...cors, ...denied.headers });
      return;
    }
  }
  try {
    // SSE has its own streaming response path.
    const sseMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/stream$/);
    if (sseMatch && request.method === 'GET') {
      const missionId = sseMatch[1]!;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...cors,
      });
      let closed = false;
      const send = (payload: unknown): void => { if (!closed) response.write(`data: ${JSON.stringify(payload)}\n\n`); };
      const snapshot = async (): Promise<void> => {
        try {
          const mission = await getMission(missionId);
          if (!mission) return send({ type: 'gone', missionId });
          send({
            type: 'mission', missionId, state: mission.state, findings: mission.findingsCount,
            tasks: mission.tasks.length,
            openTasks: mission.tasks.filter(task => !['done', 'cancelled', 'exhausted', 'stale'].includes(task.state)).length,
            triggers: mission.triggers.length,
            pendingApprovals: mission.approvals.filter(approval => approval.status === 'pending').length,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) { send({ type: 'error', error: String(error) }); }
      };
      await snapshot();
      const timer = setInterval(() => { void snapshot(); }, 2_000);
      request.on('close', () => { closed = true; clearInterval(timer); response.end(); });
      return;
    }
    if (await handleArtifactUpload(request, response, url, auth)) return;
    if (await handleMissionMultipart(request, response, auth)) return;
    const result = await handleRoute(request, url, auth);
    writeJson(response, result.status, result.body, { ...cors, ...result.headers });
  } catch (error) {
    writeJson(response, 503, { error: String(error) }, cors);
  } finally {
    console.log(`[api] ${request.method} ${url.pathname} ${Date.now() - startedAt}ms`);
  }
});

if (!AUTH_TOKEN && !ADMIN_TOKEN) {
  console.warn('[api] API_AUTH_TOKEN is not set: all routes are unauthenticated (dev only)');
} else if (!ADMIN_TOKEN) {
  console.warn('[api] API_ADMIN_TOKEN is not set: the regular API token can manage model configs (dev only)');
}
if (!READ_TOKEN) console.warn('[api] API_READ_TOKEN is not set: worker mission traces require the main token');

// Apply the idempotent baseline schema + ordered migrations before accepting
// traffic. This keeps a fresh API boot usable and makes API/worker/planner use
// the same versioned migration path.
try {
  await applySchema(getPool());
  // Single-operator deployment: seed the documented bootstrap admin exactly
  // once. It carries must_change_password, so the first login has to replace
  // the bootstrap password before anything else is allowed.
  const seeded = await ensureDefaultAdmin();
  if (seeded.created) {
    console.log(`[api] seeded default admin user "${seeded.username}" (password change required on first login)`);
  }
} catch (error) {
  console.error(`[api] schema/migrations failed: ${String(error)}`);
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] SRC-Agent API listening on :${PORT} cors=${CORS_ORIGINS.join(',')} mode=${AUTH_MODE} bearer=${AUTH_TOKEN ? 'on' : 'off'}`);
});
const shutdown = (): void => { server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);