import type { Pool } from 'pg';
import { getPool } from '../db';

// ── P3-A3 explore graph read projection ────────────────────
// The graph is derived from authoritative tables (tasks/mission_facts), not a
// second source. `explore_nodes/explore_edges` remain available for future
// writers, but the current projection is generated on read so the console can
// show the mission's fact/intent graph today.

export type ExploreNodeType = 'mission' | 'task' | 'fact';

export interface ExploreGraphNode {
  id: string;
  type: ExploreNodeType;
  kind: string;
  label: string;
  state?: string;
  angle?: string | null;
  sensitive?: boolean;
  trust?: string;
  memberIds?: string[];
}

export interface ExploreGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label?: string;
}

export interface ExploreGraphGroup {
  id: string;
  type: ExploreNodeType;
  kind: string;
  label: string;
  memberIds: string[];
}

export interface MissionExploreGraph {
  missionId: string;
  version: number;
  generatedAt: string;
  threshold: number;
  folded: boolean;
  original: { nodes: number; edges: number };
  nodes: ExploreGraphNode[];
  edges: ExploreGraphEdge[];
  groups?: ExploreGraphGroup[];
}

function clip(value: string, limit = 160): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * Pure folding function: when the graph exceeds the threshold, groups nodes by
 * `type:kind` into supernodes. Every original node is preserved in exactly one
 * group (or stays standalone for the mission node), and every edge is re-mapped
 * without being dropped, so counts are conserved.
 */
export function foldExploreGraph(graph: MissionExploreGraph, threshold = 150): MissionExploreGraph {
  const cap = Math.max(10, Math.min(500, Math.floor(threshold)));
  if (graph.nodes.length <= cap) {
    return { ...graph, threshold: cap, folded: false };
  }
  const missionNode = graph.nodes.find(node => node.type === 'mission');
  const grouped = new Map<string, ExploreGraphGroup>();
  const nodeToGroup = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type === 'mission') continue;
    const key = `${node.type}:${node.kind}`;
    const group = grouped.get(key) ?? {
      id: `group:${key}`,
      type: node.type,
      kind: node.kind,
      label: `${node.kind} × {count}`,
      memberIds: [],
    };
    group.memberIds.push(node.id);
    grouped.set(key, group);
    nodeToGroup.set(node.id, group.id);
  }
  if (missionNode) nodeToGroup.set(missionNode.id, missionNode.id);
  const groups = [...grouped.values()].map(group => ({ ...group, label: group.label.replace('{count}', String(group.memberIds.length)) }));
  const nodes: ExploreGraphNode[] = [
    ...(missionNode ? [missionNode] : []),
    ...groups.map(group => ({
      id: group.id,
      type: group.type,
      kind: group.kind,
      label: group.label,
      memberIds: group.memberIds,
    })),
  ];
  const edges: ExploreGraphEdge[] = graph.edges.map(edge => ({
    ...edge,
    source: nodeToGroup.get(edge.source) ?? edge.source,
    target: nodeToGroup.get(edge.target) ?? edge.target,
  }));
  return {
    ...graph,
    threshold: cap,
    folded: true,
    nodes,
    edges,
    groups,
    original: { nodes: graph.nodes.length, edges: graph.edges.length },
  };
}

/** Builds the derived explore graph for one mission (null when missing). */
export async function getMissionExploreGraph(
  pool: Pool | undefined,
  missionId: string,
  options: { threshold?: number } = {},
): Promise<MissionExploreGraph | null> {
  const db = pool ?? getPool();
  const mission = await db.query(`SELECT name FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const [version, tasks, facts] = await Promise.all([
    db.query(`SELECT COALESCE(max(seq), 0)::int AS version FROM events WHERE mission_id = $1`, [missionId]),
    db.query(
      `SELECT id, type, state, angle, COALESCE(payload->>'objective', type) AS objective
       FROM tasks WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 300`,
      [missionId],
    ),
    db.query(
      `SELECT id, source_id, kind, key, summary, trust, sensitive, task_id
       FROM mission_facts WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 500`,
      [missionId],
    ),
  ]);
  const nodes: ExploreGraphNode[] = [{
    id: `mission:${missionId}`,
    type: 'mission',
    kind: 'mission',
    label: String(mission.rows[0].name),
  }];
  const edges: ExploreGraphEdge[] = [];
  for (const task of tasks.rows) {
    const id = `task:${String(task.id)}`;
    nodes.push({
      id,
      type: 'task',
      kind: 'task',
      label: clip(String(task.objective)),
      state: String(task.state),
      angle: task.angle ? String(task.angle) : null,
    });
    edges.push({ id: `contains:${id}`, source: `mission:${missionId}`, target: id, type: 'contains' });
  }
  const vulnByFinding = new Map<string, string>();
  const artifactByFinding = new Map<string, string>();
  for (const fact of facts.rows) {
    const taskId = fact.task_id ? `task:${String(fact.task_id)}` : null;
    const id = `fact:${String(fact.id)}`;
    nodes.push({
      id,
      type: 'fact',
      kind: String(fact.kind),
      label: clip(String(fact.summary ?? fact.key)),
      trust: String(fact.trust),
      sensitive: Boolean(fact.sensitive),
    });
    if (taskId) {
      edges.push({ id: `produced:${id}`, source: taskId, target: id, type: 'produced' });
    } else {
      edges.push({ id: `observes:${id}`, source: `mission:${missionId}`, target: id, type: 'observes' });
    }
    if (String(fact.kind) === 'vuln') vulnByFinding.set(String(fact.source_id), id);
    if (String(fact.kind) === 'artifact') artifactByFinding.set(String(fact.source_id), id);
  }
  for (const [findingId, vulnId] of vulnByFinding) {
    const artifactId = artifactByFinding.get(findingId);
    if (artifactId) {
      edges.push({ id: `evidence_of:${vulnId}:${artifactId}`, source: vulnId, target: artifactId, type: 'evidence_of' });
    }
  }
  const graph: MissionExploreGraph = {
    missionId,
    version: Number(version.rows[0]?.version ?? 0),
    generatedAt: new Date().toISOString(),
    threshold: Math.max(10, Math.min(500, Math.floor(options.threshold ?? 150))),
    folded: false,
    original: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  };
  return foldExploreGraph(graph, graph.threshold);
}
