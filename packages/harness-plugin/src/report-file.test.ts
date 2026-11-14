import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReportSnapshot, loadReportFile, writeReportFile } from './report-file.js';
import { TrafficStore } from './store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('report file', () => {
  it('snapshots findings and the full internet trail atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'src-agent-report-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'report.json');
    const store = new TrafficStore();
    const target = store.record({ kind: 'target', method: 'GET', url: 'http://t/a', statusCode: 200, requestText: 'r', responseText: 's' });
    const internet = store.record({ kind: 'internet', method: 'GET', url: 'https://example.com', statusCode: 200, requestText: 'r2', responseText: 's2' });
    const report = buildReportSnapshot({
      missionId: 'm-1',
      taskId: 't-1',
      targetUrl: 'http://t',
      artifacts: ['a', 'a'],
      findings: [{
        title: 'demo', category: 'x', severity: 'info', status: 'accepted',
        curatorReasons: [], confidence: 'observed', rootCauseKey: 'demo-key',
        claimsAnonymous: false, isCredentialLeak: false,
        reportMd: '# demo', evidence: [target],
      }],
      traffic: [target, internet],
      assets: [{ type: 'host', value: 't' }],
    });
    await writeReportFile(path, report);
    const written = JSON.parse(await readFile(path, 'utf8')) as typeof report;
    expect(written.version).toBe(1);
    expect(written.artifacts).toEqual(['a']);
    expect(written.findings).toHaveLength(1);
    expect(written.traffic.map(record => record.id)).toEqual([target.id, internet.id]);
    expect(written.assets).toEqual([{ type: 'host', value: 't' }]);
    const restored = await loadReportFile(path);
    expect(restored?.missionId).toBe('m-1');
    expect(restored?.traffic).toHaveLength(2);
    const files = await readdir(join(directory, 'nested'));
    expect(files).toEqual(['report.json']);
  });
});
