import http from 'node:http';
import { createPool, waitForDatabase } from '../db/pool.js';
import { collectWatchdogObservations, watchdogConfigFromEnv } from './observer.js';
import { reviewWatchdogTask } from './llm.js';
import type { WatchdogObservation } from '../scheduler/watchdog.js';

// ── Independent watchdog service ────────────────────────────
// Runs outside worker/dispatcher loops. It reads the control plane, computes
// bounded observations, and asks the dispatcher to record a trigger + hint
// (the dispatcher remains the only DB writer). It cannot execute target tools.

const PORT = Number(process.env.WATCHDOG_PORT || 9400);
const INTERVAL_MS = Math.max(5_000, Number(process.env.WATCHDOG_INTERVAL_MS || 60_000));
const DISPATCHER_URL = (process.env.DISPATCHER_URL || 'http://dispatcher:9300').replace(/\/+$/, '');
const DISPATCHER_TOKEN = process.env.DISPATCHER_TOKEN?.trim() || '';
const pool = createPool();
const config = watchdogConfigFromEnv();
const LLM_ENABLED = process.env.WATCHDOG_LLM_ENABLED !== '0';
const LLM_INTERVAL_MS = Math.max(60_000, Number(process.env.WATCHDOG_LLM_INTERVAL_MS || 300_000));
const llmLastReviewed = new Map<string, number>();

function log(message: string): void {
  console.log(`[watchdog] ${message}`);
}

async function postObservation(observation: {
  rule: string;
  missionId: string;
  taskId?: string;
  detail: string;
  source?: 'rules' | 'llm';
  progress?: boolean;
}): Promise<boolean> {
  try {
    const response = await fetch(`${DISPATCHER_URL}/internal/dispatch/watchdog/observe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(DISPATCHER_TOKEN ? { 'x-dispatcher-token': DISPATCHER_TOKEN } : {}),
      },
      body: JSON.stringify(observation),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      log(`observation rejected HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return false;
    }
    const body = await response.json() as { recorded?: boolean; action?: string };
    if (body.action === 'reset') log(`progress observed ${observation.taskId ?? observation.missionId}; stall streak reset`);
    else if (body.action === 'escalated') log(`escalation task=${observation.taskId ?? '-'} rule=${observation.rule}`);
    return Boolean(body.recorded);
  } catch (error) {
    log(`dispatcher unavailable: ${String(error)}`);
    return false;
  }
}

function traceActivity(rows: Array<{ event_type: string; payload: Record<string, unknown> }>): string[] {
  return rows.slice(0, 15).map(row => {
    const payload = row.payload ?? {};
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const tool = typeof input.tool === 'string' ? input.tool : typeof payload.tool === 'string' ? payload.tool : '';
    const url = typeof input.url === 'string' ? input.url : typeof payload.url === 'string' ? payload.url : '';
    const command = typeof input.command === 'string' ? input.command : '';
    const text = typeof payload.text === 'string' ? payload.text : '';
    const summary = [row.event_type, tool, url, command ? `cmd=${command.slice(0, 120)}` : '', text.slice(0, 160)]
      .filter(Boolean).join(' ');
    return summary.slice(0, 400);
  });
}

interface WatchdogObservationWithMeta extends WatchdogObservation {
  source?: 'rules' | 'llm';
  progress?: boolean;
}

async function collectLlmObservations(): Promise<WatchdogObservationWithMeta[]> {
  if (!LLM_ENABLED || !process.env.MODEL_PROXY_TOKEN?.trim()) return [];
  let tasks;
  try {
    tasks = await pool.query(
      `SELECT t.id AS task_id, t.mission_id, t.state, t.started_at, t.payload, m.objective
       FROM tasks t JOIN missions m ON m.id = t.mission_id
       WHERE t.state = 'running' AND m.state IN ('pending','running','active')
       ORDER BY t.started_at ASC LIMIT 3`,
    );
  } catch (error) {
    log(`llm task query failed: ${String(error)}`);
    return [];
  }
  const now = Date.now();
  const observations: WatchdogObservationWithMeta[] = [];
  for (const row of tasks.rows) {
    const taskId = String(row.task_id);
    const last = llmLastReviewed.get(taskId) ?? 0;
    if (now - last < LLM_INTERVAL_MS) continue;
    llmLastReviewed.set(taskId, now);
    const missionId = String(row.mission_id);
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const startedAt = row.started_at ? new Date(row.started_at).getTime() : now;
    const recentTrace = await pool.query(
      `SELECT event_type, payload FROM task_trace WHERE task_id = $1 ORDER BY id DESC LIMIT 15`,
      [taskId],
    ).catch(() => ({ rows: [] as Array<{ event_type: string; payload: Record<string, unknown> }> }));
    const findings = await pool.query(
      `SELECT title FROM findings WHERE mission_id = $1 AND status IN ('accepted','needs_review')
       ORDER BY created_at DESC LIMIT 5`,
      [missionId],
    ).catch(() => ({ rows: [] as Array<{ title: string }> }));
    const result = await reviewWatchdogTask({
      missionId,
      taskId,
      missionObjective: String(row.objective ?? ''),
      taskObjective: typeof payload.objective === 'string' ? payload.objective : String(payload.kind ?? 'task'),
      taskState: String(row.state),
      runningMinutes: Math.max(0, (now - startedAt) / 60_000),
      recentActivity: traceActivity(recentTrace.rows),
      recentFindings: findings.rows.map(finding => String(finding.title)),
    }).catch(error => {
      log(`llm review failed task=${taskId}: ${String(error)}`);
      return null;
    });
    if (!result) {
      log(`llm review unavailable task=${taskId}`);
      continue;
    }
    log(`llm review task=${taskId} verdict=${result.verdict} reason=${result.reason.slice(0, 160)}`);
    if (result.verdict !== 'ok') {
      observations.push({
        rule: 'direction_drift',
        missionId,
        taskId,
        detail: `Watchdog LLM verdict=${result.verdict}: ${result.reason}`,
        source: 'llm',
      });
    } else {
      // A healthy review proves the task is not stalling: reset its streak so
      // only consecutive stall signals can escalate.
      observations.push({
        rule: 'direction_drift',
        missionId,
        taskId,
        detail: 'Watchdog LLM verdict=ok',
        source: 'llm',
        progress: true,
      });
    }
  }
  return observations;
}

/** Asks the dispatcher to record hint effect for observations older than the window. */
async function postSweep(): Promise<number> {
  try {
    const response = await fetch(`${DISPATCHER_URL}/internal/dispatch/watchdog/sweep`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(DISPATCHER_TOKEN ? { 'x-dispatcher-token': DISPATCHER_TOKEN } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return 0;
    const body = await response.json() as { checked?: number };
    return Number(body.checked ?? 0);
  } catch {
    return 0;
  }
}

async function runOnce(): Promise<void> {
  try {
    const deterministic = await collectWatchdogObservations(pool, config).then(items => items.map(item => ({ ...item, source: 'rules' as const })));
    const llmObservations = await collectLlmObservations();
    const observations = [...deterministic, ...llmObservations];
    let recorded = 0;
    for (const observation of observations) {
      if (await postObservation(observation)) recorded += 1;
    }
    // The sweep must run on every tick even when nothing new is observed:
    // it resolves hints that are now older than the effect window.
    const swept = await postSweep();
    if (observations.length > 0 || swept > 0) {
      log(`observations=${observations.length} recorded=${recorded} swept=${swept} interval=${Math.round(INTERVAL_MS / 1000)}s`);
    }
  } catch (error) {
    log(`tick failed: ${String(error)}`);
  }
}

const server = http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, role: 'watchdog', intervalMs: INTERVAL_MS }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
});

async function main(): Promise<void> {
  await waitForDatabase(pool);
  if (process.env.WATCHDOG_ENABLED === '0') {
    log('WATCHDOG_ENABLED=0; observation loop disabled');
  }
  let stopped = process.env.WATCHDOG_ENABLED === '0';
  const timer = setInterval(() => { if (!stopped) void runOnce(); }, INTERVAL_MS);
  timer.unref?.();
  process.on('SIGTERM', () => {
    stopped = true;
    clearInterval(timer);
    server.close(() => { void pool.end(); process.exit(0); });
  });
  process.on('SIGINT', () => {
    stopped = true;
    clearInterval(timer);
    server.close(() => { void pool.end(); process.exit(0); });
  });
  server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT} interval=${INTERVAL_MS}ms window=${config.windowMinutes}m`));
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  if (!stopped) void runOnce();
}

void main().catch(error => {
  console.error('[watchdog] fatal:', error);
  process.exit(1);
});
