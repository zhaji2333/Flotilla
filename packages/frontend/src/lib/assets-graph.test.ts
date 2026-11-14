import { describe, expect, it } from 'vitest';
import { layoutAssetGraph } from './assets-graph';
import type { MissionAssetGraph } from './types';

const graph: MissionAssetGraph = {
  missionId: 'm',
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    { id: 'asset:a', type: 'asset', kind: 'host', label: 'target.test', covered: true },
    { id: 'asset:a', type: 'asset', kind: 'host', label: 'target.test', covered: true },
    { id: 'task:t', type: 'task', kind: 'task', label: 'task:t' },
    { id: 'evidence:e', type: 'evidence', kind: 'evidence', label: 'http://target.test' },
  ],
  edges: [
    { id: 'observed_by', source: 'asset:a', target: 'task:t', type: 'observed_by' },
    { id: 'seen_in_evidence', source: 'asset:a', target: 'evidence:e', type: 'seen_in_evidence' },
    { id: 'missing', source: 'asset:a', target: 'missing', type: 'observed_by' },
  ],
  counts: { total: 1, byType: { host: 1 }, covered: 1, ratio: 1 },
};

describe('layoutAssetGraph', () => {
  it('dedupes nodes by id and drops dangling edges', () => {
    const layout = layoutAssetGraph(graph);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
