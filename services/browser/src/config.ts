export interface BrowserServiceConfig {
  host: string;
  port: number;
  token: string;
  artifactsDir: string;
  proxyUrl: string;
  chromiumPath: string;
  maxContexts: number;
  sessionTtlMs: number;
  evalEnabled: boolean;
  maxNetworkEvents: number;
  maxBodyBytes: number;
  maxSnapshotChars: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrowserServiceConfig {
  return {
    host: env.BROWSER_HOST?.trim() || '0.0.0.0',
    port: integer(env.BROWSER_PORT, 9401, 1, 65_535),
    token: env.BROWSER_TOKEN?.trim() || 'dev-browser-token',
    artifactsDir: env.BROWSER_ARTIFACTS_DIR?.trim() || '/artifacts',
    proxyUrl: env.BROWSER_PROXY_URL?.trim() || env.HTTPS_PROXY?.trim() || env.PROXY_URL?.trim() || 'http://proxy:8080',
    chromiumPath: env.BROWSER_CHROMIUM_PATH?.trim() || '',
    maxContexts: integer(env.BROWSER_MAX_CONTEXTS, 2, 1, 8),
    sessionTtlMs: integer(env.BROWSER_SESSION_TTL_MS, 15 * 60_000, 60_000, 24 * 60 * 60_000),
    evalEnabled: env.BROWSER_EVAL_ENABLED === '1',
    maxNetworkEvents: integer(env.BROWSER_MAX_NETWORK_EVENTS, 2_000, 100, 20_000),
    maxBodyBytes: integer(env.BROWSER_MAX_BODY_BYTES, 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    maxSnapshotChars: integer(env.BROWSER_MAX_SNAPSHOT_CHARS, 48_000, 2_000, 500_000),
    navigationTimeoutMs: integer(env.BROWSER_NAVIGATION_TIMEOUT_MS, 45_000, 1_000, 300_000),
    actionTimeoutMs: integer(env.BROWSER_ACTION_TIMEOUT_MS, 15_000, 500, 120_000),
  };
}
