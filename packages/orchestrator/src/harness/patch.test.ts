import { describe, expect, it } from 'vitest';
import { MODEL_ROUTE_ID, buildHarnessPatch } from './patch.js';

describe('buildHarnessPatch', () => {
  const patchText = buildHarnessPatch({
    pluginPath: '/app/packages/harness-plugin/dist/index.js',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'LLM_API_KEY',
    model: 'deepseek-flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 393_216,
    skillsDir: '/app/skills',
    leanToolset: true,
    skillsEnabled: true,
    compat: { thinkingFormat: 'deepseek' },
  });
  const patch = JSON.parse(patchText) as Array<Record<string, unknown>>;

  it('mounts the CkSKILLS root through skill-filesystem', () => {
    expect(patch[0]).toEqual({
      id: 'skill-filesystem',
      config: { includeDefaultRoots: false, customSkillDirs: ['/app/skills'], watch: false },
    });
  });

  it('mounts the SRC-Agent plugin by absolute path', () => {
    expect(patch[1]).toEqual({
      insert: [{ id: 'src-agent-tools', name: '/app/packages/harness-plugin/dist/index.js' }],
    });
  });

  it('disables planner-only tool plugins for the lean worker', () => {
    for (const id of ['goal', 'tool-goal', 'plan-mode', 'tool-workflow', 'tool-pwsh']) {
      expect(patch).toContainEqual({ id, disabled: true });
    }
    expect(patch).not.toContainEqual({ id: 'subagent', disabled: true });
    expect(patch).not.toContainEqual({ id: 'tool-subagent', disabled: true });
  });

  it('keeps the full toolset when lean mode is off', () => {
    const full = JSON.parse(
      buildHarnessPatch({
        pluginPath: '/p.js', baseUrl: 'https://x/v1', apiKeyEnv: 'K', model: 'm',
        contextWindow: 1_000_000, maxOutputTokens: 393_216, skillsDir: '/app/skills', leanToolset: false, skillsEnabled: true,
      }),
    ) as Array<Record<string, unknown>>;
    expect(full).not.toContainEqual({ id: 'goal', disabled: true });
    expect(full).toContainEqual({ id: 'tool-web', disabled: true });
  });

  it('disables Harness web tools and the native DeepSeek adapter', () => {
    expect(patch).toContainEqual({ id: 'tool-web', disabled: true });
    expect(patch).toContainEqual({ id: 'llm-deepseek', disabled: true });
  });

  it('routes the model through an OpenAI-compatible provider', () => {
    const piAi = patch.find(entry => entry.id === 'llm-pi-ai') as {
      config: { providers: Record<string, Record<string, unknown>> };
    };
    const provider = piAi.config.providers[MODEL_ROUTE_ID];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseURL).toBe('https://api.deepseek.com/v1');
    expect(provider.apiKeyEnv).toBe('LLM_API_KEY');
    expect(provider.models).toEqual([
      { id: 'deepseek-flash', name: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 393_216 },
    ]);
    expect(provider.defaultContextWindow).toBe(1_000_000);
    expect(provider.defaultMaxTokens).toBe(393_216);
    expect(provider.compat).toEqual({ thinkingFormat: 'deepseek' });
    expect(patch).toContainEqual({
      id: 'agent-default-model',
      config: { provider: MODEL_ROUTE_ID, model: 'deepseek-flash' },
    });
  });

  it('adds reasoning declarations only when provided', () => {
    const withReasoning = JSON.parse(
      buildHarnessPatch({
        pluginPath: '/p.js',
        baseUrl: 'https://x/v1',
        apiKeyEnv: 'K',
        model: 'm',
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        skillsDir: '/app/skills',
        leanToolset: true,
        skillsEnabled: true,
        reasoningEffort: 'max',
        reasoningEfforts: { off: 'none', max: 'max' },
      }),
    ) as Array<Record<string, unknown>>;
    const piAi = withReasoning.find(entry => entry.id === 'llm-pi-ai') as {
      config: { providers: Record<string, { reasoning?: string; models: Array<Record<string, unknown>> }> };
    };
    expect(piAi.config.providers[MODEL_ROUTE_ID].reasoning).toBe('max');
    expect(piAi.config.providers[MODEL_ROUTE_ID].models[0].reasoningEfforts).toEqual({ off: 'none', max: 'max' });
  });
});

describe('buildHarnessPatch without skills', () => {
  it('disables the skill catalog and skill tool for the control group', () => {
    const patch = JSON.parse(
      buildHarnessPatch({
        pluginPath: '/p.js', baseUrl: 'https://x/v1', apiKeyEnv: 'K', model: 'm',
        contextWindow: 1_000_000, maxOutputTokens: 393_216, skillsDir: '/app/skills',
        leanToolset: true, skillsEnabled: false,
      }),
    ) as Array<Record<string, unknown>>;
    expect(patch).toContainEqual({ id: 'skill-filesystem', disabled: true });
    expect(patch).toContainEqual({ id: 'tool-skill', disabled: true });
    expect(patch.some(entry => entry.id === 'skill-filesystem' && 'config' in entry)).toBe(false);
  });
});
