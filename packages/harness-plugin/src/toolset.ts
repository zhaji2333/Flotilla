import { readFile } from 'node:fs/promises';
import { ProxyAgent } from 'undici';
import type { Context } from '@deepseek-ai/cordis';
import { loadConfig, type PlannerPluginConfig, type PluginConfig, type WorkerPluginConfig } from './config.js';
import type { FindingRecord } from './findings.js';
import { buildPlannerTools } from './planner-tools.js';
import { buildMissionTools } from './mission-tools.js';
import { loadReportFile } from './report-file.js';
import { TrafficStore } from './store.js';
import { buildTools } from './tools.js';
import { buildBrowserTools, type BrowserTools } from './browser-tools.js';
import { buildReverseTools, type ReverseTools } from './reverse-tools.js';
import { buildSummaryTools } from './summary-tools.js';
import { registerCommandGuard } from './command-guard.js';
import type { RequestIndexEntry } from '@src-agent/contracts';

// ── Per-agent toolset (multi-agent safe) ───────────────────
// Every Agent gets its own config, TrafficStore, findings/artifacts set, report
// path and tool registrations. The in-process runtime pre-builds a toolset and
// mounts it from the Agent's `setup(agentCtx, agent)` hook, so one process can
// host several missions/tasks/roles without cross-contamination. CLI one-shot
// runs keep using environment configuration.

export interface AgentToolset {
  config: PluginConfig;
  store?: TrafficStore;
  findings?: FindingRecord[];
  artifacts?: Set<string>;
  tools?: ReturnType<typeof buildTools>;
  plannerTools?: ReturnType<typeof buildPlannerTools>;
  missionTools?: ReturnType<typeof buildMissionTools>;
  summaryTools?: ReturnType<typeof buildSummaryTools>;
  browserTools?: BrowserTools;
  reverseTools?: ReverseTools;
  persistReport: () => Promise<void>;
  dispose: () => Promise<void>;
}

/** Builds one isolated worker toolset bound to a single agent configuration. */
export async function createAgentToolset(config: WorkerPluginConfig): Promise<AgentToolset> {
  const store = new TrafficStore();
  const findings: FindingRecord[] = [];
  const artifacts = new Set<string>();

  const previous = await loadReportFile(config.reportPath);
  if (previous && previous.missionId === config.missionId && previous.taskId === config.taskId) {
    store.restore(previous.traffic ?? [], previous.assets ?? []);
    findings.push(...(previous.findings ?? []));
    for (const artifact of previous.artifacts ?? []) artifacts.add(artifact);
    console.error(
      `[src-agent] restored previous report: traffic=${store.records.length} findings=${findings.length} artifacts=${artifacts.size}`,
    );
  }

  if (config.summary) {
    const missionTools = config.missionContextPath || (config.traceSearchEnabled && config.missionApiUrl && config.missionApiToken)
      ? buildMissionTools(config)
      : undefined;
    return {
      config,
      store,
      findings,
      artifacts,
      missionTools,
      summaryTools: buildSummaryTools({ summaryPath: config.summaryPath ?? '/tmp/src-agent-summary.json' }),
      persistReport: async () => undefined,
      dispose: async () => undefined,
    };
  }
  let requestIndex: RequestIndexEntry[] = [];
  if (config.requestIndexPath) {
    try {
      const parsed = JSON.parse(await readFile(config.requestIndexPath, 'utf8'));
      if (Array.isArray(parsed)) requestIndex = parsed as RequestIndexEntry[];
    } catch {
      // no index snapshot is a normal first-task condition
    }
  }
  const dispatcher = new ProxyAgent(config.proxyUrl);
  const tools = buildTools({ config, store, findings, artifacts, dispatcher, requestIndex });
  const browserTools = config.browserEnabled
    ? buildBrowserTools({ config, store, persistReport: tools.persistReport })
    : undefined;
  const reverseTools = config.reverseEnabled
    ? buildReverseTools({ config })
    : undefined;
  const missionTools = config.missionContextPath || (config.traceSearchEnabled && config.missionApiUrl && config.missionApiToken) ? buildMissionTools(config) : undefined;
  return {
    config,
    store,
    findings,
    artifacts,
    tools,
    browserTools,
    reverseTools,
    missionTools,
    persistReport: tools.persistReport,
    dispose: async () => {
      await browserTools?.dispose().catch(() => undefined);
      await reverseTools?.dispose().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
    },
  };
}

/** Planner toolset: control-plane snapshot + submit_plan only, no target tools. */
export function createPlannerToolset(config: PlannerPluginConfig): AgentToolset {
  return {
    config,
    plannerTools: buildPlannerTools(config),
    persistReport: async () => undefined,
    dispose: async () => undefined,
  };
}

/** Mounts a prepared toolset on one Agent's scoped context (synchronous). */
export function mountToolset(ctx: Context, toolset: AgentToolset): void {
  if (toolset.plannerTools) {
    ctx.tools.register(toolset.plannerTools.readMissionState);
    ctx.tools.register(toolset.plannerTools.submitPlan);
    return;
  }
  if (toolset.summaryTools) {
    if (toolset.missionTools) {
      ctx.tools.register(toolset.missionTools.missionBrief);
      ctx.tools.register(toolset.missionTools.missionRecall);
      ctx.tools.register(toolset.missionTools.missionFrontier);
      ctx.tools.register(toolset.missionTools.missionFact);
      ctx.tools.register(toolset.missionTools.missionFindings);
      ctx.tools.register(toolset.missionTools.missionAssets);
    }
    ctx.tools.register(toolset.summaryTools.submitSummary);
    return;
  }
  const tools = toolset.tools;
  if (!tools) throw new Error('worker toolset has no tools');
  ctx.tools.register(tools.httpRequest);
  ctx.tools.register(tools.webFetch);
  ctx.tools.register(tools.webSearch);
  ctx.tools.register(tools.githubFetch);
  ctx.tools.register(tools.trafficSearch);
  ctx.tools.register(tools.trafficGet);
  ctx.tools.register(tools.trafficBlob);
  ctx.tools.register(tools.insertAssets);
  ctx.tools.register(tools.listAssets);
  ctx.tools.register(tools.reportFinding);
  if (toolset.browserTools) {
    for (const tool of Object.values(toolset.browserTools.tools)) ctx.tools.register(tool);
  }
  if (toolset.reverseTools) {
    for (const tool of Object.values(toolset.reverseTools.tools)) ctx.tools.register(tool);
  }
  if (toolset.missionTools) {
    ctx.tools.register(toolset.missionTools.missionBrief);
    ctx.tools.register(toolset.missionTools.missionRecall);
    ctx.tools.register(toolset.missionTools.missionFrontier);
    ctx.tools.register(toolset.missionTools.missionFact);
    ctx.tools.register(toolset.missionTools.missionFindings);
    if (toolset.config.role === 'worker' && toolset.config.traceSearchEnabled) {
      ctx.tools.register(toolset.missionTools.searchWorkerTraces);
    }
    ctx.tools.register(toolset.missionTools.missionAssets);
  }
  ctx.effect(() => () => {
    void toolset.dispose();
  });
}

/** Prepares and mounts an agent toolset on the given (agent-scoped) context. */
export async function registerAgentTools(ctx: Context, config: PluginConfig): Promise<AgentToolset> {
  const toolset = config.role === 'planner'
    ? createPlannerToolset(config)
    : await createAgentToolset(config);
  mountToolset(ctx, toolset);
  if (config.role === 'worker' && !config.summary) registerCommandGuard(ctx, config.proxyUrl, { missionId: config.missionId, taskId: config.taskId });
  await toolset.persistReport();
  if (config.role === 'planner') {
    console.error(`[src-agent] planner tools ready state=${config.statePath} plan=${config.planPath}`);
  } else {
    console.error(
      `[src-agent] tools ready mission=${config.missionId} task=${config.taskId} target=${config.targetUrl} report=${config.reportPath}`,
    );
  }
  return toolset;
}

/** Global/CLI registration path: one process, one mission from the environment. */
export async function registerEnvironmentTools(ctx: Context): Promise<AgentToolset | null> {
  const config = loadConfig();
  if (!config) {
    console.error('[src-agent] no mission configuration; target tools are not registered');
    return null;
  }
  return await registerAgentTools(ctx, config);
}

export type { PluginConfig, WorkerPluginConfig, PlannerPluginConfig };
