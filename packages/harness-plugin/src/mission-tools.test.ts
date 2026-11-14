import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMissionTools } from './mission-tools';
import type { WorkerPluginConfig } from './config';

async function toolsWithContext() {
  const dir = await mkdtemp(join(tmpdir(), 'mission-tools-'));
  const path = join(dir, 'mission-context.json');
  await writeFile(path, JSON.stringify({
    mission: { id: 'm-1', name: 'lab', state: 'running', objective: 'test' },
    brief: 'PROJECT BRIEF: lab',
    facts: [
      { id: 'f1', kind: 'credential', key: 'credential:admin', value: 'admin:secret', trust: 'inferred', sensitive: true, taskId: 't1' },
      { id: 'f2', kind: 'host', key: 'host:target', value: 'target.test', trust: 'observed', sensitive: false, taskId: null },
    ],
    findings: [{ id: 'fd1', title: 'IDOR on /admin', category: 'auth', severity: 'high', artifact: 'flag', status: 'accepted', confidence: 'observed', taskId: 't1' }],
    tasks: { open: [{ id: 't1', state: 'running', objective: 'enumerate admin' }], recent: [] },
    hints: [],
    workerTraces: [{ traceId: 'tr1', taskId: 't1', eventType: 'tool_call', tool: 'http_request', summary: 'GET /admin', createdAt: new Date().toISOString() }],
    assets: { total: 2, byType: { credential: 1, host: 1 }, items: [{ type: 'host', value: 'target.test', taskId: null }] },
    coverage: { total: 2, covered: 1, ratio: 0.5 },
  }), 'utf8');
  const config: WorkerPluginConfig = {
    role: 'worker', missionId: 'm-1', taskId: 't2', targetUrl: 'http://target.test',
    scope: { domainSuffixes: ['target.test'], ips: [], urlPrefixes: [], exclude: [], allowAll: false },
    proxyUrl: 'http://proxy:8080', reportPath: '/tmp/report.json', missionContextPath: path, traceSearchEnabled: true, allowAllEgress: true,
  };
  return { tools: buildMissionTools(config), config, dir };
}

async function toolsWithDynamicApi() {
  const { config } = await toolsWithContext();
  return {
    tools: buildMissionTools({ ...config, missionApiUrl: 'http://api:3001', missionApiToken: 'token-1' }),
    config,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mission read-only tools', () => {
  it('recalls facts/findings and returns the brief', async () => {
    const { tools } = await toolsWithContext();
    const brief = await tools.missionBrief.execute({}, {} as never);
    expect(JSON.stringify(brief)).toContain('PROJECT BRIEF');
    const recall = await tools.missionRecall.execute({ q: 'admin' }, {} as never);
    expect(JSON.stringify(recall)).toContain('f1');
    expect(JSON.stringify(recall)).toContain('IDOR');
  });

  it('searches prior worker traces with the untrusted marker and lists assets', async () => {
    const { tools } = await toolsWithContext();
    const traces = await tools.searchWorkerTraces.execute({ q: '/admin' }, {} as never);
    const tracePayload = JSON.parse((traces as { text: string }).text) as { hits: Array<{ traceId: string; untrusted: boolean }>; untrusted: boolean; source: string };
    expect(tracePayload.hits[0]?.traceId).toBe('tr1');
    expect(tracePayload.hits[0]?.untrusted).toBe(true);
    expect(tracePayload.untrusted).toBe(true);
    expect(tracePayload.source).toBe('claim-snapshot');
    const assets = await tools.missionAssets.execute({ type: 'host' }, {} as never);
    expect(JSON.stringify(assets)).toContain('target.test');
    expect(JSON.stringify(assets)).toContain('0.5');
  });

  it('queries the control-plane API dynamically and excludes the current task', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      search: {
        hits: [{ traceId: 'live-1', taskId: 't1', eventType: 'tool_call', tool: 'http_request', summary: 'GET /api/users', createdAt: new Date().toISOString(), untrusted: true }],
        total: 1,
        truncated: false,
        untrusted: true,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { tools } = await toolsWithDynamicApi();
    const result = await tools.searchWorkerTraces.execute({ q: 'users', limit: 5 }, {} as never);
    const payload = JSON.parse((result as { text: string }).text) as { hits: Array<{ traceId: string }>; source: string };
    expect(payload.source).toBe('control-plane');
    expect(payload.hits[0]?.traceId).toBe('live-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(called).toContain('/api/missions/m-1/worker-traces/search');
    expect(called).toContain('excludeTaskId=t2');
    expect(called).toContain('limit=5');
  });

  it('falls back to the claim snapshot when the dynamic API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { tools } = await toolsWithDynamicApi();
    const result = await tools.searchWorkerTraces.execute({ q: '/admin' }, {} as never);
    const payload = JSON.parse((result as { text: string }).text) as { hits: Array<{ traceId: string }>; source: string };
    expect(payload.source).toBe('claim-snapshot');
    expect(payload.hits[0]?.traceId).toBe('tr1');
  });
});
