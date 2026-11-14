import type { Pool } from 'pg';
import { getPool } from '../db';

// ── Write-action ledger ─────────────────────────────────────
// The proxy records every target write (POST/PUT/PATCH/DELETE) that carries a
// mission/task attribution header. The scheduler/worker consult this table
// before retrying a task so a retry cannot silently repeat a target-side write.

export interface ActionLedgerEntry {
  id: string;
  missionId: string;
  taskId: string | null;
  method: string;
  url: string;
  statusCode: number | null;
  requestSha256: string;
  observedAt: string;
}

export async function listTaskActions(
  db: Pool | undefined,
  missionId: string,
  taskId: string | null,
  limit = 50,
): Promise<ActionLedgerEntry[]> {
  const pool = db ?? getPool();
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = taskId
    ? await pool.query(
        `SELECT id, mission_id, task_id, method, url, status_code, request_sha256, observed_at
         FROM action_ledger
         WHERE mission_id = $1 AND task_id = $2
         ORDER BY observed_at DESC, id DESC LIMIT $3`,
        [missionId, taskId, bounded],
      )
    : await pool.query(
        `SELECT id, mission_id, task_id, method, url, status_code, request_sha256, observed_at
         FROM action_ledger
         WHERE mission_id = $1 AND task_id IS NULL
         ORDER BY observed_at DESC, id DESC LIMIT $2`,
        [missionId, bounded],
      );
  return result.rows.map(row => ({
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: row.task_id ? String(row.task_id) : null,
    method: String(row.method),
    url: String(row.url),
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    requestSha256: String(row.request_sha256),
    observedAt: new Date(row.observed_at).toISOString(),
  }));
}

export async function countTaskActions(
  db: Pool | undefined,
  missionId: string,
  taskId: string,
): Promise<number> {
  const pool = db ?? getPool();
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM action_ledger WHERE mission_id = $1 AND task_id = $2`,
    [missionId, taskId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listMissionActions(
  db: Pool | undefined,
  missionId: string,
  limit = 100,
): Promise<ActionLedgerEntry[]> {
  const pool = db ?? getPool();
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await pool.query(
    `SELECT id, mission_id, task_id, method, url, status_code, request_sha256, observed_at
     FROM action_ledger
     WHERE mission_id = $1
     ORDER BY observed_at DESC, id DESC LIMIT $2`,
    [missionId, bounded],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: row.task_id ? String(row.task_id) : null,
    method: String(row.method),
    url: String(row.url),
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    requestSha256: String(row.request_sha256),
    observedAt: new Date(row.observed_at).toISOString(),
  }));
}

/**
 * True when a task has write actions newer than its last human confirmation.
 * Used by the worker before a local retry and by the scheduler before a retry
 * promotion. Confirmation is timestamp-based so a later write re-arms the guard.
 */
export async function hasUnconfirmedTaskActions(
  db: Pool | undefined,
  missionId: string,
  taskId: string,
): Promise<number> {
  const pool = db ?? getPool();
  const result = await pool.query(
    `SELECT count(a.id)::int AS count
     FROM action_ledger a
     JOIN tasks t ON t.id = $2 AND t.mission_id = $1
     WHERE a.mission_id = $1
       AND (a.task_id = $2 OR (a.task_id IS NULL AND a.observed_at >= COALESCE(t.started_at, t.created_at)))
       AND (t.write_actions_confirmed_at IS NULL OR a.observed_at > t.write_actions_confirmed_at)`,
    [missionId, taskId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
