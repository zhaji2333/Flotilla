import type { HarnessRuntimeConfig } from './config.js';

// ── Runtime profile patch ───────────────────────────────────
// Generated per task (JSON is valid YAML, so the Harness launcher parses it as
// a normal patch overlay). It adds the SRC-Agent plugin, disables Harness' own
// web tools (evidence must come from our tools), and routes the model through
// the deployment's OpenAI-compatible endpoint instead of the native DeepSeek
// Messages adapter.

export const MODEL_ROUTE_ID = 'src-agent-openai';

/**
 * Harness tool plugins a worker does not need (the worker executes one
 * authorized task; it does not plan goals or run workflows). Subagent tools are
 * intentionally kept available so a Worker can split independent reconnaissance
 * into isolated child agents. Disabling the rest removes their prompt sections
 * and tool schemas from every step. Re-enable per profile when a Planner/skill
 * needs one.
 */
export const LEAN_DISABLED_PLUGINS: readonly string[] = [
  'goal',
  'tool-goal',
  'goal-round-driver',
  'command-goal',
  'plan-mode',
  'user-questions',
  'ptc-runtime',
  'workflow-ptc',
  'tool-workflow',
  'tool-cordis',
  'tool-plugin-manager',
  'tool-working-directory',
  'tool-pwsh',
  'pwsh-sandbox',
];

export interface PatchInput {
  pluginPath: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  skillsDir: string;
  leanToolset: boolean;
  skillsEnabled: boolean;
  compat?: Record<string, unknown>;
  disableShell?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  reasoningEfforts?: Record<string, string>;
}

export function buildHarnessPatch(input: PatchInput): string {
  const modelEntry: Record<string, unknown> = {
    id: input.model,
    name: input.model,
    contextWindow: input.contextWindow,
    maxTokens: input.maxOutputTokens,
  };
  if (input.reasoningEfforts && Object.keys(input.reasoningEfforts).length > 0) {
    modelEntry.reasoningEfforts = input.reasoningEfforts;
  }
  const provider: Record<string, unknown> = {
    displayName: 'SRC-Agent OpenAI-compatible model gateway',
    api: 'openai-completions',
    baseURL: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    defaultContextWindow: input.contextWindow,
    defaultMaxTokens: input.maxOutputTokens,
    models: [modelEntry],
  };
  if (input.compat) provider.compat = input.compat;
  if (input.reasoningEffort) provider.reasoning = input.reasoningEffort;

  // CkSKILLS packs are mounted from the image; the agent loads them on demand
  // through the built-in `skill` tool (catalog + body), starting with ck-router.
  const entries: unknown[] = input.skillsEnabled !== false
    ? [
        {
          id: 'skill-filesystem',
          config: {
            includeDefaultRoots: false,
            customSkillDirs: [input.skillsDir],
            watch: false,
          },
        },
        {
          insert: [
            { id: 'src-agent-tools', name: input.pluginPath },
          ],
        },
      ]
    : [
        // Control group for skill effect evaluation: no catalog, no skill tool.
        { id: 'skill-filesystem', disabled: true },
        { id: 'tool-skill', disabled: true },
        {
          insert: [
            { id: 'src-agent-tools', name: input.pluginPath },
          ],
        },
      ];
  // Target/internet egress and evidence capture belong to SRC-Agent tools.
  entries.push(
    { id: 'tool-web', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    {
      id: 'llm-pi-ai',
      config: { providers: { [MODEL_ROUTE_ID]: provider } },
    },
    {
      id: 'agent-default-model',
      config: { provider: MODEL_ROUTE_ID, model: input.model },
    },
  );
  if (input.leanToolset) {
    for (const id of LEAN_DISABLED_PLUGINS) {
      entries.push({ id, disabled: true });
    }
  }
  if (input.disableShell) {
    for (const id of ['tool-bash', 'tool-bash-persistent', 'tool-terminal']) {
      entries.push({ id, disabled: true });
    }
  }
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function buildHarnessPatchForConfig(
  config: HarnessRuntimeConfig,
  extra: { reasoningEffort?: 'low' | 'high' | 'max'; reasoningEfforts?: Record<string, string>; disableShell?: boolean } = {},
): string {
  return buildHarnessPatch({
    pluginPath: config.pluginPath,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    model: config.model,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    skillsDir: config.skillsDir,
    leanToolset: config.leanToolset,
    skillsEnabled: config.skillsEnabled,
    compat: config.compat,
    ...extra,
  });
}
