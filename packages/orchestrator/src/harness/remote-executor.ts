import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ExecutorJob, ExecutorOutcomeFile, ExecutorResponse } from './executor-protocol.js';
import { cleanupRunDir, runDirFor, type HarnessRunOptions, type HarnessRunOutcome } from './runner.js';
import type { WorkerTask } from './types.js';

const DEFAULT_TIMEOUT_MS = 25 * 60_000;

export class ExecutorCancelledError extends Error {
  constructor(message = 'executor job cancelled') {
    super(message);
    this.name = 'ExecutorCancelledError';
  }
}

function executorUrl(): string {
  return (process.env.SRC_AGENT_EXECUTOR_URL ?? '').replace(/\/+$/, '');
}

function executorToken(): string {
  return process.env.SRC_AGENT_EXECUTOR_TOKEN?.trim() || '';
}

function taskPath(taskId: string, path: string): string {
  const root = resolve(runDirFor(taskId));
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('executor returned a path outside the task run directory');
  }
  return target;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runHarnessTaskRemote(
  task: WorkerTask,
  taskId: string,
  options: HarnessRunOptions = {},
): Promise<HarnessRunOutcome> {
  const baseUrl = executorUrl();
  if (!baseUrl) throw new Error('SRC_AGENT_EXECUTOR_URL is not configured');
  const attempt = options.attempt ?? 1;
  const job: ExecutorJob = {
    jobId: `${taskId}:${attempt}`,
    taskId,
    attempt,
    task,
    options: {
      sessionId: options.sessionId,
      recoveryNote: options.recoveryNote,
      keepRunDir: options.keepRunDir,
      hints: options.hints,
      priorWork: options.priorWork,
      missionBrief: options.missionBrief,
      missionContextPath: options.missionContextPath,
      requestIndexPath: options.requestIndexPath,
      modelConfig: options.modelConfig,
      llmApiKey: options.llmApiKey,
      attempt,
      runtime: options.runtime,
      hintFilePath: options.hintFilePath,
      traceSearchEnabled: options.traceSearchEnabled,
      requestDedupeMode: options.requestDedupeMode,
    },
  };
  const wallClock = Math.max(1, task.maxWallClockMs || 0);
  const timeoutMs = Math.max(60_000, Math.min(DEFAULT_TIMEOUT_MS, wallClock + 120_000));
  const requestSignal = options.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
    : AbortSignal.timeout(timeoutMs);
  let response: Response | undefined;
  let lastError: unknown;
  for (let attemptIndex = 1; attemptIndex <= 30; attemptIndex += 1) {
    try {
      response = await fetch(`${baseUrl}/internal/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(executorToken() ? { 'x-executor-token': executorToken() } : {}),
        },
        body: JSON.stringify(job),
        signal: requestSignal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ExecutorCancelledError();
      lastError = error;
      await sleep(Math.min(5_000, 1_000 * attemptIndex));
      continue;
    }
    // All executor slots may be occupied by normal workers when a smoke/health
    // probe arrives; retry the bounded queue instead of failing the task.
    if (response.status === 503 || response.status === 409) {
      lastError = new Error(`executor busy (HTTP ${response.status})`);
      await sleep(Math.min(5_000, 1_000 * attemptIndex));
      continue;
    }
    lastError = undefined;
    break;
  }
  if (!response) throw new Error(`executor_unavailable: ${String(lastError)}`);
  if (response.status === 499) throw new ExecutorCancelledError();
  const body = await response.clone().json().catch(() => null) as ExecutorResponse | null;
  if (!response.ok || !body?.ok || !body.outcomePath) {
    throw new Error(`executor_failed: ${body?.error ?? `HTTP ${response.status}`}`);
  }
  const outcomePath = taskPath(taskId, body.outcomePath);
  const outcome = JSON.parse(await readFile(outcomePath, 'utf8')) as ExecutorOutcomeFile;
  let trace: HarnessRunOutcome['trace'];
  if (body.tracePath) {
    try {
      trace = JSON.parse(await readFile(taskPath(taskId, body.tracePath), 'utf8')) as HarnessRunOutcome['trace'];
    } catch {
      trace = [];
    }
  }
  const result: HarnessRunOutcome = { ...outcome, ...(trace ? { trace } : {}) };
  if (result.completed && options.keepRunDir !== true && process.env.SRC_AGENT_KEEP_RUN !== '1') {
    await cleanupRunDir(taskId);
  }
  return result;
}


/** Requests the executor to hard-cancel one task attempt. Idempotent/best-effort. */
export async function cancelRemoteTask(taskId: string, attempt: number): Promise<boolean> {
  const baseUrl = executorUrl();
  if (!baseUrl) return false;
  try {
    const response = await fetch(`${baseUrl}/internal/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(executorToken() ? { 'x-executor-token': executorToken() } : {}),
      },
      body: JSON.stringify({ jobId: `${taskId}:${attempt}`, taskId, attempt }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
