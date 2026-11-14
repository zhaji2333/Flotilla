import type { Pool } from 'pg';
import { getPool } from '../db';

// ── Mission summary read model ──────────────────────────────
// Summary tasks write a bounded review; this repository exposes only the
// latest one. It is mission-scoped and never includes other missions' data.

export interface MissionSummaryView {
  id: string;
  missionId: string;
  taskId: string | null;
  markdown: string;
  coverageAssessment: string | null;
  gaps: Array<{ area: string; reason: string; suggestedCheck: string; confidence: string }>;
  duplicateFindingIds: string[];
  missingEvidenceIds: string[];
  createdAt: string;
}

export async function getMissionSummary(
  pool: Pool | undefined,
  missionId: string,
): Promise<MissionSummaryView | null> {
  const db = pool ?? getPool();
  const mission = await db.query(`SELECT id FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const result = await db.query(
    `SELECT id, mission_id, task_id, markdown, coverage_assessment, gaps,
            duplicate_finding_ids, missing_evidence_ids, created_at
     FROM mission_summaries WHERE mission_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [missionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: row.task_id ? String(row.task_id) : null,
    markdown: String(row.markdown),
    coverageAssessment: row.coverage_assessment ? String(row.coverage_assessment) : null,
    gaps: (Array.isArray(row.gaps) ? row.gaps : []) as MissionSummaryView['gaps'],
    duplicateFindingIds: (Array.isArray(row.duplicate_finding_ids) ? row.duplicate_finding_ids : []).map(String),
    missingEvidenceIds: (Array.isArray(row.missing_evidence_ids) ? row.missing_evidence_ids : []).map(String),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
