import type { Task } from './types';

// Client-side DAG layout: dependency depth forms horizontal rows; siblings in
// the same layer run left to right. The SVG is pannable/zoomable in the UI.
export interface DagNode {
  task: Task;
  layer: number;
  row: number;
  x: number;
  y: number;
}

export interface DagEdge {
  from: DagNode;
  to: DagNode;
  path: string;
}

export const NODE_W = 208;
export const NODE_H = 64;
export const GAP_X = 56;
export const GAP_Y = 26;

export function layoutDag(tasks: Task[]): { nodes: DagNode[]; edges: DagEdge[]; width: number; height: number } {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const layers = new Map<string, number>();

  const layerOf = (id: string, visiting = new Set<string>()): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const parents = (task?.dependsOn ?? []).filter(parent => byId.has(parent));
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(parent => layerOf(parent, visiting))) + 1;
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };

  const rows = new Map<number, number>();
  const nodes: DagNode[] = tasks.map(task => {
    const layer = layerOf(task.id);
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    // Siblings run horizontally; dependency layers step downward.
    return { task, layer, row, x: row * (NODE_W + GAP_X), y: layer * (NODE_H + GAP_Y) };
  });

  const nodeById = new Map(nodes.map(node => [node.task.id, node]));
  const edges: DagEdge[] = [];
  for (const node of nodes) {
    for (const dependency of node.task.dependsOn) {
      const parent = nodeById.get(dependency);
      if (!parent) continue;
      const x1 = parent.x + NODE_W / 2;
      const y1 = parent.y + NODE_H;
      const x2 = node.x + NODE_W / 2;
      const y2 = node.y;
      const mid = (y1 + y2) / 2;
      edges.push({
        from: parent,
        to: node,
        path: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
      });
    }
  }

  const width = Math.max(1, ...nodes.map(node => node.x + NODE_W)) + 24;
  const height = Math.max(1, ...nodes.map(node => node.y + NODE_H)) + 24;
  return { nodes, edges, width, height };
}

export const TASK_STATE_COLOR: Record<string, string> = {
  proposed: '#8b8f98',
  ready: '#ffb224',
  leased: '#5aa9ff',
  running: '#d7ff3f',
  reported: '#a78bfa',
  verified: '#6ee7a8',
  done: '#6ee7a8',
  retry_wait: '#fb923c',
  exhausted: '#ff5a2b',
  blocked: '#f472b6',
  cancelled: '#6b7280',
  stale: '#6b7280',
  handed_back: '#38bdf8',
};

export function taskStateColor(state: string): string {
  return TASK_STATE_COLOR[state] ?? '#8b8f98';
}
