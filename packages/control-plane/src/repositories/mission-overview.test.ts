import { describe, expect, it } from 'vitest';
import { fitMissionOverview, type MissionOverview } from './mission-overview-repository';

function sample(): MissionOverview {
  return {
    mission: { id: 'm', name: 'm', state: 'running', objective: 'obj', target: { type: 'url', value: 'http://t' }, grantVersion: 1, createdAt: new Date().toISOString() },
    tasks: { open: [], recent: [], counts: { open: 0, done: 0, failed: 0, total: 0 } },
    facts: { items: Array.from({ length: 30 }, (_, index) => ({ id: `f${index}`, kind: 'host', key: `k${index}`, value: 'v'.repeat(500), summary: 's'.repeat(200), trust: 'observed', sensitive: false, provenance: 'worker_asset', taskId: null, createdAt: new Date().toISOString() })), counts: { total: 30, byKind: { host: 30 }, sensitive: 0 } },
    frontier: null,
    findings: { accepted: [], needsReview: [], counts: { accepted: 0, needsReview: 0 } },
    hints: { items: [], pending: 0 },
    negatives: { blocked: 0, exhausted: 0, stale: 0, needsReview: 0, total: 0 },
    traces: { totals: null, tasks: [] },
    todo: { items: [] },
    assets: { total: 0, byType: {}, items: [] },
    coverage: { total: 0, covered: 0, ratio: null },
    budget: { tokens: 0, steps: 0 },
    version: 1,
    generatedAt: new Date().toISOString(),
  };
}

describe('mission overview budget', () => {
  it('keeps small overviews unchanged', () => {
    const overview = sample();
    overview.facts.items = [];
    expect(fitMissionOverview(overview, 8_000).truncated).toBeUndefined();
  });

  it('drops low-priority sections and stays valid JSON under the budget', () => {
    const fitted = fitMissionOverview(sample(), 2_000);
    expect(fitted.truncated).toBe(true);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(2_100);
    expect(() => JSON.parse(JSON.stringify(fitted))).not.toThrow();
  });
});
