import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import {
  createAgentToolset,
  createPlannerToolset,
  mountToolset,
  type AgentToolset,
  type PluginConfig,
} from '@src-agent/harness-plugin';
import { buildAssignmentPrompt, buildSettlementPrompt } from './assignment.js';
import { loadHarnessRuntimeConfig } from './config.js';
import type { TokenUsage } from './events.js';
import { buildHarnessPatchForConfig } from './patch.js';
import { mapHarnessReport } from './report.js';
import { appendTrace, traceFromSessionEvent, type TraceEntry } from './trace.js';
import type { HarnessRunOutcome } from './runner.js';
import {
  cleanupRunDir,
  loadPersistedSession,
  reasoningOverrideFromEnv,
  runDirFor,
  sessionPathFor,
} from './runner.js';
import type { WorkerTask } from './types.js';

// ── Isolated multi-agent DSH runtime child (H6b phase 2/3) ──
// One child process boots the DSH app once and hosts N Agents concurrently.
// Every Agent mounts its own toolset from its `setup(agentCtx)` hook, so
// missions/tasks/roles never share traffic stores, evidence or report paths.
// The supervisor drives this process over the IPC channel.

const PROFILE = 'src-agent-runtime';

interface JobAgentConfig {
  role: 'worker' | 'planner';
  missionId: string;
  taskId: string;
  targetUrl: string;
  scope: WorkerTask['scope'];
  reportPath: string;
  proxyUrl: string;
  missionContextPath?: string;
  allowAllEgress?: boolean;
  skillsEnabled?: boolean;
  statePath?: string;
  planPath?: string;
  traceSearchEnabled?: boolean;
  requestDedupeMode?: 'off' | 'warn';
}

interface JobOptions {
  hints?: readonly string[];
  recoveryNote?: string;
  priorWork?: string;
  missionBrief?: string;
  missionContextPath?: string;
  sessionId?: string;
  keepRunDir?: boolean;
}

interface JobMessage {
  jobId: string;
  taskId: string;
  task: WorkerTask;
  agent: JobAgentConfig;
  skillsEnabled?: boolean;
  options?: JobOptions;
}

interface SessionEventLike {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

interface AgentLike {
  session: { seq: number };
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(cause: string, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

interface AgentsService {
  create(options: Record<string, unknown>): Promise<{ agent?: AgentLike }>;
  resume(options: Record<string, unknown>): Promise<{ agent?: AgentLike }>;
}

const inboxes = new Map<string, string[]>();
const hintRequests = new Map<string, (items: string[]) => void>();

function send(message: unknown): void {
  process.send?.(message);
}

function userMessage(text: string): unknown {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function assistantText(event: SessionEventLike): string {
  const message = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}

function inboxFor(jobId: string): string[] {
  let inbox = inboxes.get(jobId);
  if (!inbox) {
    inbox = [];
    inboxes.set(jobId, inbox);
  }
  return inbox;
}

function requestHints(jobId: string, timeoutMs = 5_000): Promise<string[]> {
  const requestId = `${jobId}:${randomUUID()}`;
  return new Promise<string[]>(resolve => {
    const timer = setTimeout(() => {
      hintRequests.delete(requestId);
      resolve([]);
    }, timeoutMs);
    hintRequests.set(requestId, items => {
      clearTimeout(timer);
      hintRequests.delete(requestId);
      resolve(items);
    });
    send({ type: 'request-hints', jobId, id: requestId });
  });
}

function launchEnvironment(): {
  get(name: string): { value: string; source: 'process' } | undefined;
  getFrom(name: string, sources: readonly string[]): { value: string; source: 'process' } | undefined;
} {
  return {
    get: (name: string) => (process.env[name] === undefined ? undefined : { value: String(process.env[name]), source: 'process' }),
    getFrom: (name: string, sources: readonly string[]) =>
      sources.includes('process') && process.env[name] !== undefined
        ? { value: String(process.env[name]), source: 'process' }
        : undefined,
  };
}

async function ensureProfile(home: string): Promise<void> {
  const dir = join(home, 'profiles', PROFILE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
}

function toPluginConfig(job: JobMessage): PluginConfig {
  if (job.agent.role === 'planner') {
    const runDir = runDirFor(job.taskId);
    return {
      role: 'planner',
      statePath: job.agent.statePath ?? join(runDir, 'planner-state.json'),
      planPath: job.agent.planPath ?? join(runDir, 'plan.json'),
    };
  }
  return {
    role: 'worker',
    missionId: job.agent.missionId,
    taskId: job.agent.taskId,
    targetUrl: job.agent.targetUrl,
    scope: job.agent.scope,
    proxyUrl: job.agent.proxyUrl,
    reportPath: job.agent.reportPath,
    ...(job.agent.missionContextPath ? { missionContextPath: job.agent.missionContextPath } : {}),
    ...(process.env.SRC_AGENT_MISSION_API_URL?.trim() ? { missionApiUrl: process.env.SRC_AGENT_MISSION_API_URL.trim().replace(/\/+$/, '') } : {}),
    ...(process.env.SRC_AGENT_MISSION_API_TOKEN?.trim() ? { missionApiToken: process.env.SRC_AGENT_MISSION_API_TOKEN.trim() } : {}),
    traceSearchEnabled: job.agent.traceSearchEnabled !== false,
    requestDedupeMode: job.agent.requestDedupeMode ?? (process.env.REQUEST_DEDUPE_MODE === 'off' ? 'off' : 'warn'),
    allowAllEgress: job.agent.allowAllEgress ?? false,
    browserEnabled: process.env.SRC_AGENT_BROWSER_ENABLED === '1',
    ...(process.env.SRC_AGENT_BROWSER_ENABLED === '1' ? {
      browserServiceUrl: (process.env.BROWSER_SERVICE_URL?.trim() || 'http://browser:9401').replace(/\/+$/, ''),
      browserServiceToken: process.env.BROWSER_SERVICE_TOKEN?.trim() || 'dev-browser-token',
    } : {}),
    reverseEnabled: process.env.SRC_AGENT_REVERSE_ENABLED === '1',
    ...(process.env.SRC_AGENT_REVERSE_ENABLED === '1' ? {
      reverseServiceUrl: (process.env.REVERSE_SERVICE_URL?.trim() || 'http://reverse:9402').replace(/\/+$/, ''),
      reverseServiceToken: process.env.REVERSE_SERVICE_TOKEN?.trim() || 'dev-reverse-token',
    } : {}),
  };
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

async function runOneJob(ctx: any, job: JobMessage): Promise<HarnessRunOutcome> {
  const agents = ctx.get('agents') as AgentsService | undefined;
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection?: () => Record<string, unknown> } | undefined;
  const tokenMeter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { totalTokens?: number; surfaceTokens?: number } } | undefined;
  if (!agents) throw new Error('runtime child: ctx.agents service missing');

  const jobId = job.jobId;
  const taskId = job.taskId;
  const task = job.task;
  const options = job.options ?? {};
  const runDir = runDirFor(taskId);
  const workspace = join(runDir, 'workspace');
  await mkdir(workspace, { recursive: true });

  // Prepare this agent's isolated toolset, then mount it synchronously in setup.
  const pluginConfig = toPluginConfig(job);
  const toolset: AgentToolset = pluginConfig.role === 'planner'
    ? createPlannerToolset(pluginConfig)
    : await createAgentToolset(pluginConfig);

  const persisted = await loadPersistedSession(taskId);
  const sessionId = options.sessionId ?? persisted ?? `session-${randomUUID()}`;
  const selection = defaultModel?.currentSelection?.() ?? {};
  const agentOptions = { ...selection };
  const setup = (agentCtx: unknown): void => {
    const ctxTools = (agentCtx as { tools?: { register?: unknown } }).tools;
    const toolCount = toolset.tools ? (Object.keys(toolset.tools).length + (toolset.browserTools ? Object.keys(toolset.browserTools.tools).length : 0) + (toolset.reverseTools ? Object.keys(toolset.reverseTools.tools).length : 0)) : toolset.plannerTools ? Object.keys(toolset.plannerTools).length : 0;
    console.error(`[harness ${taskId}] setup: role=${pluginConfig.role} ctxTools=${Boolean(ctxTools)} toolCount=${toolCount}`);
    mountToolset(agentCtx as never, toolset);
    console.error(`[harness ${taskId}] setup: toolset mounted`);
  };

  let created: { agent?: AgentLike };
  try {
    created = persisted || options.sessionId
      ? await agents.resume({ sessionId, meta: { cwd: workspace }, agentOptions, setup })
      : await agents.create({ sessionId, meta: { cwd: workspace }, agentOptions, setup });
  } catch {
    created = await agents.create({ sessionId, meta: { cwd: workspace }, agentOptions, setup });
  }
  const agent = created.agent;
  if (!agent) throw new Error('runtime child: agent creation returned no handle');
  console.error(`[harness ${taskId}] agent created session=${sessionId}`);

  let steps = 0;
  let toolCalls = 0;
  let finalText = '';
  let turnReason: { kind?: string } | undefined;
  let runtimeError: unknown;
  let limitReason: string | undefined;
  let running = true;
  let steeredHints = 0;
  const trace: TraceEntry[] = [];
  let traceSeq = 0;
  const on = (ctx as { on: (event: string, listener: (first: unknown, second: unknown) => void) => () => void }).on.bind(ctx) as
    (event: string, listener: (first: unknown, second: unknown) => void) => () => void;

  const unsubscribe = on('session/event', (session, rawEvent) => {
    if (session !== (agent as unknown as { session: unknown }).session) return;
    const event = rawEvent as SessionEventLike;
    appendTrace(trace, traceFromSessionEvent({ type: event.type, data: event.data }, traceSeq));
    traceSeq += 1;
    if (event.type === 'step/end') steps += 1;
    else if (event.type === 'tool/call') toolCalls += 1;
    else if (event.type === 'assistant/message') {
      const text = assistantText(event);
      if (text) finalText = text;
    } else if (event.type === 'turn/end') {
      turnReason = (event.data as { reason?: { kind?: string } }).reason;
    }
  });
  const stopErrors = on('agent/error', payload => {
    const errorPayload = payload as { agent?: unknown; error?: unknown };
    if (errorPayload.agent === (agent as unknown as object)) runtimeError = errorPayload.error;
  });

  const drainHints = (): void => {
    const inbox = inboxFor(jobId);
    for (;;) {
      if (!running || inbox.length === 0) break;
      const hint = inbox.shift();
      if (hint === undefined) break;
      try {
        agent.steer(userMessage(`[control-plane hint] ${hint}`));
        steeredHints += 1;
        console.log(`[harness ${taskId}] steered a control-plane hint mid-run`);
      } catch (error) {
        console.error(`[harness ${taskId}] steer failed: ${String(error)}`);
      }
    }
  };
  const hintTimer = setInterval(drainHints, 250);
  hintTimer.unref?.();
  const progressTimer = setInterval(() => {
    send({ type: 'progress', jobId, steps, toolCalls, hintsSteered: steeredHints });
  }, 1_000);
  progressTimer.unref?.();

  const startedAt = Date.now();
  const watchdog = setInterval(() => {
    if (!running || limitReason) return;
    const overTime = task.maxWallClockMs > 0 && Date.now() - startedAt > task.maxWallClockMs;
    const overSteps = task.maxSteps > 0 && steps > task.maxSteps;
    if (!overTime && !overSteps) return;
    limitReason = overTime ? 'run_timeout' : 'step_limit_exceeded';
    console.log(`[harness ${taskId}] in-process limit reached (${limitReason}); cancelling agent`);
    try {
      agent.cancel(limitReason, { keepInbox: true });
    } catch (error) {
      console.error(`[harness ${taskId}] cancel failed: ${String(error)}`);
    }
    clearInterval(watchdog);
  }, 500);
  watchdog.unref?.();

  const assignment = buildAssignmentPrompt(task, options.hints ?? [], {
    skillsEnabled: job.skillsEnabled !== false,
    priorWork: options.priorWork,
  });
  if (options.priorWork) {
    appendTrace(trace, {
      seq: traceSeq,
      type: 'context',
      payload: { source: 'prior_work', text: options.priorWork.slice(0, 6_000) },
      ts: new Date().toISOString(),
    });
    traceSeq += 1;
  }
  agent.followup(userMessage(options.recoveryNote ? `${assignment}\n\n${options.recoveryNote}` : assignment));
  await agent.whenIdle();
  running = false;
  clearInterval(watchdog);
  clearInterval(hintTimer);
  clearInterval(progressTimer);

  let settled = false;
  if (limitReason) {
    settled = true;
    const fresh = await requestHints(jobId);
    const settlementHints = [...(options.hints ?? []), ...fresh];
    console.log(`[harness ${taskId}] in-process settlement pass after ${limitReason}`);
    try {
      agent.followup(userMessage(buildSettlementPrompt(settlementHints)));
      await agent.whenIdle();
    } catch (error) {
      runtimeError = runtimeError ?? error;
    }
  }

  unsubscribe();
  stopErrors();
  await writeFile(sessionPathFor(runDir), JSON.stringify({ sessionId }), 'utf8').catch(() => undefined);

  let tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };
  try {
    const measurement = tokenMeter?.measure?.(agent.session);
    if (measurement) {
      tokenUsage = {
        input: Number(measurement.surfaceTokens ?? 0),
        output: 0,
        total: Number(measurement.totalTokens ?? 0),
      };
    }
  } catch {
    // advisory only
  }

  appendTrace(trace, { seq: traceSeq, type: 'final', payload: { text: finalText.slice(0, 6_000), limitReason: limitReason ?? null } });
  let outcome: HarnessRunOutcome;
  if (pluginConfig.role === 'planner') {
    // Planner jobs return the submitted plan text; the supervisor/orchestrator
    // validates and applies it. No tool report file is involved.
    let planText = '';
    try {
      planText = await readFile(pluginConfig.planPath, 'utf8');
    } catch {
      planText = '';
    }
    outcome = {
      completed: planText.length > 0 && !limitReason,
      failureClass: planText.length > 0 && !limitReason ? undefined : limitReason ?? (runtimeError ? 'model_error' : 'no_progress'),
      artifacts: [],
      evidence: [],
      findings: [],
      assets: [],
      sessionId,
      steps,
      tokenUsage,
      finalText: planText || finalText,
      error: runtimeError ? String(runtimeError) : planText ? undefined : 'planner did not submit a plan',
      settled,
      chunks: 1,
      trace,
      limitReason,
    };
  } else {
    try {
      const report = JSON.parse(await readFile(pluginConfig.reportPath, 'utf8')) as unknown;
      const mapped = mapHarnessReport(report, task.missionId, taskId);
      // ADR-0012: a task is done when the agent run terminates normally without
      // a limit or runtime error. Artifact count is a quality metric only.
      const completed = !limitReason && !runtimeError && turnReason?.kind !== 'error';
      outcome = {
        completed,
        failureClass: completed ? undefined : limitReason ?? (runtimeError || turnReason?.kind === 'error' ? 'model_error' : 'no_progress'),
        artifacts: mapped.artifacts,
        evidence: mapped.evidence,
        findings: mapped.findings,
        assets: mapped.assets,
        sessionId,
        steps,
        tokenUsage,
        finalText,
        error: runtimeError ? String(runtimeError) : undefined,
        settled,
        chunks: 1,
        trace,
        limitReason,
      };
    } catch (parseError) {
      outcome = {
        completed: false,
        failureClass: limitReason ?? (runtimeError ? 'model_error' : 'tool_error'),
        artifacts: [],
        evidence: [],
        findings: [],
        assets: [],
        sessionId,
        steps,
        tokenUsage,
        finalText,
        error: `${String(parseError)}${runtimeError ? `\n${String(runtimeError)}` : ''}`.slice(0, 4_000),
        settled,
        chunks: 1,
        trace,
        limitReason,
      };
    }
    if (outcome.completed && options.keepRunDir !== true && process.env.SRC_AGENT_KEEP_RUN !== '1') {
      await cleanupRunDir(taskId);
    }
  }

  console.error(
    `[harness ${taskId}] in-process run: steps=${steps} tools=${toolCalls} hints=${steeredHints} ` +
      `completed=${outcome.completed} settled=${settled} text=${finalText.slice(0, 120)}`,
  );
  return outcome;
}

async function bootAndRunBatch(payload: { jobs?: JobMessage[] }): Promise<void> {
  const base = `/tmp/src-agent-runtime-child-${process.pid}`;
  process.env.DSH_HOME = join(base, 'dsh-home');
  process.env.NARB_DISABLE_NATIVE_CACHE = '1';
  process.env.DSH_PERMISSION_MODE = 'danger-full-access';
  // In multi-agent mode the globally-mounted plugin must stay inert: all
  // mission configuration comes from each job and is mounted per Agent.
  delete process.env.SRC_AGENT_MISSION_ID;
  delete process.env.SRC_AGENT_TASK_ID;
  delete process.env.SRC_AGENT_TARGET_URL;
  delete process.env.SRC_AGENT_SCOPE_JSON;
  delete process.env.SRC_AGENT_REPORT_PATH;
  delete process.env.SRC_AGENT_ROLE;
  await mkdir(base, { recursive: true });
  await ensureProfile(process.env.DSH_HOME);
  const config = loadHarnessRuntimeConfig();
  const patchPath = join(base, 'patch.json');
  await writeFile(patchPath, buildHarnessPatchForConfig(config, reasoningOverrideFromEnv(process.env)), 'utf8');

  let booted: Awaited<ReturnType<typeof runProfile>> | undefined;
  try {
    booted = await runProfile({ environment: launchEnvironment(), profile: PROFILE, patchFiles: [patchPath], args: [] });
    const jobs = payload.jobs ?? [];
    await Promise.all(jobs.map(async job => {
      try {
        const outcome = await runOneJob(booted?.ctx, job);
        send({ type: 'result', jobId: job.jobId, outcome });
      } catch (error) {
        send({ type: 'result', jobId: job.jobId, outcome: failureOutcome('runtime_crash', String(error)) });
      }
    }));
    send({ type: 'batch-done' });
  } catch (error) {
    send({ type: 'batch-error', error: String(error) });
  } finally {
    try {
      await booted?.shutdown.shutdown(0);
    } catch {
      // shutdown noise
    }
    setTimeout(() => process.exit(0), 50);
  }
}

process.on('message', message => {
  const payload = message as {
    type?: string;
    jobId?: string;
    id?: string;
    text?: string;
    items?: string[];
    jobs?: JobMessage[];
  };
  if (payload.type === 'hint' && payload.jobId && payload.text) {
    inboxFor(payload.jobId).push(payload.text);
    return;
  }
  if (payload.type === 'hints' && payload.id) {
    hintRequests.get(payload.id)?.(payload.items ?? []);
    return;
  }
  if (payload.type === 'start-batch') {
    void bootAndRunBatch({ jobs: payload.jobs });
  }
});
