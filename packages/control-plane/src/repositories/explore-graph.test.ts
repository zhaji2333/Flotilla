import { describe, expect, it } from 'vitest';
import { foldExploreGraph, type MissionExploreGraph } from './explore-graph-repository';

function graph(nodeCount: number): MissionExploreGraph {
  const nodes = [
    { id: 'mission:m', type: 'mission' as const, kind: 'mission', label: 'lab' },
    ...Array.from({ length: nodeCount - 1 }, (_, index) => ({
      id: `fact:f${index}`,
      type: 'fact' as const,
      kind: index % 2 === 0 ? 'host' : 'vuln',
      label: `fact ${index}`,
    })),
  ];
  const edges = nodes.filter(node => node.type !== 'mission').map((node, index) => ({
    id: `e${index}`,
    source: 'mission:m',
    target: node.id,
    type: 'observes',
  }));
  return {
    missionId: 'm', version: 1, generatedAt: new Date().toISOString(), threshold: 150,
    folded: false, original: { nodes: nodes.length, edges: edges.length }, nodes, edges,
  };
}

describe('explore graph digest folding', () => {
  it('leaves small graphs unchanged', () => {
    const result = foldExploreGraph(graph(20), 150);
    expect(result.folded).toBe(false);
    expect(result.nodes).toHaveLength(20);
    expect(result.edges).toHaveLength(19);
  });

  it('folds large graphs by type:kind and conserves counts', () => {
    const original = graph(200);
    const result = foldExploreGraph(original, 150);
    expect(result.folded).toBe(true);
    expect(result.nodes.length).toBeLessThanOrEqual(150);
    expect(result.original).toEqual({ nodes: 200, edges: 199 });
    const groupedNodeCount = (result.groups ?? []).reduce((sum, group) => sum + group.memberIds.length, 0);
    expect(groupedNodeCount + result.nodes.filter(node => node.type === 'mission').length).toBe(200);
    expect(result.edges).toHaveLength(199);
    const ids = new Set(result.nodes.map(node => node.id));
    for (const edge of result.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });
});
