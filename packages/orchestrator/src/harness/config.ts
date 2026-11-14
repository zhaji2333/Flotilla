import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ── Harness runtime configuration ───────────────────────────
// The worker owns the process boundary: it resolves the pinned Harness entry
// point, the bundled SRC-Agent plugin, and the OpenAI-compatible model route
// from environment variables. Nothing mission-specific is baked into the image.

export interface HarnessRuntimeConfig {
  dshBinPath: string;
  pluginPath: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Local skill root mounted into the worker image (CkSKILLS packs). */
  skillsDir: string;
  /** Strip unrelated Harness tool plugins from the worker profile. */
  leanToolset: boolean;
  /** Mount/allow CkSKILLS packs (false = control group for effect evaluation). */
  skillsEnabled: boolean;
  compat?: Record<string, unknown>;
}

/** Normalizes an OpenAI-compatible base URL; bare origins get the `/v1` root. */
export function normalizeOpenAiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('LLM_BASE_URL is empty');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`LLM_BASE_URL must be http(s), got ${parsed.protocol}`);
  }
  if (parsed.search || parsed.hash) throw new Error('LLM_BASE_URL must not contain query or fragment');
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return `${parsed.origin}/v1`;
  }
  return trimmed;
}

function resolvePackageFile(specifier: string, relative: string): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(specifier);
  return join(dirname(packageJson), relative);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadHarnessRuntimeConfig(env: NodeJS.ProcessEnv = process.env): HarnessRuntimeConfig {
  const model = env.LLM_MODEL?.trim();
  if (!model) throw new Error('LLM_MODEL is required');
  const baseUrl = normalizeOpenAiBaseUrl(env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com/v1');

  let compat: Record<string, unknown> | undefined;
  if (env.LLM_COMPAT_JSON?.trim()) {
    try {
      const parsed = JSON.parse(env.LLM_COMPAT_JSON) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      compat = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`LLM_COMPAT_JSON is invalid: ${String(error)}`, { cause: error });
    }
  }

  return {
    dshBinPath:
      env.SRC_AGENT_DSH_BIN?.trim() || resolvePackageFile('@deepseek-ai/dsh/package.json', 'lib/bin.js'),
    pluginPath:
      env.SRC_AGENT_HARNESS_PLUGIN_PATH?.trim() ||
      resolvePackageFile('@src-agent/harness-plugin/package.json', 'dist/index.js'),
    baseUrl,
    apiKeyEnv: env.LLM_API_KEY_ENV?.trim() || 'LLM_API_KEY',
    model,
    // Declared model capacity drives Harness context compaction and the output cap.
    contextWindow: positiveInt(env.LLM_CONTEXT_WINDOW, 1_000_000, 'LLM_CONTEXT_WINDOW'),
    maxOutputTokens: positiveInt(env.LLM_MAX_OUTPUT_TOKENS, 393_216, 'LLM_MAX_OUTPUT_TOKENS'),
    skillsDir: env.SRC_AGENT_SKILLS_DIR?.trim() || '/app/skills',
    leanToolset: env.SRC_AGENT_LEAN_TOOLSET !== '0',
    skillsEnabled: env.SRC_AGENT_SKILLS_ENABLED !== '0',
    compat,
  };
}

// ── P3-B2 DB-backed model override ─────────────────────────
// A UI-configured model profile (model_configs) can override the env route for
// one run. The plaintext key is passed to the Harness child through a dedicated
// env var and never written to logs/traces. Callers that do not provide an
// override keep the historical env-only behavior.
export interface ModelRuntimeOverride {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'high' | 'max';
  compat?: Record<string, unknown>;
}

export const MODEL_OVERRIDE_KEY_ENV = 'SRC_AGENT_MODEL_API_KEY';

export function applyModelOverride(
  config: HarnessRuntimeConfig,
  override?: ModelRuntimeOverride,
): HarnessRuntimeConfig {
  if (!override) return config;
  return {
    ...config,
    baseUrl: normalizeOpenAiBaseUrl(override.baseUrl),
    model: override.model,
    apiKeyEnv: override.apiKeyEnv?.trim() || MODEL_OVERRIDE_KEY_ENV,
    contextWindow: override.contextWindow ?? config.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? config.maxOutputTokens,
    compat: override.compat ?? config.compat,
  };
}
