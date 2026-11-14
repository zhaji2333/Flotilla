import http from 'node:http';
import { createPool } from '../db/pool.js';
import { applySchema } from '../db/schema.js';
import { getActiveModelConfig, getMissionTraceSummary, buildMissionContext, upsertRequestIndex, getRuntimeSettings, hasUnconfirmedTaskActions } from '@src-agent/control-plane';
import {
  FencingError,
  claimTask,
  claimTaskHints,
  finishTask,
  heartbeatTask,
  markTaskRunning,
  recordEvent,
  schedulerTick,
  taskState,
} from '../repositories/worker-repository.js';
import { watchdogTick } from '../repositories/watchdog-repository.js';
import { applyWatchdogObservation, evaluateWatchdogOutcomes } from '../repositories/watchdog-store.js';
import { DispatcherLeader } from './leader.js';
import { recordTaskTrace } from '../repositories/trace-repository.js';
import type {
  FinishTaskRequest,
  SafeModelConfig,
  TraceRecordRequest,
} from './protocol.js';

// ── Trusted dispatcher ──────────────────────────────────────
// This is the only controller process that can touch PostgreSQL. Agents and the
// Worker controller sit on a separate network and never receive PG_* env.

const PORT = Number(process.env.DISPATCHER_PORT || 9300);
const TOKEN = process.env.DISPATCHER_TOKEN?.trim() || '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const pool = createPool();
const leader = new DispatcherLeader(pool);

function log(message: string): void {
  console.log(`[dispatcher] ${message}`);
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('dispatcher body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error(`invalid JSON: ${String(error)}`)); }
    });
    request.on('error', reject);
  });
}

function authorized(request: http.IncomingMessage): boolean {
  if (!TOKEN) return true; // dev-only; startup warns
  return request.headers['x-dispatcher-token'] === TOKEN;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = Number(body[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/healthz') return json(response, 200, { ok: true, role: 'dispatcher', leader: leader.isLeader(), pid: process.pid });
  if (!authorized(request)) return json(response, 401, { error: 'dispatcher token required' });
  if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
  let raw: unknown;
  try { raw = await readBody(request); } catch (error) { return json(response, 400, { error: String(error) }); }
  if (!isObject(raw)) return json(response, 400, { error: 'JSON object body required' });

  switch (url.pathname) {
    case '/internal/dispatch/hello':
      return json(response, 200, { ok: true, version: '1' });
    case '/internal/dispatch/claim': {
      const task = await claimTask(pool, stringField(raw, 'workerId'));
      return json(response, 200, { task });
    }
    case '/internal/dispatch/scheduler-tick':
      return json(response, 200, leader.isLeader()
        ? await schedulerTick(pool)
        : { expired: 0, exhausted: 0, promoted: 0, blocked: 0, writeBlocked: 0, skipped: true });
    case '/internal/dispatch/watchdog-tick':
      return json(response, 200, leader.isLeader()
        ? await watchdogTick(pool)
        : { observations: 0, hints: 0, skipped: true });
    case '/internal/dispatch/watchdog/observe': {
      const rule = stringField(raw, 'rule');
      if (rule !== 'duplicate_url' && rule !== 'no_progress' && rule !== 'direction_drift') {
        return json(response, 400, { error: 'unknown watchdog rule' });
      }
      const observation = {
        rule: rule as 'duplicate_url' | 'no_progress' | 'direction_drift',
        missionId: stringField(raw, 'missionId'),
        ...(typeof raw.taskId === 'string' && raw.taskId ? { taskId: raw.taskId } : {}),
        detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 1_000) : 'watchdog observation',
        source: raw.source === 'llm' ? 'llm' as const : 'rules' as const,
        progress: raw.progress === true,
      };
      // No leader gate: the observation is deduped by (mission, rule, window)
      // and streak updates are single-row upserts, so any replica can apply it.
      const result = await applyWatchdogObservation(pool, observation);
      return json(response, 200, { ok: true, ...result });
    }
    case '/internal/dispatch/watchdog/sweep': {
      // The sweep only touches rows that are still `pending`, so it is safe on
      // any replica; leader gating would make a busy replica drop the sweep.
      const minAgeMs = typeof raw.minAgeMs === 'number' && Number.isFinite(raw.minAgeMs) ? raw.minAgeMs : undefined;
      return json(response, 200, await evaluateWatchdogOutcomes(pool, { minAgeMs }));
    }
    case '/internal/dispatch/tasks/state':
      return json(response, 200, await taskState(pool, stringField(raw, 'taskId'), numberField(raw, 'fencingToken')));
    case '/internal/dispatch/tasks/start':
      await markTaskRunning(pool, stringField(raw, 'taskId'), stringField(raw, 'workerId'), numberField(raw, 'fencingToken'));
      return json(response, 200, { ok: true });
    case '/internal/dispatch/tasks/heartbeat':
      await heartbeatTask(pool, stringField(raw, 'taskId'), numberField(raw, 'fencingToken'));
      return json(response, 200, { ok: true });
    case '/internal/dispatch/hints/claim': {
      const hints = await claimTaskHints(pool, stringField(raw, 'missionId'), stringField(raw, 'taskId'), Number(raw.limit ?? 8));
      return json(response, 200, { hints });
    }
    case '/internal/dispatch/events':
      await recordEvent(pool, stringField(raw, 'missionId'), stringField(raw, 'eventType'), stringField(raw, 'aggregateId'), (raw.payload ?? {}) as Record<string, unknown>);
      return json(response, 200, { ok: true });
    case '/internal/dispatch/tasks/finish': {
      const result = await finishTask(pool, raw as unknown as FinishTaskRequest);
      return json(response, 200, result);
    }
    case '/internal/dispatch/traces': {
      const inserted = await recordTaskTrace(pool, raw as unknown as TraceRecordRequest);
      return json(response, 200, { inserted });
    }
    case '/internal/dispatch/request-index': {
      const fingerprints = Array.isArray(raw.fingerprints) ? raw.fingerprints : [];
      const inserted = await upsertRequestIndex(pool, stringField(raw, 'missionId'), stringField(raw, 'taskId'), fingerprints as never);
      return json(response, 200, { inserted });
    }
    case '/internal/dispatch/model-config': {
      const config = await getActiveModelConfig(pool, 'worker');
      const safe: SafeModelConfig | null = config ? {
        id: config.id,
        name: config.name,
        modelName: config.modelName,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        compat: config.compat,
        role: config.role,
        tier: config.tier,
      } : null;
      return json(response, 200, { config: safe });
    }
    case '/internal/dispatch/retry-guard': {
      const actionCount = await hasUnconfirmedTaskActions(pool, stringField(raw, 'missionId'), stringField(raw, 'taskId'));
      return json(response, 200, { requiresConfirmation: actionCount > 0, actionCount });
    }
    case '/internal/dispatch/runtime-settings': {
      return json(response, 200, { settings: await getRuntimeSettings(pool) });
    }
    case '/internal/dispatch/mission-context': {
      const settings = await getRuntimeSettings(pool);
      const context = await buildMissionContext(pool, stringField(raw, 'missionId'), stringField(raw, 'taskId'), {
        maxBytes: Number(raw.maxBytes) || undefined,
        briefMaxChars: Number(raw.briefMaxChars) || undefined,
        requestIndexTtlMinutes: settings['worker.requestDedupeTtlMinutes'],
      });
      return json(response, 200, { context });
    }
    case '/internal/dispatch/prior-work': {
      const summary = await getMissionTraceSummary(pool, stringField(raw, 'missionId'), {
        excludeTaskId: stringField(raw, 'taskId'),
        taskLimit: Number(raw.taskLimit) || undefined,
        maxDigestChars: Number(raw.maxDigestChars) || undefined,
      });
      const digest = summary?.digest.trim();
      return json(response, 200, { priorWork: digest ? { digest, tasks: summary?.tasks.length ?? 0 } : null });
    }
    default:
      return json(response, 404, { error: 'not found' });
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'dispatcher'}`);
  void handle(request, response, url).catch(error => {
    if (error instanceof FencingError) {
      if (!response.headersSent) json(response, 409, { error: error.message, code: 'fencing' });
      return;
    }
    log(`request ${url.pathname} failed: ${String(error)}`);
    if (!response.headersSent) json(response, 500, { error: String(error) });
  });
});

async function main(): Promise<void> {
  if (!TOKEN) log('DISPATCHER_TOKEN is not set; endpoint is unauthenticated (dev only)');
  await applySchema(pool);
  leader.start();
  server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}`));
}
const shutdown = (): void => { server.close(() => { void leader.stop().finally(() => { void pool.end(); process.exit(0); }); }); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
void main().catch(error => {
  console.error('dispatcher fatal:', error);
  process.exit(1);
});
