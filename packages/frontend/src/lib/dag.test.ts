import { describe, expect, it } from 'vitest';
import { layoutDag } from './dag';
import type { Task } from './types';

function task(id: string, dependsOn: string[] = [], state: Task['state'] = 'proposed'): Task {
  return {
    id,
    state,
    type: 'intent',
    angle: null,
    dependsOn,
    attempt: 1,
    priority: 0.5,
    lastError: null,
    plannerRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    result: null,
  };
}

describe('layoutDag', () => {
  it('places dependencies in earlier layers and emits one edge per dependency', () => {
    const layout = layoutDag([task('a'), task('b', ['a']), task('c', ['a', 'b'])]);
    const byId = new Map(layout.nodes.map(node => [node.task.id, node]));
    expect(byId.get('a')?.layer).toBe(0);
    expect(byId.get('b')?.layer).toBe(1);
    expect(byId.get('c')?.layer).toBe(2);
    expect(layout.edges).toHaveLength(3);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('survives unknown dependency ids and cycles', () => {
    const layout = layoutDag([task('a', ['missing']), task('b', ['c']), task('c', ['b'])]);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
  });
});
