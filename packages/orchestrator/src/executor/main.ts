import http from 'node:http';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { runHarnessTaskCli } from '../harness/runner.js';
import { runTaskInProcess } from '../harness/inprocess.js';
import { createHintFileReader } from '../harness/hint-file.js';
import { runDirFor } from '../harness/runner.js';
import type { ExecutorJob, ExecutorOutcomeFile } from '../harness/executor-protocol.js';

// ── Independent executor service ────────────────────────────
// Runs the Harness agent in a container that has no PostgreSQL credentials and
// no control-plane admin token. The trusted worker controller claims tasks,
// supplies a bounded job, and persists the returned outcome. The executor only
// writes files under the shared run directory.

const PORT = Number(process.env.EXECUTOR_PORT || 9100);
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.EXECUTOR_CONCURRENCY || 3)));
const TOKEN = process.env.EXECUTOR_TOKEN?.trim() || '';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface JobState {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  outcomePath?: string;
  tracePath?: string;
  error?: string;
  controller?: AbortController;
  taskId?: string;
  attempt?: number;
}
const jobs = new Map<string, JobState>();
let active = 0;

function log(message: string): void {
  console.log(`[executor] ${message}`);
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('executor request body too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function authorized(request: http.IncomingMessage): boolean {
  if (!TOKEN) return true; // dev-only; startup warns
  return request.headers['x-executor-token'] === TOKEN;
}

function validJob(value: unknown): value is ExecutorJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<ExecutorJob>;
  return typeof job.jobId === 'string' &&
    typeof job.taskId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(job.taskId) &&
    Number.isInteger(job.attempt) &&
    Boolean(job.task) && typeof job.task === 'object';
}

async function executeJob(job: ExecutorJob, signal: AbortSignal): Promise<JobState> {
  log(`job=${job.jobId} task=${job.taskId} attempt=${job.attempt} summary=${Boolean((job.task as { summary?: boolean }).summary)}`);
  const runDir = runDirFor(job.taskId);
  await mkdir(runDir, { recursive: true });
  const summaryTask = Boolean((job.task as { summary?: boolean }).summary);
  const useInProcess = !summaryTask && job.options.runtime === 'inprocess';
  // The worker's DB model override is a proxy URL for a specific config. The
  // in-process child boots from env, so apply the same route to that child.
  const modelEnv: NodeJS.ProcessEnv = job.options.modelConfig ? {
    LLM_BASE_URL: job.options.modelConfig.baseUrl,
    LLM_MODEL: job.options.modelConfig.model,
    LLM_API_KEY_ENV: job.options.modelConfig.apiKeyEnv,
    ...(job.options.modelConfig.contextWindow ? { LLM_CONTEXT_WINDOW: String(job.options.modelConfig.contextWindow) } : {}),
    ...(job.options.modelConfig.maxOutputTokens ? { LLM_MAX_OUTPUT_TOKENS: String(job.options.modelConfig.maxOutputTokens) } : {}),
    ...(job.options.modelConfig.reasoningEffort ? { LLM_REASONING_EFFORT: job.options.modelConfig.reasoningEffort } : {}),
    ...(job.options.modelConfig.compat ? { LLM_COMPAT_JSON: JSON.stringify(job.options.modelConfig.compat) } : {}),
  } : {};
  const options = {
    sessionId: job.options.sessionId,
    recoveryNote: job.options.recoveryNote,
    hints: job.options.hints,
    priorWork: job.options.priorWork,
    missionBrief: job.options.missionBrief,
    missionContextPath: job.options.missionContextPath,
    requestIndexPath: job.options.requestIndexPath,
    modelConfig: job.options.modelConfig,
    llmApiKey: job.options.llmApiKey,
    attempt: job.attempt,
    traceSearchEnabled: job.options.traceSearchEnabled,
    requestDedupeMode: job.options.requestDedupeMode,
    // The controller reads and cleans the shared directory after transfer.
    keepRunDir: true,
    signal,
  };
  const outcome = useInProcess
    ? await runTaskInProcess(job.task, job.taskId, {
        ...options,
        env: modelEnv,
        ...(job.options.hintFilePath ? { pullHints: createHintFileReader(job.options.hintFilePath) } : {}),
      })
    : await runHarnessTaskCli(job.task, job.taskId, options);
  if (signal.aborted) return { status: 'cancelled', error: 'executor job cancelled' };
  const outcomePath = join(runDir, 'outcome.json');
  const tracePath = join(runDir, 'trace.json');
  const outcomeFile: ExecutorOutcomeFile = { ...outcome };
  delete (outcomeFile as { trace?: unknown }).trace;
  await writeFile(outcomePath, JSON.stringify(outcomeFile), 'utf8');
  await writeFile(tracePath, JSON.stringify(outcome.trace ?? []), 'utf8');
  return { status: 'completed', outcomePath, tracePath };
}

async function handleRun(job: ExecutorJob, response: http.ServerResponse): Promise<void> {
  const existing = jobs.get(job.jobId);
  if (existing) {
    if (existing.status === 'running') return json(response, 409, { ok: false, error: 'executor job already running' });
    if (existing.status === 'completed' && existing.outcomePath) {
      try {
        await access(existing.outcomePath);
        return json(response, 200, { ok: true, ...existing });
      } catch {
        // The controller cleans the shared run dir after a successful read; a
        // repeated smoke/direct job id must rerun instead of returning a dead path.
        jobs.delete(job.jobId);
      }
    } else {
      return json(response, 500, { ok: false, ...existing });
    }
  }
  if (active >= CONCURRENCY) return json(response, 503, { ok: false, error: 'executor busy' });
  const controller = new AbortController();
  jobs.set(job.jobId, { status: 'running', controller, taskId: job.taskId, attempt: job.attempt });
  active += 1;
  try {
    const state = await executeJob(job, controller.signal);
    jobs.set(job.jobId, state);
    if (controller.signal.aborted) return json(response, 499, { ok: false, cancelled: true, error: 'executor job cancelled' });
    json(response, 200, { ok: true, ...state });
  } catch (error) {
    if (controller.signal.aborted) {
      jobs.set(job.jobId, { status: 'cancelled', error: 'executor job cancelled' });
      return json(response, 499, { ok: false, cancelled: true, error: 'executor job cancelled' });
    }
    log(`job=${job.jobId} failed: ${String(error)}`);
    const state: JobState = { status: 'failed', error: String(error).slice(0, 2_000) };
    jobs.set(job.jobId, state);
    json(response, 500, { ok: false, ...state });
  } finally {
    active -= 1;
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'executor'}`);
    if (url.pathname === '/healthz') return json(response, 200, { ok: true, active, queued: jobs.size });
    if (!authorized(request)) return json(response, 401, { error: 'executor token required' });
    if (url.pathname === '/internal/cleanup' && request.method === 'POST') {
      let body: unknown;
      try { body = await readBody(request); } catch (error) { return json(response, 400, { error: String(error) }); }
      const taskIds = Array.isArray((body as { taskIds?: unknown }).taskIds) ? (body as { taskIds: unknown[] }).taskIds : [];
      let removed = 0;
      for (const taskId of taskIds) {
        if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) continue;
        const root = resolve(process.env.SRC_AGENT_RUN_DIR || '/runs');
        const target = resolve(root, taskId);
        if (target !== root && target.startsWith(`${root}${sep}`)) {
          await rm(target, { recursive: true, force: true }).then(() => { removed += 1; }).catch(() => undefined);
        }
      }
      return json(response, 200, { ok: true, removed });
    }
    if (url.pathname === '/internal/cancel' && request.method === 'POST') {
      let body: unknown;
      try { body = await readBody(request); } catch (error) { return json(response, 400, { error: String(error) }); }
      const requestedJobId = typeof (body as { jobId?: unknown }).jobId === 'string' ? (body as { jobId: string }).jobId : '';
      const requestedTaskId = typeof (body as { taskId?: unknown }).taskId === 'string' ? (body as { taskId: string }).taskId : '';
      const requestedAttempt = Number((body as { attempt?: unknown }).attempt);
      let cancelled = 0;
      for (const [jobId, state] of jobs) {
        if (state.status !== 'running') continue;
        if (requestedJobId && jobId !== requestedJobId) continue;
        if (requestedTaskId && state.taskId !== requestedTaskId) continue;
        if (Number.isInteger(requestedAttempt) && state.attempt !== requestedAttempt) continue;
        state.controller?.abort();
        state.status = 'cancelled';
        cancelled += 1;
      }
      log(`cancel request job=${requestedJobId || '-'} task=${requestedTaskId || '-'} attempt=${Number.isInteger(requestedAttempt) ? requestedAttempt : '-'} matched=${cancelled}`);
      return cancelled > 0 ? json(response, 200, { ok: true, cancelled }) : json(response, 404, { ok: false, error: 'executor job not running' });
    }
    if (url.pathname !== '/internal/run' || request.method !== 'POST') return json(response, 404, { error: 'not found' });
    let body: unknown;
    try { body = await readBody(request); } catch (error) { return json(response, 400, { error: String(error) }); }
    if (!validJob(body)) return json(response, 400, { error: 'invalid executor job' });
    await handleRun(body, response);
  })().catch(error => {
    if (!response.headersSent) json(response, 500, { error: String(error) });
  });
});

if (!TOKEN) log('EXECUTOR_TOKEN is not set; endpoint is unauthenticated (dev only)');
server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT} concurrency=${CONCURRENCY} runDir=${process.env.SRC_AGENT_RUN_DIR ?? 'default'}`));

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
