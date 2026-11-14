import { getPool } from '../db';

// ── Trigger projection (P1-γ) ──────────────────────────────
// Read-only view of the trigger routing audit for the console.

export interface TriggerRow {
  id: string;
  source: string;
  kind: string;
  route: string;
  state: string;
  createdAt: string;
}

export async function listTriggers(missionId: string): Promise<TriggerRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, source, kind, route, state, created_at FROM triggers
     WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [missionId],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    source: String(row.source),
    kind: String(row.kind),
    route: String(row.route),
    state: String(row.state),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
