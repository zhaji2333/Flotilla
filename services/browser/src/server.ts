import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { BrowserManager, type ActInput } from './browser-manager.js';

const config = loadConfig();
const manager = new BrowserManager(config);
const MAX_JSON_BYTES = 1 * 1024 * 1024;

function log(message: string): void {
  console.log(`[browser-service] ${message}`);
}

function sameToken(value: string): boolean {
  const expected = Buffer.from(config.token);
  const actual = Buffer.from(value);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function authorized(request: http.IncomingMessage): boolean {
  const header = request.headers['x-browser-token'];
  const token = typeof header === 'string' ? header : request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : '';
  return Boolean(token) && sameToken(token);
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://browser-service');
  if (url.pathname === '/healthz' && request.method === 'GET') {
    json(response, 200, { ok: true, role: 'browser-service', pid: process.pid, artifactsDir: config.artifactsDir });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: 'unauthorized' });
    return;
  }

  if (url.pathname === '/v1/sessions' && request.method === 'POST') {
    const body = await readJson(request) as Record<string, unknown>;
    const view = await manager.createSession({
      missionId: stringField(body, 'missionId'),
      taskId: stringField(body, 'taskId'),
    });
    json(response, 201, view);
    return;
  }

  if (url.pathname === '/v1/close-task' && request.method === 'POST') {
    const body = await readJson(request) as Record<string, unknown>;
    await manager.closeTask(stringField(body, 'missionId'), stringField(body, 'taskId'));
    json(response, 200, { ok: true });
    return;
  }

  const match = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]{36})\/(navigate|snapshot|act|network|chunks|eval)$/);
  if (match) {
    const [, sessionId, action] = match;
    const id = sessionId!;
    if (action === 'navigate' && request.method === 'POST') {
      const body = await readJson(request) as Record<string, unknown>;
      json(response, 200, await manager.navigate(id, stringField(body, 'url')));
      return;
    }
    if (action === 'snapshot' && request.method === 'POST') {
      json(response, 200, await manager.snapshot(id));
      return;
    }
    if (action === 'act' && request.method === 'POST') {
      const body = await readJson(request) as Record<string, unknown>;
      const input = body.action as ActInput;
      json(response, 200, await manager.act(id, input));
      return;
    }
    if (action === 'network' && request.method === 'POST') {
      const body = await readJson(request) as Record<string, unknown>;
      json(response, 200, manager.network(id, Number(body.since ?? 0), Number(body.limit ?? 50)));
      return;
    }
    if (action === 'chunks' && request.method === 'POST') {
      json(response, 200, manager.chunks(id));
      return;
    }
    if (action === 'eval' && request.method === 'POST') {
      const body = await readJson(request) as Record<string, unknown>;
      json(response, 200, { result: await manager.eval(id, stringField(body, 'expression')) });
      return;
    }
  }

  const deleteMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]{36})$/);
  if (deleteMatch && request.method === 'DELETE') {
    await manager.closeSession(deleteMatch[1]!);
    json(response, 200, { ok: true });
    return;
  }

  json(response, 404, { error: 'not found' });
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|required|invalid|unsupported|limit|disabled|too long|credentials/i.test(message) ? 400 : 500;
    log(`request failed ${request.method} ${request.url}: ${message}`);
    if (!response.headersSent) json(response, status, { error: message.slice(0, 500) });
    else response.destroy();
  });
});

server.listen(config.port, config.host, () => {
  log(`listening on ${config.host}:${config.port} maxContexts=${config.maxContexts} proxy=${config.proxyUrl || '-'}`);
});

async function shutdown(signal: string): Promise<void> {
  log(`shutting down on ${signal}`);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await manager.dispose();
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
