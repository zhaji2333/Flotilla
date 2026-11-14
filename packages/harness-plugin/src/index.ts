import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
import { registerEnvironmentTools } from './toolset.js';

// ── SRC-Agent Harness plugin ────────────────────────────────
// Mounted into a DeepSeek Harness profile by `cordis.patch.yml`. It adds the
// target-facing tools that must stay inside SRC-Agent's security/evidence
// boundary; Harness' own agent loop, context compaction, skills, subagents and
// MCP client stay untouched.
//
// CLI one-shot runs keep using environment configuration. The in-process
// runtime calls `registerAgentTools(agentCtx, config)` from each Agent's setup
// hook so one process can host multiple missions/tasks/roles safely.

export const name = 'src-agent-tools';
export const inject = ['tools'];

export async function apply(ctx: Context): Promise<void> {
  await registerEnvironmentTools(ctx);
}

export { loadConfig } from './config.js';
export {
  registerAgentTools,
  registerEnvironmentTools,
  createAgentToolset,
  createPlannerToolset,
  mountToolset,
} from './toolset.js';
export type { AgentToolset } from './toolset.js';
export type { PluginConfig };
export type { WorkerPluginConfig, PlannerPluginConfig } from './config.js';
export { registerCommandGuard, guardCommand, classifyCommand } from './command-guard.js';
