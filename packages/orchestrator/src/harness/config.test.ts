import { describe, expect, it } from 'vitest';
import { applyModelOverride, loadHarnessRuntimeConfig, MODEL_OVERRIDE_KEY_ENV, normalizeOpenAiBaseUrl } from './config.js';

describe('normalizeOpenAiBaseUrl', () => {
  it('appends the /v1 root to a bare origin', () => {
    expect(normalizeOpenAiBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1');
    expect(normalizeOpenAiBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1');
  });
  it('keeps explicit API roots and trailing-slash trimming', () => {
    expect(normalizeOpenAiBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1');
    expect(normalizeOpenAiBaseUrl('http://gateway.local:8080/openai/v1')).toBe('http://gateway.local:8080/openai/v1');
  });
  it('rejects invalid or non-http bases', () => {
    expect(() => normalizeOpenAiBaseUrl('')).toThrow();
    expect(() => normalizeOpenAiBaseUrl('ftp://example.com')).toThrow();
    expect(() => normalizeOpenAiBaseUrl('https://example.com/v1?x=1')).toThrow();
  });
});

describe('loadHarnessRuntimeConfig', () => {
  it('reads model, key reference and optional compat from the environment', () => {
    const config = loadHarnessRuntimeConfig({
      LLM_MODEL: 'my-model',
      LLM_BASE_URL: 'https://gateway.example/v1',
      LLM_API_KEY_ENV: 'MY_GATEWAY_KEY',
      LLM_COMPAT_JSON: '{"thinkingFormat":"deepseek"}',
      SRC_AGENT_DSH_BIN: '/dsh/bin.js',
      LLM_CONTEXT_WINDOW: '1000000',
      LLM_MAX_OUTPUT_TOKENS: '393216',
      SRC_AGENT_HARNESS_PLUGIN_PATH: '/plugin/index.js',
    });
    expect(config.model).toBe('my-model');
    expect(config.baseUrl).toBe('https://gateway.example/v1');
    expect(config.apiKeyEnv).toBe('MY_GATEWAY_KEY');
    expect(config.compat).toEqual({ thinkingFormat: 'deepseek' });
    expect(config.dshBinPath).toBe('/dsh/bin.js');
    expect(config.pluginPath).toBe('/plugin/index.js');
    expect(config.contextWindow).toBe(1_000_000);
    expect(config.maxOutputTokens).toBe(393_216);
    expect(config.skillsDir).toBe('/app/skills');
    expect(config.leanToolset).toBe(true);
  });

  it('uses the required 1M context / 384K output defaults', () => {
    const config = loadHarnessRuntimeConfig({
      LLM_MODEL: 'm',
      SRC_AGENT_DSH_BIN: '/dsh/bin.js',
      SRC_AGENT_HARNESS_PLUGIN_PATH: '/plugin/index.js',
    });
    expect(config.contextWindow).toBe(1_000_000);
    expect(config.maxOutputTokens).toBe(393_216);
    expect(config.skillsDir).toBe('/app/skills');
    expect(config.leanToolset).toBe(true);
  });

  it('applies a DB model profile override without mutating the base config', () => {
    const base = loadHarnessRuntimeConfig({
      LLM_MODEL: 'env-model',
      LLM_BASE_URL: 'https://env.example.com/v1',
      SRC_AGENT_DSH_BIN: '/dsh/bin.js',
      SRC_AGENT_HARNESS_PLUGIN_PATH: '/plugin/index.js',
    });
    const overridden = applyModelOverride(base, {
      baseUrl: 'https://db.example.com/v1/',
      apiKey: 'sk-db-secret',
      model: 'deepseek-flash-db',
      contextWindow: 2_000_000,
      maxOutputTokens: 128_000,
      compat: { thinkingFormat: 'deepseek' },
    });
    expect(overridden.baseUrl).toBe('https://db.example.com/v1');
    expect(overridden.model).toBe('deepseek-flash-db');
    expect(overridden.apiKeyEnv).toBe(MODEL_OVERRIDE_KEY_ENV);
    expect(overridden.contextWindow).toBe(2_000_000);
    expect(overridden.maxOutputTokens).toBe(128_000);
    expect(overridden.compat).toEqual({ thinkingFormat: 'deepseek' });
    // The base config is immutable: a fallback run must keep the env route.
    expect(base.model).toBe('env-model');
    expect(base.apiKeyEnv).toBe('LLM_API_KEY');
    expect(applyModelOverride(base, undefined)).toBe(base);
  });

  it('requires a model and rejects invalid compat JSON or limits', () => {
    expect(() => loadHarnessRuntimeConfig({})).toThrow(/LLM_MODEL/);
    expect(() => loadHarnessRuntimeConfig({ LLM_MODEL: 'm', LLM_COMPAT_JSON: '[]' })).toThrow(/LLM_COMPAT_JSON/);
    expect(() => loadHarnessRuntimeConfig({ LLM_MODEL: 'm', LLM_CONTEXT_WINDOW: '0' })).toThrow(/LLM_CONTEXT_WINDOW/);
    expect(loadHarnessRuntimeConfig({
      LLM_MODEL: 'm', SRC_AGENT_DSH_BIN: '/d', SRC_AGENT_HARNESS_PLUGIN_PATH: '/p',
      SRC_AGENT_LEAN_TOOLSET: '0', SRC_AGENT_SKILLS_DIR: '/custom/skills',
    })).toMatchObject({ leanToolset: false, skillsDir: '/custom/skills' });
  });
});
