import { getPool } from '../db';

// ── Finding lineage (P2/P3 gap) ─────────────────────────────
// Findings do not have a second mutable lineage table. The lineage view is
// derived from the authoritative finding row: its evidence references, its
// producing task, its superseded_by chain, and same-mission findings that share
// evidence. This keeps a single source of truth and is safe to rebuild at will.

export type FindingLineageNodeType = 'finding' | 'task' | 'evidence';

export interface FindingLineageNode {
  id: string;
  type: FindingLineageNodeType;
  label: string;
  /** finding-specific */
  status?: string;
  artifact?: string | null;
  /** evidence-specific */
  trafficRef?: string;
  kind?: string;
  method?: string;
  url?: string;
  untrusted?: boolean;
}

export type FindingLineageEdgeType = 'produced_by' | 'supported_by' | 'superseded_by' | 'shares_evidence';

export interface FindingLineageEdge {
  source: string;
  target: string;
  type: FindingLineageEdgeType;
}

export interface FindingLineageRelated {
  id: string;
  title: string;
  status: string;
  artifact: string | null;
  sharedEvidenceCount: number;
}

export interface FindingLineage {
  findingId: string;
  missionId: string;
  rootCauseKey: string | null;
  supersededBy: string | null;
  nodes: FindingLineageNode[];
  edges: FindingLineageEdge[];
  relatedFindings: FindingLineageRelated[];
  generatedAt: string;
}

interface FindingRow {
  id: string;
  mission_id: string;
  task_id: string | null;
  title: string;
  status: string;
  artifact: string | null;
  root_cause_key: string | null;
  superseded_by: string | null;
  evidence_ids: string[];
}

function findingNode(row: FindingRow): FindingLineageNode {
  return {
    id: `finding:${row.id}`,
    type: 'finding',
    label: row.title,
    status: row.status,
    artifact: row.artifact,
  };
}

async function findFinding(id: string): Promise<FindingRow | null> {
  const result = await getPool().query(
    `SELECT id, mission_id, task_id, title, status, artifact, root_cause_key, superseded_by,
            COALESCE(evidence_ids, '[]'::jsonb) AS evidence_ids
     FROM findings WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    mission_id: String(row.mission_id),
    task_id: row.task_id ? String(row.task_id) : null,
    title: String(row.title),
    status: String(row.status),
    artifact: row.artifact ? String(row.artifact) : null,
    root_cause_key: row.root_cause_key ? String(row.root_cause_key) : null,
    superseded_by: row.superseded_by ? String(row.superseded_by) : null,
    evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
  };
}

/**
 * Derives a bounded finding lineage graph for the read-only console. Returns
 * null for unknown IDs; never crosses the finding's mission.
 */
export async function getFindingLineage(findingId: string): Promise<FindingLineage | null> {
  const finding = await findFinding(findingId);
  if (!finding) return null;
  const pool = getPool();
  const nodes: FindingLineageNode[] = [findingNode(finding)];
  const edges: FindingLineageEdge[] = [];
  const seen = new Set<string>(nodes.map(node => node.id));
  const addNode = (node: FindingLineageNode): void => {
    if (seen.has(node.id) || nodes.length >= 120) return;
    seen.add(node.id);
    nodes.push(node);
  };

  // Producing task.
  if (finding.task_id) {
    const task = await pool.query(
      `SELECT id, state, type, payload FROM tasks WHERE id = $1 AND mission_id = $2`,
      [finding.task_id, finding.mission_id],
    );
    if (task.rowCount) {
      const row = task.rows[0];
      const payload = (row.payload ?? {}) as { objective?: unknown; angle?: unknown };
      const label = typeof payload.objective === 'string' && payload.objective.trim()
        ? payload.objective.trim().slice(0, 180)
        : `${String(row.type)} task`;
      addNode({ id: `task:${String(row.id)}`, type: 'task', label, status: String(row.state) });
      edges.push({ source: `finding:${finding.id}`, target: `task:${String(row.id)}`, type: 'produced_by' });
    }
  }

  // Evidence nodes linked by the finding.
  if (finding.evidence_ids.length > 0) {
    const evidence = await pool.query(
      `SELECT id, traffic_ref, kind, method, url, untrusted
       FROM evidence WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [finding.evidence_ids],
    );
    for (const row of evidence.rows) {
      addNode({
        id: `evidence:${String(row.id)}`,
        type: 'evidence',
        label: `${String(row.method)} ${String(row.url)}`.slice(0, 240),
        trafficRef: String(row.traffic_ref),
        kind: String(row.kind),
        method: String(row.method),
        url: String(row.url),
        untrusted: Boolean(row.untrusted),
      });
      edges.push({ source: `finding:${finding.id}`, target: `evidence:${String(row.id)}`, type: 'supported_by' });
    }
  }

  // Replaced findings: follow superseded_by within the same mission.
  let cursor = finding.superseded_by;
  const chainSeen = new Set<string>([finding.id]);
  for (let depth = 0; cursor && depth < 20 && !chainSeen.has(cursor); depth += 1) {
    chainSeen.add(cursor);
    const next = await pool.query(
      `SELECT id, mission_id, task_id, title, status, artifact, root_cause_key, superseded_by,
              COALESCE(evidence_ids, '[]'::jsonb) AS evidence_ids
       FROM findings WHERE id = $1 AND mission_id = $2`,
      [cursor, finding.mission_id],
    );
    if (!next.rowCount) break;
    const row = next.rows[0];
    const replaced: FindingRow = {
      id: String(row.id),
      mission_id: String(row.mission_id),
      task_id: row.task_id ? String(row.task_id) : null,
      title: String(row.title),
      status: String(row.status),
      artifact: row.artifact ? String(row.artifact) : null,
      root_cause_key: row.root_cause_key ? String(row.root_cause_key) : null,
      superseded_by: row.superseded_by ? String(row.superseded_by) : null,
      evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
    };
    addNode(findingNode(replaced));
    edges.push({ source: `finding:${finding.id}`, target: `finding:${replaced.id}`, type: 'superseded_by' });
    cursor = replaced.superseded_by;
  }

  // Same-mission findings sharing evidence. This is the closest existing signal
  // to "proves/based_on": the evidence rows are the shared immutable facts.
  let relatedFindings: FindingLineageRelated[] = [];
  if (finding.evidence_ids.length > 0) {
    const related = await pool.query(
      `SELECT f.id, f.title, f.status, f.artifact,
              (SELECT count(*)::int FROM jsonb_array_elements_text(f.evidence_ids) item
               WHERE item.value = ANY($1::text[])) AS shared_count
       FROM findings f
       WHERE f.mission_id = $2 AND f.id <> $3
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(f.evidence_ids) item
           WHERE item.value = ANY($1::text[])
         )
       ORDER BY shared_count DESC, f.created_at ASC
       LIMIT 25`,
      [finding.evidence_ids, finding.mission_id, finding.id],
    );
    relatedFindings = related.rows.map(row => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status),
      artifact: row.artifact ? String(row.artifact) : null,
      sharedEvidenceCount: Number(row.shared_count ?? 0),
    }));
    for (const item of relatedFindings) {
      addNode({
        id: `finding:${item.id}`,
        type: 'finding',
        label: item.title,
        status: item.status,
        artifact: item.artifact,
      });
      edges.push({ source: `finding:${finding.id}`, target: `finding:${item.id}`, type: 'shares_evidence' });
    }
  }

  return {
    findingId: finding.id,
    missionId: finding.mission_id,
    rootCauseKey: finding.root_cause_key,
    supersededBy: finding.superseded_by,
    nodes,
    edges,
    relatedFindings,
    generatedAt: new Date().toISOString(),
  };
}
