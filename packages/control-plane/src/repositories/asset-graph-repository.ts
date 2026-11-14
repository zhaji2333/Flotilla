import type { Pool } from 'pg';
import { getPool } from '../db';

// ── M5-5 project asset graph + coverage ─────────────
// Assets stay mission-scoped (the assets table has no global graph). The graph
// links assets to the tasks/findings/evidence that observed them, and coverage
// is derived from task/evidence/fact references. No cross-mission reads.

export interface AssetGraphNode {
  id: string;
  type: 'asset' | 'task' | 'finding' | 'evidence';
  kind: string;
  label: string;
  taskId?: string | null;
  covered?: boolean;
}

export interface AssetGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'observed_by' | 'produced' | 'seen_in_evidence';
}

export interface MissionAssetGraph {
  missionId: string;
  version: number;
  generatedAt: string;
  nodes: AssetGraphNode[];
  edges: AssetGraphEdge[];
  counts: { total: number; byType: Record<string, number>; covered: number; ratio: number | null };
}

export async function getMissionAssetGraph(
  pool: Pool | undefined,
  missionId: string,
): Promise<MissionAssetGraph | null> {
  const db = pool ?? getPool();
  const mission = await db.query(`SELECT id FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const [version, assets, findings, evidence, facts] = await Promise.all([
    db.query(`SELECT COALESCE(max(seq),0)::int AS version FROM events WHERE mission_id = $1`, [missionId]),
    db.query(`SELECT id, type, value, task_id FROM assets WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 300`, [missionId]),
    db.query(`SELECT id, title, task_id, status FROM findings WHERE mission_id = $1 AND status IN ('accepted','needs_review') ORDER BY created_at DESC LIMIT 100`, [missionId]),
    db.query(`SELECT id, url, task_id FROM evidence WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 100`, [missionId]),
    db.query(`SELECT kind, key, value, task_id FROM mission_facts WHERE mission_id = $1 LIMIT 500`, [missionId]),
  ]);
  const nodes: AssetGraphNode[] = [];
  const edges: AssetGraphEdge[] = [];
  const taskIds = new Set<string>();
  const findingTaskIds = new Map<string, string | null>();
  const evidenceRows = evidence.rows as Array<Record<string, unknown>>;
  const factRows = facts.rows as Array<Record<string, unknown>>;
  let covered = 0;
  const byType: Record<string, number> = {};
  for (const asset of assets.rows) {
    const type = String(asset.type);
    byType[type] = (byType[type] ?? 0) + 1;
    const value = String(asset.value);
    const taskId = asset.task_id ? String(asset.task_id) : null;
    const evidenceMatch = evidenceRows.find(row => String(row.url ?? '').includes(value));
    const factMatch = factRows.find(row => String(row.value ?? '').includes(value) || String(row.key ?? '').includes(value));
    const isCovered = Boolean(taskId || evidenceMatch || factMatch);
    if (isCovered) covered += 1;
    const id = `asset:${String(asset.id)}`;
    nodes.push({ id, type: 'asset', kind: type, label: value.slice(0, 240), taskId, covered: isCovered });
    if (taskId) {
      taskIds.add(taskId);
      edges.push({ id: `observed_by:${id}:${taskId}`, source: id, target: `task:${taskId}`, type: 'observed_by' });
    }
    if (evidenceMatch) {
      const evidenceId = String(evidenceMatch.id);
      nodes.push({ id: `evidence:${evidenceId}`, type: 'evidence', kind: 'evidence', label: String(evidenceMatch.url).slice(0, 200) });
      edges.push({ id: `seen_in_evidence:${id}:${evidenceId}`, source: id, target: `evidence:${evidenceId}`, type: 'seen_in_evidence' });
    }
  }
  for (const taskId of taskIds) {
    nodes.push({ id: `task:${taskId}`, type: 'task', kind: 'task', label: 'task', taskId });
  }
  for (const finding of findings.rows) {
    const id = `finding:${String(finding.id)}`;
    const taskId = finding.task_id ? String(finding.task_id) : null;
    findingTaskIds.set(id, taskId);
    nodes.push({ id, type: 'finding', kind: String(finding.status), label: String(finding.title).slice(0, 200), taskId });
    if (taskId) edges.push({ id: `produced:${id}:${taskId}`, source: `task:${taskId}`, target: id, type: 'produced' });
  }
  // Deduplicate evidence nodes added by several assets.
  const uniqueNodes = [...new Map(nodes.map(node => [node.id, node])).values()];
  const total = assets.rows.length;
  return {
    missionId,
    version: Number(version.rows[0]?.version ?? 0),
    generatedAt: new Date().toISOString(),
    nodes: uniqueNodes,
    edges,
    counts: { total, byType, covered, ratio: total > 0 ? covered / total : null },
  };
}
