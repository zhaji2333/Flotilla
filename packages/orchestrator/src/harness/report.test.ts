import { describe, expect, it } from 'vitest';
import { mapHarnessReport } from './report.js';

function traffic(id: string, kind: 'target' | 'internet' = 'target') {
  return {
    id,
    kind,
    method: 'GET',
    url: 'http://target.test/x',
    statusCode: 200,
    requestText: 'GET /x',
    responseText: 'ok',
    requestSha256: `req-${id}`,
    responseSha256: `res-${id}`,
    requestBytes: 5,
    responseBytes: 2,
    untrusted: kind === 'internet',
  };
}

function report() {
  return {
    version: 1,
    missionId: 'm-1',
    taskId: 't-1',
    targetUrl: 'http://target.test',
    artifacts: ['FLAG{a}', 'FLAG{a}'],
    findings: [
      {
        title: 'f1',
        category: 'auth',
        severity: 'high',
        artifact: 'FLAG{a}',
        status: 'accepted',
        curatorReasons: [],
        reportMd: '# f1',
        evidence: [traffic('tr_1'), traffic('tr_2')],
      },
    ],
    internetTraffic: [traffic('tr_9', 'internet')],
    assets: [
      { type: 'credential', value: 'admin:plaintext-secret', notes: 'from login page' },
      { type: 'host', value: 'target.test' },
      { value: 'missing-type' },
    ],
    updatedAt: new Date().toISOString(),
  };
}

describe('mapHarnessReport', () => {
  it('maps findings and evidence, deduping traffic ids', () => {
    const mapped = mapHarnessReport(report(), 'm-1', 't-1');
    expect(mapped.artifacts).toEqual(['FLAG{a}']);
    // eslint-disable-next-line unicorn/no-array-sort -- target lib is ES2022 (no toSorted)
    expect(mapped.evidence.map(entry => entry.trafficRef).sort()).toEqual(['tr_1', 'tr_2', 'tr_9']);
    expect(mapped.findings).toHaveLength(1);
    expect(mapped.findings[0].artifact).toBe('FLAG{a}');
    expect(mapped.findings[0].evidenceIds).toEqual(['tr_1', 'tr_2']);
    expect(mapped.assets).toEqual([
      { type: 'credential', value: 'admin:plaintext-secret', notes: 'from login page' },
      { type: 'host', value: 'target.test' },
    ]);
  });

  it('maps a run without artifacts (completion is decided by the runner)', () => {
    const raw = report();
    raw.artifacts = [];
    const mapped = mapHarnessReport(raw, 'm-1', 't-1');
    expect(mapped.artifacts).toEqual([]);
    expect(mapped.findings).toHaveLength(1);
  });

  it('rejects reports from another task or unsupported versions', () => {
    expect(() => mapHarnessReport(report(), 'm-2', 't-1')).toThrow(/different mission/);
    const raw = report() as Record<string, unknown>;
    raw.version = 2;
    expect(() => mapHarnessReport(raw, 'm-1', 't-1')).toThrow(/version/);
  });
});
