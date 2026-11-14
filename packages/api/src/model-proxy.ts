import http from 'node:http';
import https from 'node:https';
import { getActiveModelConfig, getModelConfigResolved, getPool } from '@src-agent/control-plane';

// ── Internal model proxy ────────────────────────────────────
// The executor (and therefore the Agent child) never receives a provider API
// key. It gets a scoped proxy token and an OpenAI-compatible base URL. Only
// this API process resolves the model config and injects the provider key
// upstream.

const PROXY_TOKEN = process.env.MODEL_PROXY_TOKEN?.trim() || '';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Math.max(5_000, Number(process.env.MODEL_PROXY_TIMEOUT_MS || 300_000));
const ENV_KEYS = (process.env.LLM_API_KEYS || process.env.LLM_API_KEY || '')
  .split(/[,\n]/)
  .map(value => value.trim())
  .filter(Boolean);
const ENV_KEY_COOLDOWN_MS = Math.max(1_000, Number(process.env.MODEL_PROXY_KEY_COOLDOWN_MS || 60_000));
const envKeyCoolingUntil = new Map<string, number>();
let envKeyCursor = 0;

interface ResolvedRoute {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Set only for env fallback keys; DB configs are singular per role. */
  envKey?: string;
}

function envRoute(): ResolvedRoute | null {
  if (ENV_KEYS.length === 0) return null;
  const now = Date.now();
  let apiKey: string | undefined;
  for (let offset = 0; offset < ENV_KEYS.length; offset += 1) {
    const index = (envKeyCursor + offset) % ENV_KEYS.length;
    const candidate = ENV_KEYS[index]!;
    if ((envKeyCoolingUntil.get(candidate) ?? 0) <= now) {
      apiKey = candidate;
      envKeyCursor = (index + 1) % ENV_KEYS.length;
      break;
    }
  }
  if (!apiKey) {
    // All keys cooling: choose the one that recovers first rather than fail.
    const sorted = [...ENV_KEYS];
    // oxlint-disable-next-line unicorn/no-array-sort -- sorting a local copy is intentional
    sorted.sort((a: string, b: string) => (envKeyCoolingUntil.get(a) ?? 0) - (envKeyCoolingUntil.get(b) ?? 0));
    apiKey = sorted[0] ?? '';
  }
  return {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: (process.env.LLM_MODEL || 'deepseek-flash').trim(),
    envKey: apiKey,
  };
}

async function resolveRoute(configId: string | null, role?: string | null): Promise<ResolvedRoute | null> {
  if (role) {
    const config = (await getActiveModelConfig(getPool(), role as 'worker'))
      ?? (await getActiveModelConfig(getPool()));
    if (config) return { baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey: config.apiKey, model: config.modelName };
    return null;
  }
  if (configId) {
    const config = await getModelConfigResolved(configId);
    if (!config) return null;
    return { baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey: config.apiKey, model: config.modelName };
  }
  const config = await getActiveModelConfig(getPool());
  if (config) return { baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey: config.apiKey, model: config.modelName };
  return envRoute();
}

export function normalizeUpstreamBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.pathname === '/' || parsed.pathname === '') return `${parsed.origin}/v1`;
  return trimmed;
}

function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('model request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function rewriteModel(raw: Buffer, model: string): Buffer {
  if (raw.length === 0) return raw;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
    const body: Record<string, unknown> = { ...(parsed as Record<string, unknown>), model };
    // OpenAI's newer `developer` role is not accepted by every compatible
    // upstream (DeepSeek currently expects `system`).
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(message => {
        if (!message || typeof message !== 'object') return message;
        const item = message as Record<string, unknown>;
        return item.role === 'developer' ? { ...item, role: 'system' } : item;
      });
    }
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return raw;
  }
}

/**
 * Handles `/internal/model/configs/:id/<openai-path>` and
 * `/internal/model/default/<openai-path>`. Returns false when the path is not
 * part of the model proxy surface.
 */
export async function handleModelProxy(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = url.pathname.match(/^\/internal\/model\/(?:configs\/([^/]+)|roles\/([^/]+)|default)(\/.*)$/);
  if (!match) return false;
  if (request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  const explicitToken = typeof request.headers['x-model-proxy-token'] === 'string' ? request.headers['x-model-proxy-token'] : '';
  const authorization = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
    ? request.headers.authorization.slice(7).trim()
    : '';
  if (PROXY_TOKEN && explicitToken !== PROXY_TOKEN && authorization !== PROXY_TOKEN) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model proxy token required' }));
    return true;
  }
  const configId = match[1] && match[1] !== 'default' ? decodeURIComponent(match[1]) : null;
  const role = match[2] ? decodeURIComponent(match[2]) : null;
  const suffix = match[3] || '/';
  let route: ResolvedRoute | null;
  try {
    route = await resolveRoute(configId, role);
  } catch (error) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `model config unavailable: ${String(error)}` }));
    return true;
  }
  if (!route) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model config not found' }));
    return true;
  }
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    response.writeHead(413, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
    return true;
  }
  const body = suffix.startsWith('/chat/completions') ? rewriteModel(rawBody, route.model) : rawBody;
  const upstreamBase = normalizeUpstreamBase(route.baseUrl);
  const upstream = `${upstreamBase}${suffix}`;
  const target = new URL(upstream);
  const transport = target.protocol === 'https:' ? https : http;
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.apiKey}`,
  };
  if (typeof request.headers.accept === 'string') headers.accept = request.headers.accept;
  if (typeof request.headers['user-agent'] === 'string') headers['user-agent'] = request.headers['user-agent'];
  headers['content-length'] = body.length;
  const upstreamRequest = transport.request(target, { method: 'POST', headers, timeout: UPSTREAM_TIMEOUT_MS }, upstreamResponse => {
    if (route?.envKey && [429, 500, 502, 503, 504].includes(upstreamResponse.statusCode ?? 0)) {
      envKeyCoolingUntil.set(route.envKey, Date.now() + ENV_KEY_COOLDOWN_MS);
      console.error(`[model-proxy] env key cooling after upstream HTTP ${upstreamResponse.statusCode}`);
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      'content-type': String(upstreamResponse.headers['content-type'] ?? 'application/json'),
      'cache-control': 'no-transform',
      ...(typeof upstreamResponse.headers['x-request-id'] === 'string' ? { 'x-request-id': upstreamResponse.headers['x-request-id'] } : {}),
    });
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('model upstream timeout')));
  upstreamRequest.on('error', error => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `model upstream failed: ${String(error)}` }));
  });
  upstreamRequest.end(body);
  return true;
}
