import { spawn } from 'node:child_process';
import { sanitizeHarnessEnv } from './runner.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SETTLEMENT_TIMEOUT_MS } from './retry.js';
import { runDirFor, type HarnessRunOptions, type HarnessRunOutcome } from './runner.js';
import type { WorkerTask } from './types.js';

// ── Isolated multi-agent runtime supervisor (H6b phase 2/3) ──
// Spawns runtime-child.ts and drives one or more Jobs over an IPC channel. One
// child process boots DSH once and can host several Agents concurrently; each
// Agent gets its own configuration/toolset/report path inside the child.

export interface HarnessJobAgentOverrides {
  role?: 'worker' | 'planner';
  reportPath?: string;
  statePath?: string;
  planPath?: string;
  proxyUrl?: string;
  missionContextPath?: string;
  traceSearchEnabled?: boolean;
  requestDedupeMode?: 'off' | 'warn';
}

export interface HarnessJob {
  task: WorkerTask;
  taskId: string;
  options?: HarnessRunOptions;
  /** Optional per-agent overrides (multi-agent/role smoke tests, future pool). */
  agentConfig?: HarnessJobAgentOverrides;
}

interface JobResultMessage {
  type?: string;
  jobId?: string;
  id?: string;
  text?: string;
  items?: string[];
  outcome?: HarnessRunOutcome;
  error?: string;
}

function failureOutcome(failureClass: string, error: string): HarnessRunOutcome {
  return {
    completed: false,
    failureClass,
    artifacts: [],
    evidence: [],
    findings: [],
    assets: [],
    steps: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    finalText: '',
    error,
    chunks: 1,
    trace: [],
  };
}

function jobMessage(job: HarnessJob): Record<string, unknown> {
  const options = job.options ?? {};
  const overrides = job.agentConfig ?? {};
  return {
    jobId: job.taskId,
    taskId: job.taskId,
    task: job.task,
    agent: {
      role: overrides.role ?? 'worker',
      missionId: job.task.missionId,
      taskId: job.taskId,
      targetUrl: job.task.targetUrl,
      scope: job.task.scope,
      reportPath: overrides.reportPath ?? join(runDirFor(job.taskId), 'report.json'),
      proxyUrl: overrides.proxyUrl ?? process.env.SRC_AGENT_PROXY_URL ?? process.env.PROXY_URL ?? 'http://proxy:8080',
      allowAllEgress: process.env.EGRESS_MODE?.trim().toLowerCase() === 'open' || process.env.SRC_AGENT_ALLOW_ALL_EGRESS === '1',
      skillsEnabled: process.env.SRC_AGENT_SKILLS_ENABLED !== '0',
      statePath: overrides.statePath,
      planPath: overrides.planPath,
      missionContextPath: overrides.missionContextPath ?? options.missionContextPath,
      traceSearchEnabled: options.traceSearchEnabled !== false,
      requestDedupeMode: options.requestDedupeMode,
    },
    options: {
      hints: options.hints ?? [],
      recoveryNote: options.recoveryNote,
      priorWork: options.priorWork,
      missionBrief: options.missionBrief,
      missionContextPath: options.missionContextPath,
      sessionId: options.sessionId,
      keepRunDir: options.keepRunDir,
    },
  };
}

/**
 * Runs one or more tasks in a single isolated child process. Each task gets its
 * own Agent, toolset, report file and hint channel; results are keyed by taskId.
 */
export async function runJobsInProcess(
  jobs: HarnessJob[],
  signal?: AbortSignal,
): Promise<Map<string, HarnessRunOutcome>> {
  const childPath = process.env.SRC_AGENT_RUNTIME_CHILD || join(process.cwd(), 'src/harness/runtime-child.ts');
  const tsxBin = process.env.SRC_AGENT_TSX_BIN || join(process.cwd(), 'node_modules/.bin/tsx');
  if (!existsSync(childPath)) throw new Error(`in-process runtime child not found: ${childPath}`);
  if (!existsSync(tsxBin)) throw new Error(`tsx binary not found for the runtime child: ${tsxBin}`);

  const child = spawn(tsxBin, [childPath], {
    cwd: process.cwd(),
    env: { ...sanitizeHarnessEnv(), ...jobs[0]?.options?.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-16_000);
    process.stderr.write(`[runtime-child] ${text}`);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[runtime-child] ${chunk.toString('utf8')}`);
  });

  const results = new Map<string, HarnessRunOutcome>();
  const pending = new Set(jobs.map(job => job.taskId));
  const timers: NodeJS.Timeout[] = [];
  let resolved = false;

  const finishAll = (): void => {
    if (resolved) return;
    resolved = true;
    for (const timer of timers) clearInterval(timer);
    resolveResults(results);
  };
  let resolveResults!: (value: Map<string, HarnessRunOutcome>) => void;
  const done = new Promise<Map<string, HarnessRunOutcome>>(resolve => {
    resolveResults = resolve;
  });

  const mark = (jobId: string, outcome: HarnessRunOutcome): void => {
    if (!pending.delete(jobId)) return;
    results.set(jobId, outcome);
    if (pending.size === 0) finishAll();
  };

  const onAbort = (): void => {
    for (const jobId of Array.from(pending)) {
      mark(jobId, failureOutcome('cancelled', `executor job cancelled: ${jobId}`));
    }
    finishAll();
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000);
    force.unref?.();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  child.on('message', message => {
    const payload = message as JobResultMessage;
    if (payload.type === 'result' && payload.jobId && payload.outcome) {
      mark(payload.jobId, payload.outcome);
    } else if (payload.type === 'request-hints' && payload.jobId && payload.id) {
      const job = jobs.find(item => item.taskId === payload.jobId);
      const pull = job?.options?.pullHints;
      void (pull ? pull() : Promise.resolve([]))
        .catch(() => [])
        .then(items => {
          if (!resolved) child.send({ type: 'hints', id: payload.id, items });
        });
    } else if (payload.type === 'batch-error') {
      for (const jobId of Array.from(pending)) mark(jobId, failureOutcome('runtime_crash', payload.error ?? 'runtime child batch error'));
      finishAll();
    } else if (payload.type === 'batch-done') {
      for (const jobId of Array.from(pending)) {
        mark(jobId, failureOutcome('runtime_crash', `runtime child finished without a result for ${jobId}\n${stderrTail.slice(-1_000)}`));
      }
      finishAll();
    }
  });
  child.on('error', error => {
    for (const jobId of Array.from(pending)) mark(jobId, failureOutcome('runtime_crash', `runtime child spawn error: ${String(error)}`));
    finishAll();
  });
  child.on('exit', (code, signal) => {
    for (const jobId of Array.from(pending)) {
      mark(jobId, failureOutcome('runtime_crash', `runtime child exited code=${String(code)} signal=${String(signal)}\n${stderrTail.slice(-1_000)}`));
    }
    finishAll();
  });

  try {
    child.send({ type: 'start-batch', jobs: jobs.map(jobMessage) });
  } catch (error) {
    for (const jobId of Array.from(pending)) {
      mark(jobId, failureOutcome('runtime_crash', `runtime child unavailable: ${String(error)}`));
    }
    finishAll();
  }

  const hintPollMs = Number(process.env.SRC_AGENT_HINT_POLL_MS || 2_500);
  for (const job of jobs) {
    const options = job.options ?? {};
    if (options.pullHints) {
      let inFlight = false;
      const timer = setInterval(() => {
        if (resolved || inFlight) return;
        inFlight = true;
        void options.pullHints?.()
          .then(fresh => {
            for (const text of fresh) {
              if (resolved) break;
              try {
                child.send({ type: 'hint', jobId: job.taskId, text });
                console.log(`[harness ${job.taskId}] forwarded a mid-run hint to the runtime child`);
              } catch {
                // child gone; exit handler reports it
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      }, hintPollMs);
      timer.unref?.();
      timers.push(timer);
    }
    const jobTimeoutMs = job.task.maxWallClockMs > 0
      ? job.task.maxWallClockMs + SETTLEMENT_TIMEOUT_MS + 60_000
      : 30 * 60_000;
    const deadline = setTimeout(() => {
      mark(job.taskId, failureOutcome('runtime_timeout', `runtime child exceeded ${jobTimeoutMs}ms for ${job.taskId}`));
      finishAll();
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }, jobTimeoutMs);
    deadline.unref?.();
    timers.push(deadline);
  }

  const resultsMap = await done;
  signal?.removeEventListener('abort', onAbort);
  child.removeAllListeners();
  try {
    child.kill('SIGTERM');
  } catch {
    // already exited
  }
  return resultsMap;
}

/** Single-task convenience wrapper over the isolated multi-agent supervisor. */
export async function runTaskInProcess(
  task: WorkerTask,
  taskId: string,
  options: HarnessRunOptions = {},
): Promise<HarnessRunOutcome> {
  const results = await runJobsInProcess([{ task, taskId, options }], options.signal);
  return results.get(taskId) ?? failureOutcome('runtime_crash', 'runtime child returned no result');
}
