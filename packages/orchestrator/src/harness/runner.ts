import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildAssignmentPrompt, buildContinuationPrompt, buildSettlementPrompt } from './assignment.js';
import { chunkMaxChunksFromEnv, chunkStepsFromEnv, isChunkingEnabled, shouldContinueChunking } from './chunk.js';
import { appendTrace, traceFromCliLine, type TraceEntry } from './trace.js';
import { applyModelOverride, loadHarnessRuntimeConfig, type HarnessRuntimeConfig, type ModelRuntimeOverride } from './config.js';
import { createRunEventAccumulator, type RunSummary, type TokenUsage } from './events.js';
import { buildHarnessPatchForConfig } from './patch.js';
import { mapHarnessReport } from './report.js';
import { KILL_WAIT_MS, SETTLEMENT_MAX_TURNS, SETTLEMENT_TIMEOUT_MS } from './retry.js';
import type { WorkerTask } from './types.js';
import type { AssetInput, EvidenceInput, FindingInput } from '../repositories/worker-repository.js';
import { MissionSummarySchema, type MissionSummary } from '@src-agent/contracts';
import { buildSummaryPrompt } from './assignment.js';

// ── Harness task runner ─────────────────────────────────────
// One task = one `dsh --profile headless --json` process, plus an ARTEX-style
// settlement pass when a run hits its wall clock / step limit. A stable run
// directory per task keeps the Harness session, patch and report file so both
// settlement and retries can resume from what was already discovered.

export interface HarnessRunOptions {
  sessionId?: string;
  recoveryNote?: string;
  keepRunDir?: boolean;
  /** Control-plane hints already claimed for this run boundary. */
  hints?: readonly string[];
  /** P3-A1 bounded digest of prior work in the same mission. */
  priorWork?: string;
  /** M5: bounded mission brief injected into the assignment prompt. */
  missionBrief?: string;
  /** M5: run-local mission-context.json for the read-only mission tools. */
  missionContextPath?: string;
  /** Cross-task request-index snapshot written by the controller. */
  requestIndexPath?: string;
  /** P3-B2 DB-backed model profile override (plaintext key stays in child env). */
  modelConfig?: ModelRuntimeOverride;
  /** Rotating key selected from the worker key pool (CLI runtime only). */
  llmApiKey?: string;
  /** Task attempt number; also the executor job identity. */
  attempt?: number;
  /** Prefer the full-duplex in-process runtime (executor path) instead of CLI. */
  runtime?: 'cli' | 'inprocess';
  /** Shared file the worker appends mid-run hints to; executor polls it. */
  hintFilePath?: string;
  /** Runtime settings: register dynamic mission trace search. */
  traceSearchEnabled?: boolean;
  /** Runtime settings: advisory request-dedupe mode. */
  requestDedupeMode?: 'off' | 'warn';
  /** Pull fresh hints before the settlement pass (returns newly claimed hints). */
  pullHints?: () => Promise<readonly string[]>;
  /** Extra child-process env for the executor's isolated in-process runtime. */
  env?: NodeJS.ProcessEnv;
  /** Cooperative hard-cancel signal for the executor/worker. */
  signal?: AbortSignal;
}

export interface HarnessRunOutcome {
  completed: boolean;
  failureClass?: string;
  artifacts: string[];
  evidence: EvidenceInput[];
  findings: FindingInput[];
  /** Worker-discovered assets persisted with the report (P3-B1 blackboard source). */
  assets: AssetInput[];
  /** Summary task output; normal worker tasks leave this undefined. */
  summary?: import('@src-agent/contracts').MissionSummary;
  sessionId?: string;
  steps: number;
  tokenUsage: TokenUsage;
  finalText: string;
  error?: string;
  /** True when a settlement pass ran after a limit was hit. */
  settled?: boolean;
  /** Number of step-bounded segments executed (1 when chunking is off). */
  chunks?: number;
  /** Compact Harness trajectory (thinking/text/tool calls/context). */
  trace?: TraceEntry[];
  limitReason?: string;
}

export interface HarnessProcessInput {
  config: HarnessRuntimeConfig;
  /** Receives every non-empty output line for trajectory capture. */
  onTraceLine?: (line: string) => void;
  /** Stable directory holding patch.json, DSH_HOME, workspace and run files. */
  runDir: string;
  /** Label used in progress logs. */
  label: string;
  prompt: string;
  sessionId?: string;
  maxWallClockMs: number;
  maxSteps: number;
  /** Extra environment variables for the Harness process. */
  env?: NodeJS.ProcessEnv;
  /** Cooperative hard-cancel signal; kills the current Harness child. */
  signal?: AbortSignal;
  /** Called for every parsed run event (used by the worker to enforce step limits). */
  onEvent?: (summary: ReturnType<typeof createRunEventAccumulator>['summary']) => void;
}

export interface HarnessProcessResult {
  summary: RunSummary;
  exitCode: number | null;
  stderrTail: string;
  limitReason?: string;
}

const STDERR_TAIL_CHARS = 8_000;

export function runDirRoot(): string {
  const configured = process.env.SRC_AGENT_RUN_DIR?.trim();
  return configured || join(tmpdir(), 'src-agent-runs');
}

export function runDirFor(taskId: string): string {
  return join(runDirRoot(), taskId);
}

export function sessionPathFor(runDir: string): string {
  return join(runDir, 'session.json');
}

export async function loadPersistedSession(taskId: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(sessionPathFor(runDirFor(taskId)), 'utf8')) as { sessionId?: string };
    return raw.sessionId;
  } catch {
    return undefined;
  }
}

export async function cleanupRunDir(taskId: string): Promise<void> {
  await rm(runDirFor(taskId), { recursive: true, force: true }).catch(() => undefined);
}

function logHarnessEvent(taskId: string, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return;
  try {
    const event = JSON.parse(trimmed) as {
      type?: string;
      phase?: string;
      step?: number;
      tool?: string;
      usage?: { totalTokens?: number };
      reason?: { kind?: string };
    };
    if (event.type === 'status' && event.phase === 'step_end') {
      console.log(`[harness ${taskId}] step=${event.step ?? 0} tokens=${event.usage?.totalTokens ?? 0}`);
    } else if (event.type === 'tool_call') {
      console.log(`[harness ${taskId}] tool=${event.tool ?? 'unknown'}`);
    } else if (event.type === 'final') {
      console.log(`[harness ${taskId}] final=${event.reason?.kind ?? 'unknown'}`);
    }
  } catch {
    // non-JSON diagnostics on stdout are ignored
  }
}

/**
 * Environment for the Harness child. The executing Agent must not inherit
 * control-plane credentials (it shares no trust boundary with the worker
 * controller); only the mission-scoped read token is forwarded.
 */
export function sanitizeHarnessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (/^PG_/i.test(key)) delete env[key];
    if (key === 'API_AUTH_TOKEN' || key === 'API_ADMIN_TOKEN' || key === 'PGPASSWORD') delete env[key];
  }
  // The read-only token is intentionally kept as SRC_AGENT_MISSION_API_TOKEN.
  return env;
}

/** Starts one Harness run and returns when the process exits. */
export async function runHarnessProcess(input: HarnessProcessInput): Promise<HarnessProcessResult> {
  const accumulator = createRunEventAccumulator();
  const reportPath = join(input.runDir, 'report.json');
  const patchPath = join(input.runDir, 'patch.json');
  const dshHome = join(input.runDir, 'dsh-home');
  const workspace = join(input.runDir, 'workspace');
  let stderrTail = '';
  let limitReason: string | undefined;

  const childEnv: NodeJS.ProcessEnv = {
    ...sanitizeHarnessEnv(),
    ...input.env,
    DSH_HOME: dshHome,
    NARB_DISABLE_NATIVE_CACHE: '1',
    SRC_AGENT_REPORT_PATH: reportPath,
    SRC_AGENT_PROXY_URL: process.env.PROXY_URL ?? 'http://proxy:8080',
  };

  const args = [
    input.config.dshBinPath,
    '--profile', 'headless',
    '--patch', patchPath,
    '--permission-mode', 'danger-full-access',
    '--approval-policy', 'never',
    '--json',
  ];
  if (input.sessionId) args.push('--session-id', input.sessionId);
  args.push(input.prompt);

  const child = spawn(process.execPath, args, { cwd: workspace, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

  const softKill = (reason: string): void => {
    if (limitReason) return;
    limitReason = reason;
    console.log(`[harness ${input.label}] limit reached (${reason}); requesting graceful stop`);
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_WAIT_MS);
    force.unref();
  };

  const wallClock = input.maxWallClockMs > 0
    ? setTimeout(() => softKill('run_timeout'), input.maxWallClockMs)
    : undefined;
  wallClock?.unref();
  const onAbort = (): void => softKill('cancelled');
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });

  const stdoutReader = createInterface({ input: child.stdout });
  stdoutReader.on('line', line => {
    accumulator.observe(line);
    input.onTraceLine?.(line);
    logHarnessEvent(input.label, line);
    input.onEvent?.(accumulator.summary);
    if (input.maxSteps > 0 && accumulator.steps() > input.maxSteps) {
      softKill('step_limit_exceeded');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', error => {
      stderrTail = `${stderrTail}\nspawn error: ${String(error)}`.slice(-STDERR_TAIL_CHARS);
      resolve({ code: null, signal: null });
    });
  });
  if (wallClock) clearTimeout(wallClock);
  input.signal?.removeEventListener('abort', onAbort);
  stdoutReader.close();

  const summary = accumulator.summary();
  return {
    summary,
    exitCode: exit.code,
    stderrTail,
    // A run that completed exactly at the boundary is a success, not a timeout.
    limitReason: summary.completed ? undefined : limitReason,
  };
}

export async function runHarnessTaskCli(
  task: WorkerTask,
  taskId: string,
  options: HarnessRunOptions = {},
): Promise<HarnessRunOutcome> {
  const config = applyModelOverride(loadHarnessRuntimeConfig(), options.modelConfig);
  const runDir = runDirFor(taskId);
  const patchPath = join(runDir, 'patch.json');
  const reportPath = join(runDir, 'report.json');
  await mkdir(join(runDir, 'workspace'), { recursive: true });
  await mkdir(join(runDir, 'dsh-home'), { recursive: true });
  await writeFile(patchPath, buildHarnessPatchForConfig(config, {
    ...reasoningOverrideFromEnv(process.env),
    ...(task.summary ? { disableShell: true } : {}),
  }), 'utf8');

  let sessionId = options.sessionId ?? await loadPersistedSession(taskId);
  const assignment = task.summary
    ? buildSummaryPrompt(task, options.hints ?? [], options.missionBrief)
    : buildAssignmentPrompt(task, options.hints ?? [], {
        skillsEnabled: config.skillsEnabled,
        priorWork: options.priorWork,
        missionBrief: options.missionBrief,
      });
  const prompt = options.recoveryNote ? `${assignment}\n\n${options.recoveryNote}` : assignment;
  const summaryPath = join(runDir, 'summary.json');

  let tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };
  const addUsage = (usage: TokenUsage): void => {
    tokenUsage = {
      input: tokenUsage.input + usage.input,
      output: tokenUsage.output + usage.output,
      total: tokenUsage.total + usage.total,
    };
  };

  const workerEnv: NodeJS.ProcessEnv = {
    SRC_AGENT_MISSION_ID: task.missionId,
    SRC_AGENT_TASK_ID: taskId,
    SRC_AGENT_TARGET_URL: task.targetUrl,
    SRC_AGENT_SCOPE_JSON: JSON.stringify(task.scope),
    SRC_AGENT_ROLE: 'worker',
    ...(task.summary ? { SRC_AGENT_TASK_KIND: 'summary', SRC_AGENT_SUMMARY_PATH: summaryPath } : {}),
    ...(options.missionContextPath ? { SRC_AGENT_MISSION_CONTEXT_PATH: options.missionContextPath } : {}),
    ...(options.requestIndexPath ? { SRC_AGENT_REQUEST_INDEX_PATH: options.requestIndexPath } : {}),
    ...(options.llmApiKey ? { [config.apiKeyEnv]: options.llmApiKey } : {}),
    SRC_AGENT_TRACE_SEARCH_ENABLED: options.traceSearchEnabled === false ? '0' : '1',
    ...(options.requestDedupeMode ? { REQUEST_DEDUPE_MODE: options.requestDedupeMode } : {}),
    ...(options.modelConfig?.apiKey ? { [config.apiKeyEnv]: options.modelConfig.apiKey } : {}),
  };
  const trace: TraceEntry[] = [];
  let traceSeq = 0;
  const onTraceLine = (line: string): void => {
    appendTrace(trace, traceFromCliLine(line, traceSeq));
    traceSeq += 1;
  };
  const pushContext = (source: string, text: string): void => {
    appendTrace(trace, { seq: traceSeq, type: 'context', payload: { source, text: text.slice(0, 6_000) }, ts: new Date().toISOString() });
    traceSeq += 1;
  };
  if ((options.hints ?? []).length > 0) pushContext('assignment_hints', (options.hints ?? []).join('\n'));
  if (options.recoveryNote) pushContext('recovery_note', options.recoveryNote);
  if (options.priorWork) pushContext('prior_work', options.priorWork);
  if (options.missionBrief) pushContext('mission_brief', options.missionBrief);
  // ── Main run, optionally split into step-bounded segments (H6a) ──
  const chunkSteps = chunkStepsFromEnv();
  const maxChunks = chunkMaxChunksFromEnv();
  const chunking = isChunkingEnabled(chunkSteps, task.maxSteps);
  const startedAt = Date.now();
  const deadline = task.maxWallClockMs > 0 ? startedAt + task.maxWallClockMs : undefined;
  const remainingMs = (): number => (deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - Date.now()));
  const segmentBudget = (maxSteps: number): { maxWallClockMs: number; maxSteps: number } => ({
    maxWallClockMs: deadline !== undefined ? Math.max(1, Math.min(remainingMs(), task.maxWallClockMs)) : task.maxWallClockMs,
    maxSteps,
  });

  const runSegment = async (segmentPrompt: string, segmentSteps: number) => runHarnessProcess({
    config,
    runDir,
    label: `${taskId}${chunking ? `:chunk` : ''}`,
    onTraceLine,
    prompt: segmentPrompt,
    sessionId,
    ...segmentBudget(segmentSteps),
    env: workerEnv,
    signal: options.signal,
  });

  let latest = await runSegment(prompt, chunking ? chunkSteps : task.maxSteps);
  if (options.signal?.aborted) latest.limitReason = 'cancelled';
  let chunks = 1;
  let steps = latest.summary.steps;
  let finalText = latest.summary.finalText;
  let error = latest.summary.error;
  addUsage(latest.summary.tokenUsage);
  sessionId = latest.summary.sessionId ?? sessionId;
  if (sessionId) {
    await writeFile(sessionPathFor(runDir), JSON.stringify({ sessionId }), 'utf8').catch(() => undefined);
  }
  let limitReason = latest.limitReason;

  while (!options.signal?.aborted && shouldContinueChunking({
    chunkStepBudget: chunkSteps,
    taskMaxSteps: task.maxSteps,
    limitReason,
    chunksRun: chunks,
    maxChunks,
    remainingMs: remainingMs(),
  })) {
    const freshHints = options.pullHints ? await options.pullHints().catch(() => []) : [];
    const hintList = [...(options.hints ?? []), ...freshHints];
    if (freshHints.length > 0) console.log(`[harness ${taskId}] ${freshHints.length} fresh hint(s) for chunk ${chunks + 1}`);
    console.log(`[harness ${taskId}] chunk ${chunks + 1}/${maxChunks} (segment budget ${chunkSteps} steps, ${Math.round(remainingMs() / 1000)}s left)`);
    latest = await runSegment(buildContinuationPrompt(hintList, chunks + 1), chunkSteps);
    chunks += 1;
    addUsage(latest.summary.tokenUsage);
    steps += latest.summary.steps;
    sessionId = latest.summary.sessionId ?? sessionId;
    finalText = latest.summary.finalText || finalText;
    error = latest.summary.error ?? error;
    limitReason = latest.limitReason;
    if (sessionId) {
      await writeFile(sessionPathFor(runDir), JSON.stringify({ sessionId }), 'utf8').catch(() => undefined);
    }
  }

  // ── Settlement pass (ARTEX): write back what was already found ──
  let settled = false;
  if (limitReason === 'cancelled') {
    // A hard cancellation must not start a settlement/cleanup pass.
  } else if (limitReason && sessionId && !latest.summary.completed) {
    settled = true;
    const freshHints = options.pullHints ? await options.pullHints().catch(() => []) : [];
    const settlementHints = [...(options.hints ?? []), ...freshHints];
    if (freshHints.length > 0) console.log(`[harness ${taskId}] ${freshHints.length} fresh hint(s) for settlement`);
    pushContext('settlement_prompt', buildSettlementPrompt(settlementHints));
    console.log(`[harness ${taskId}] settlement pass after ${limitReason} (max ${SETTLEMENT_MAX_TURNS} turns)`);
    const settlement = await runHarnessProcess({
      config,
      runDir,
      label: taskId,
      onTraceLine,
      prompt: buildSettlementPrompt(settlementHints),
      sessionId,
      maxWallClockMs: SETTLEMENT_TIMEOUT_MS,
      maxSteps: SETTLEMENT_MAX_TURNS,
      env: workerEnv,
      signal: options.signal,
    });
    addUsage(settlement.summary.tokenUsage);
    steps += settlement.summary.steps;
    sessionId = settlement.summary.sessionId ?? sessionId;
    finalText = settlement.summary.finalText || finalText;
    error = settlement.summary.error ?? error;
    if (settlement.limitReason) limitReason = settlement.limitReason;
  }

  let outcome: HarnessRunOutcome;
  try {
    const summary: MissionSummary | undefined = (() => {
      if (!task.summary) return undefined;
      try {
        const parsed = MissionSummarySchema.safeParse(JSON.parse(readFileSync(summaryPath, 'utf8')));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    })();
    const mapped = task.summary
      ? { artifacts: [], evidence: [], findings: [], assets: [] as AssetInput[] }
      : mapHarnessReport(JSON.parse(await readFile(reportPath, 'utf8')) as unknown, task.missionId, taskId);
    // ADR-0012: normal termination (exit 0, no limit, no error) marks the task
    // done; reported artifacts are an internal quality metric. With chunking we
    // additionally require the final segment to report completion, otherwise a
    // chunk-budget stop would masquerade as a finished task.
    const chunkIncomplete = chunking && !latest.summary.completed;
    const completed = !settled && !limitReason && latest.exitCode === 0 && !latest.summary.error && !chunkIncomplete && (!task.summary || summary !== undefined);
    outcome = {
      completed,
      failureClass: completed
        ? undefined
        : limitReason === 'cancelled' ? 'cancelled' : limitReason ?? (chunkIncomplete ? 'no_progress' : latest.summary.error ? 'model_error' : 'no_progress'),
      artifacts: mapped.artifacts,
      evidence: mapped.evidence,
      findings: mapped.findings,
      assets: mapped.assets,
      ...(summary ? { summary } : {}),
      sessionId,
      steps,
      tokenUsage,
      finalText,
      error,
      settled,
      chunks,
      trace,
      limitReason,
    };
  } catch (parseError) {
    outcome = {
      completed: false,
      failureClass: limitReason === 'cancelled' ? 'cancelled' : limitReason ?? (latest.exitCode === 0 ? 'no_progress' : 'tool_error'),
      artifacts: [],
      evidence: [],
      findings: [],
      assets: [],
      sessionId,
      steps,
      tokenUsage,
      finalText,
      error: `${String(parseError)}${latest.stderrTail ? `\n--- harness stderr ---\n${latest.stderrTail}` : ''}`.slice(0, 4_000),
      settled,
      chunks,
      trace,
      limitReason,
    };
  }

  // Completed runs clean up; failed runs keep the directory so a retry can
  // resume the same Harness session and reload the report file.
  if (outcome.completed && options.keepRunDir !== true && process.env.SRC_AGENT_KEEP_RUN !== '1') {
    await cleanupRunDir(taskId);
  }
  return outcome;
}

export function reasoningOverrideFromEnv(env: NodeJS.ProcessEnv): {
  reasoningEffort?: 'low' | 'high' | 'max';
  reasoningEfforts?: Record<string, string>;
} {
  const effort = env.LLM_REASONING_EFFORT?.trim().toLowerCase();
  const rawMap = env.LLM_REASONING_EFFORTS_JSON?.trim();
  if (!rawMap) return {};
  if (effort !== 'low' && effort !== 'high' && effort !== 'max') return {};
  try {
    const parsed = JSON.parse(rawMap) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const reasoningEfforts: Record<string, string> = {};
    for (const [level, wire] of Object.entries(parsed)) {
      if (typeof wire === 'string') reasoningEfforts[level] = wire;
    }
    if (Object.keys(reasoningEfforts).length === 0) return {};
    return { reasoningEffort: effort, reasoningEfforts };
  } catch {
    return {};
  }
}

export async function runHarnessTask(
  task: WorkerTask,
  taskId: string,
  options: HarnessRunOptions = {},
): Promise<HarnessRunOutcome> {
  const executor = process.env.SRC_AGENT_EXECUTOR_URL?.trim();
  if (executor) {
    const { runHarnessTaskRemote } = await import('./remote-executor.js');
    return runHarnessTaskRemote(task, taskId, options);
  }
  const runtime = (options.runtime ?? process.env.SRC_AGENT_RUNTIME ?? 'cli').trim().toLowerCase();
  if (runtime === 'inprocess') {
    const { runTaskInProcess } = await import('./inprocess.js');
    return runTaskInProcess(task, taskId, options);
  }
  return runHarnessTaskCli(task, taskId, options);
}
