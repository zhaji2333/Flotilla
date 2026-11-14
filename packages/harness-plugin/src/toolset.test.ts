import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentToolset } from './toolset.js';
import type { WorkerPluginConfig } from './config.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function config(missionId: string, taskId: string, reportPath: string): WorkerPluginConfig {
  return {
    role: 'worker',
    missionId,
    taskId,
    targetUrl: 'http://isolation.invalid',
    scope: { domainSuffixes: [], ips: [], urlPrefixes: [], exclude: [], allowAll: false },
    proxyUrl: 'http://127.0.0.1:9',
    reportPath,
    traceSearchEnabled: true,
    allowAllEgress: false,
  };
}

describe('per-agent toolsets', () => {
  it('keeps two agents isolated in one process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'src-agent-toolsets-'));
    directories.push(directory);
    const first = await createAgentToolset(config('mission-a', 'task-a', join(directory, 'a.json')));
    const second = await createAgentToolset(config('mission-b', 'task-b', join(directory, 'b.json')));

    expect(first.store).not.toBe(second.store);
    expect(first.findings).not.toBe(second.findings);
    expect(first.artifacts).not.toBe(second.artifacts);

    first.store?.insertAssets([{ type: 'host', value: 'a.example' }]);
    second.store?.insertAssets([{ type: 'host', value: 'b.example' }]);
    await first.persistReport();
    await second.persistReport();

    const reportA = JSON.parse(await readFile(join(directory, 'a.json'), 'utf8')) as {
      missionId: string; taskId: string; assets: Array<{ value: string }>;
    };
    const reportB = JSON.parse(await readFile(join(directory, 'b.json'), 'utf8')) as {
      missionId: string; taskId: string; assets: Array<{ value: string }>;
    };
    expect(reportA.missionId).toBe('mission-a');
    expect(reportA.assets.map(asset => asset.value)).toEqual(['a.example']);
    expect(reportB.missionId).toBe('mission-b');
    expect(reportB.assets.map(asset => asset.value)).toEqual(['b.example']);

    await first.dispose();
    await second.dispose();
  });
});
