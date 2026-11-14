import { describe, expect, it } from 'vitest';
import { layoutExploreGraph } from './explore';
import type { ExploreGraph } from './types';

const graph: ExploreGraph = {
  missionId: 'm',
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  threshold: 150,
  folded: false,
  original: { nodes: 3, edges: 2 },
  nodes: [
    { id: 'mission:m', type: 'mission', kind: 'mission', label: 'lab' },
    { id: 'task:t', type: 'task', kind: 'task', label: 'scan', state: 'ready', angle: 'web' },
    { id: 'fact:f', type: 'fact', kind: 'credential', label: 'admin:••••', trust: 'inferred', sensitive: true },
  ],
  edges: [
    { id: 'contains:t', source: 'mission:m', target: 'task:t', type: 'contains' },
    { id: 'produced:f', source: 'task:t', target: 'fact:f', type: 'produced' },
  ],
};

describe('layoutExploreGraph', () => {
  it('places every node and resolves edges', () => {
    const layout = layoutExploreGraph(graph);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    const ids = new Set(layout.nodes.map(item => item.node.id));
    expect(ids).toEqual(new Set(['mission:m', 'task:t', 'fact:f']));
  });

  it('skips edges whose endpoints were removed', () => {
    const layout = layoutExploreGraph({ ...graph, edges: [...graph.edges, { id: 'x', source: 'task:t', target: 'missing', type: 'observes' }] });
    expect(layout.edges).toHaveLength(2);
  });
});
