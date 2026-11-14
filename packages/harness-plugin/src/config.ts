import {
  GrantScopeSchema,
  type GrantScope,
} from '@src-agent/contracts';

// ── Plugin configuration ────────────────────────────────────
// Everything mission-specific arrives through environment variables from the
// worker process. The Harness profile patch only mounts the plugin; it carries
// no mission data, so one image can run any authorized task.

export interface WorkerPluginConfig {
  role: 'worker';
  missionId: string;
  taskId: string;
  targetUrl: string;
  scope: GrantScope;
  proxyUrl: string;
  reportPath: string;
  /** M5: run-local mission context file written by the worker before claim. */
  missionContextPath?: string;
  /** M5-4: control-plane read API for dynamic cross-worker trace search. */
  missionApiUrl?: string;
  missionApiToken?: string;
  /** M5-4: register the dynamic cross-worker trace tool (default true). */
  traceSearchEnabled: boolean;
  /** Temporary open-egress mode: skip the client-side target scope gate. */
  allowAllEgress: boolean;
  /** Summary/补漏 task: read-only mission review, no target tools. */
  summary?: boolean;
  summaryPath?: string;
  /** Optional request-index snapshot for advisory cross-task dedupe. */
  requestIndexPath?: string;
  /** Runtime setting: emit advisory dedupe notes (`off` disables them). */
  requestDedupeMode?: 'off' | 'warn';
  /** Isolated Playwright browser service. Disabled unless explicitly enabled. */
  browserEnabled?: boolean;
  browserServiceUrl?: string;
  browserServiceToken?: string;
  /** Offline JADX/ASC/Hermes reverse capability service. */
  reverseEnabled?: boolean;
  reverseServiceUrl?: string;
  reverseServiceToken?: string;
}

/** Planner runs get control-plane read/submit tools only — never target tools. */
export interface PlannerPluginConfig {
  role: 'planner';
  statePath: string;
  planPath: string;
}

export type PluginConfig = WorkerPluginConfig | PlannerPluginConfig;

const DEFAULT_PROXY_URL = 'http://proxy:8080';
const DEFAULT_REPORT_PATH = '/tmp/src-agent-report.json';

/**
 * Reads the plugin configuration from the environment. Returns null when the
 * process is not running a mission (for example a bare `dsh` health check), in
 * which case the plugin registers no mission tools instead of failing boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig | null {
  const role = env.SRC_AGENT_ROLE?.trim() === 'planner' ? 'planner' : 'worker';
  if (role === 'planner') {
    const statePath = env.SRC_AGENT_PLANNER_STATE_PATH?.trim();
    const planPath = env.SRC_AGENT_PLANNER_PLAN_PATH?.trim();
    if (!statePath || !planPath) {
      throw new Error(
        'planner configuration requires SRC_AGENT_PLANNER_STATE_PATH and SRC_AGENT_PLANNER_PLAN_PATH',
      );
    }
    return { role, statePath, planPath };
  }
  const summary = env.SRC_AGENT_TASK_KIND?.trim() === 'summary';
  const missionId = env.SRC_AGENT_MISSION_ID?.trim();
  const taskId = env.SRC_AGENT_TASK_ID?.trim();
  const targetUrl = env.SRC_AGENT_TARGET_URL?.trim();
  const scopeJson = env.SRC_AGENT_SCOPE_JSON?.trim();
  if (!missionId && !taskId && !targetUrl && !scopeJson) {
    return null;
  }
  if (!missionId || !taskId || !targetUrl || !scopeJson) {
    throw new Error(
      'incomplete SRC-Agent plugin configuration: SRC_AGENT_MISSION_ID, SRC_AGENT_TASK_ID, SRC_AGENT_TARGET_URL and SRC_AGENT_SCOPE_JSON are required together',
    );
  }

  let rawScope: unknown;
  try {
    rawScope = JSON.parse(scopeJson);
  } catch {
    throw new Error('SRC_AGENT_SCOPE_JSON is not valid JSON');
  }

  return {
    role: 'worker',
    missionId,
    taskId,
    targetUrl: targetUrl.replace(/\/+$/, ''),
    scope: GrantScopeSchema.parse(rawScope),
    proxyUrl: env.SRC_AGENT_PROXY_URL?.trim() || env.PROXY_URL?.trim() || DEFAULT_PROXY_URL,
    reportPath: env.SRC_AGENT_REPORT_PATH?.trim() || DEFAULT_REPORT_PATH,
    ...(env.SRC_AGENT_MISSION_CONTEXT_PATH?.trim() ? { missionContextPath: env.SRC_AGENT_MISSION_CONTEXT_PATH.trim() } : {}),
    ...(env.SRC_AGENT_MISSION_API_URL?.trim() ? { missionApiUrl: env.SRC_AGENT_MISSION_API_URL.trim().replace(/\/+$/, '') } : {}),
    ...(env.SRC_AGENT_MISSION_API_TOKEN?.trim() ? { missionApiToken: env.SRC_AGENT_MISSION_API_TOKEN.trim() } : {}),
    traceSearchEnabled: env.SRC_AGENT_TRACE_SEARCH_ENABLED !== '0',
    allowAllEgress: env.EGRESS_MODE?.trim().toLowerCase() === 'open' || env.SRC_AGENT_ALLOW_ALL_EGRESS === '1',
    ...(summary ? { summary: true } : {}),
    ...(summary ? { summaryPath: env.SRC_AGENT_SUMMARY_PATH?.trim() || '/tmp/src-agent-summary.json' } : {}),
    ...(env.SRC_AGENT_REQUEST_INDEX_PATH?.trim() ? { requestIndexPath: env.SRC_AGENT_REQUEST_INDEX_PATH.trim() } : {}),
    requestDedupeMode: env.REQUEST_DEDUPE_MODE?.trim() === 'off' ? 'off' : 'warn',
    browserEnabled: env.SRC_AGENT_BROWSER_ENABLED === '1',
    ...(env.SRC_AGENT_BROWSER_ENABLED === '1' ? {
      browserServiceUrl: (env.BROWSER_SERVICE_URL?.trim() || 'http://browser:9401').replace(/\/+$/, ''),
      browserServiceToken: env.BROWSER_SERVICE_TOKEN?.trim() || 'dev-browser-token',
    } : {}),
    reverseEnabled: env.SRC_AGENT_REVERSE_ENABLED === '1',
    ...(env.SRC_AGENT_REVERSE_ENABLED === '1' ? {
      reverseServiceUrl: (env.REVERSE_SERVICE_URL?.trim() || 'http://reverse:9402').replace(/\/+$/, ''),
      reverseServiceToken: env.REVERSE_SERVICE_TOKEN?.trim() || 'dev-reverse-token',
    } : {}),
  };
}
