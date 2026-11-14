import { describe, expect, it } from 'vitest';
import { ModelConfigUpdateSchema, ModelConfigWriteSchema, maskModelApiKey } from './model-config-repository';

const valid = {
  name: 'deepseek-flash-default',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-plaintext-secret-value',
  modelName: 'deepseek-flash',
};

describe('model configuration schema', () => {
  it('accepts a minimal profile and applies model capacity defaults', () => {
    const parsed = ModelConfigWriteSchema.parse(valid);
    expect(parsed.contextWindow).toBe(1_000_000);
    expect(parsed.maxOutputTokens).toBe(393_216);
    expect(parsed.apiKeyEnv).toBe('SRC_AGENT_MODEL_API_KEY');
    expect(parsed.enabled).toBe(true);
    expect(parsed.isDefault).toBe(false);
    expect(parsed.compat).toEqual({});
  });

  it('rejects non-http(s) base URLs and unknown fields', () => {
    expect(ModelConfigWriteSchema.safeParse({ ...valid, baseUrl: 'ftp://api.example.com' }).success).toBe(false);
    expect(ModelConfigWriteSchema.safeParse({ ...valid, baseUrl: 'not a url' }).success).toBe(false);
    expect(ModelConfigWriteSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it('accepts null for optional enums (the admin console clears them)', () => {
    // Regression: the console submits `null` when reasoningEffort/role/tier are
    // left empty; `.optional()` alone rejected it with "validation failed".
    const parsed = ModelConfigWriteSchema.safeParse({
      ...valid,
      reasoningEffort: null,
      role: null,
      tier: null,
    });
    expect(parsed.success).toBe(true);
    expect(ModelConfigUpdateSchema.safeParse({ reasoningEffort: null }).success).toBe(true);
    expect(ModelConfigUpdateSchema.safeParse({ role: null, tier: null }).success).toBe(true);
  });

  it('accepts a partial update used by the admin UI', () => {
    expect(ModelConfigUpdateSchema.safeParse({ modelName: 'deepseek-pro' }).success).toBe(true);
    expect(ModelConfigUpdateSchema.safeParse({ role: 'planner', tier: 'strong' }).success).toBe(true);
    expect(ModelConfigUpdateSchema.safeParse({ role: 'guard', tier: 'fast' }).success).toBe(true);
    expect(ModelConfigUpdateSchema.safeParse({ role: 'unknown-role' }).success).toBe(false);
  });

  it('masks keys for list/detail responses', () => {
    expect(maskModelApiKey('sk-plaintext-secret-value')).toBe('sk-p••••alue');
    expect(maskModelApiKey('short')).toBe('••••');
    expect(maskModelApiKey('')).toBe('••••');
    expect(maskModelApiKey('sk-plaintext-secret-value')).not.toContain('plaintext');
  });
});
