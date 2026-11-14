import http from 'node:http';
import https from 'node:https';
import { getActiveModelConfig, getPool } from '@src-agent/control-plane';

// ── Internal DeepSeek Search / Fetch proxy ──────────────────
// The executor has only MODEL_PROXY_TOKEN; the provider key stays in the API.
// These endpoints expose the read-only DeepSeek tools API without leaking the
// key to Worker/Agent processes.

const PROXY_TOKEN = process.env.MODEL_PROXY_TOKEN?.trim() || '';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Math.max(5_000, Number(process.env.TOOLS_PROXY_TIMEOUT_MS || 120_000));

function authorized(request: http.IncomingMessage): boolean {
  if (!PROXY_TOKEN) return true;
  const explicit = typeof request.headers['x-model-proxy-token'] === 'string' ? request.headers['x-model-proxy-token'] : '';
  const authorization = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
    ? request.headers.authorization.slice(7).trim()
    : '';
  return explicit === PROXY_TOKEN || authorization === PROXY_TOKEN;
}

/** DeepSeek tools live under /v1/tools; provider configs may already include /v1. */
export function deepseekToolUrl(baseUrl: string, kind: 'search' | 'fetch'): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const root = base.endsWith('/v1') ? base : `${base}/v1`;
  return `${root}/tools/${kind}`;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('tools request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

export async function handleToolsProxy(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = url.pathname.match(/^\/internal\/tools\/(search|fetch)$/);
  if (!match) return false;
  if (request.method !== 'POST') {
    json(response, 405, { error: 'method not allowed' });
    return true;
  }
  if (!authorized(request)) {
    json(response, 401, { error: 'model proxy token required' });
    return true;
  }
  const kind = match[1] as 'search' | 'fetch';
  let raw: Buffer;
  try {
    raw = await readBody(request);
  } catch (error) {
    json(response, 413, { error: String(error) });
    return true;
  }
  const config = await getActiveModelConfig(getPool()).catch(() => null);
  if (!config) {
    json(response, 503, { error: 'no default model configured for tools proxy' });
    return true;
  }
  const endpoint = deepseekToolUrl(config.baseUrl, kind);
  const target = new URL(endpoint);
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
      'content-length': raw.length,
    },
    timeout: UPSTREAM_TIMEOUT_MS,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      'content-type': String(upstreamResponse.headers['content-type'] ?? 'application/json'),
      'cache-control': 'no-transform',
      ...(typeof upstreamResponse.headers['x-request-id'] === 'string' ? { 'x-request-id': upstreamResponse.headers['x-request-id'] } : {}),
    });
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('tools upstream timeout')));
  upstream.on('error', error => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    json(response, 502, { error: `tools upstream failed: ${String(error)}` });
  });
  upstream.end(raw);
  return true;
}
