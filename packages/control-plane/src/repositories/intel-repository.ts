import type { Pool } from 'pg';
import { getPool } from '../db';

// ── P3-B3 same-mission intel (read-only) ───────────────────
// The user decided intel transfer must NOT cross missions. This endpoint is a
// read-only projection of accepted techniques and credential facts for one
// mission; there is no automatic cross-task hint and no cross-mission path.

export interface MissionIntelItem {
  id: string;
  type: 'technique' | 'credential' | 'artifact';
  title: string;
  detail: string;
  tags: string[];
  trust: string;
  sensitive: boolean;
  sourceFindingId: string | null;
  sourceTaskId: string | null;
  createdAt: string;
}

export interface MissionIntel {
  missionId: string;
  generatedAt: string;
  items: MissionIntelItem[];
  total: number;
}

export async function getMissionIntel(
  pool: Pool | undefined,
  missionId: string,
  limit = 100,
): Promise<MissionIntel | null> {
  const db = pool ?? getPool();
  const mission = await db.query(`SELECT id FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const [findings, credentials] = await Promise.all([
    db.query(
      `SELECT id, task_id, title, category, severity, artifact, confidence, created_at
       FROM findings WHERE mission_id = $1 AND status = 'accepted'
       ORDER BY created_at DESC LIMIT $2`,
      [missionId, capped],
    ),
    db.query(
      `SELECT id, task_id, source_id, value, summary, trust, created_at
       FROM mission_facts
       WHERE mission_id = $1 AND kind = 'credential'
       ORDER BY created_at DESC LIMIT $2`,
      [missionId, capped],
    ),
  ]);
  const items: MissionIntelItem[] = [];
  for (const row of findings.rows) {
    items.push({
      id: `finding:${String(row.id)}`,
      type: row.artifact ? 'artifact' : 'technique',
      title: String(row.title),
      detail: row.artifact ? String(row.artifact) : `${String(row.category)} / ${String(row.severity)}`,
      tags: [String(row.category), String(row.severity), 'accepted'],
      trust: row.confidence ? String(row.confidence) : 'observed',
      sensitive: false,
      sourceFindingId: String(row.id),
      sourceTaskId: row.task_id ? String(row.task_id) : null,
      createdAt: new Date(row.created_at as string).toISOString(),
    });
  }
  for (const row of credentials.rows) {
    items.push({
      id: `credential:${String(row.source_id)}`,
      type: 'credential',
      title: 'credential fact',
      detail: `${String(row.value)}${row.summary && row.summary !== row.value ? ` — ${String(row.summary)}` : ''}`,
      tags: ['credential', String(row.trust)],
      trust: String(row.trust),
      sensitive: true,
      sourceFindingId: null,
      sourceTaskId: row.task_id ? String(row.task_id) : null,
      createdAt: new Date(row.created_at as string).toISOString(),
    });
  }
  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { missionId, generatedAt: new Date().toISOString(), items, total: items.length };
}
