import { z } from 'zod';
import { getPool } from '../db';

// ── Mission pause/resume (P1-γ checkpoint) ─────────────────
// Pausing stops new task claims by moving the mission out of the active states
// and snapshotting its checkpoint. Resuming restores scheduling from the same
// checkpoint; tasks/events/todo/grants are never deleted.

const IdSchema = z.string().uuid();

export interface MissionControlResult {
  missionId: string;
  state: string;
  pausedAt: string | null;
  checkpoint: Record<string, unknown>;
}

async function readMission(id: string): Promise<MissionControlResult | null> {
  const result = await getPool().query(
    `SELECT id, state, paused_at, checkpoint FROM missions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    missionId: String(row.id),
    state: String(row.state),
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    checkpoint: (row.checkpoint ?? {}) as Record<string, unknown>,
  };
}

export async function pauseMission(rawId: string): Promise<MissionControlResult> {
  const id = IdSchema.parse(rawId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT state FROM missions WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) throw new Error(`mission ${id} not found`);
    const state = String(current.rows[0].state);
    if (!['pending', 'running', 'active'].includes(state)) {
      throw new Error(`mission ${id} cannot be paused from state ${state}`);
    }
    const snapshot = await client.query(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE mission_id = $1) AS task_count,
         (SELECT count(*)::int FROM tasks WHERE mission_id = $1 AND state IN ('proposed','ready','leased','running','retry_wait','blocked')) AS open_tasks,
         (SELECT COALESCE(jsonb_object_agg(state, count), '{}'::jsonb) FROM (
            SELECT state, count(*) AS count FROM tasks WHERE mission_id = $1 GROUP BY state
          ) counts) AS task_states,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('position', position, 'content', content, 'status', status) ORDER BY position), '[]'::jsonb)
            FROM mission_todo WHERE mission_id = $1) AS todo,
         (SELECT COALESCE(max(seq), 0) FROM events WHERE mission_id = $1) AS last_event_seq,
         (SELECT grant_id FROM missions WHERE id = $1) AS grant_id,
         (SELECT grant_version FROM missions WHERE id = $1) AS grant_version`,
      [id],
    );
    const row = snapshot.rows[0];
    const checkpoint = {
      pausedAt: new Date().toISOString(),
      taskCount: Number(row.task_count ?? 0),
      openTasks: Number(row.open_tasks ?? 0),
      taskStates: row.task_states ?? {},
      todo: row.todo ?? [],
      lastEventSeq: Number(row.last_event_seq ?? 0),
      grantId: row.grant_id ?? null,
      grantVersion: row.grant_version ?? null,
    };
    await client.query(
      `UPDATE missions
       SET state = 'paused', paused_at = now(), checkpoint = checkpoint || $2::jsonb, updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(checkpoint)],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'mission.paused',$2,$3)`,
      [id, id, JSON.stringify(checkpoint)],
    );
    await client.query('COMMIT');
    const mission = await readMission(id);
    if (!mission) throw new Error(`mission ${id} disappeared`);
    return mission;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resumeMission(rawId: string): Promise<MissionControlResult> {
  const id = IdSchema.parse(rawId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT state, success_criteria FROM missions WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) throw new Error(`mission ${id} not found`);
    if (String(current.rows[0].state) !== 'paused') {
      throw new Error(`mission ${id} is not paused (${String(current.rows[0].state)})`);
    }
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE mission_id = $1 AND state IN ('proposed','ready','leased','running','retry_wait','blocked')) AS open_tasks,
         (SELECT count(*)::int FROM tasks WHERE mission_id = $1 AND state IN ('done','verified')) AS done_tasks,
         (SELECT count(*)::int FROM findings WHERE mission_id = $1 AND status = 'accepted') AS accepted_findings,
         (SELECT count(DISTINCT artifact)::int FROM findings WHERE mission_id = $1 AND status = 'accepted' AND artifact IS NOT NULL AND artifact <> '') AS artifacts`,
      [id],
    );
    const openTasks = Number(counts.rows[0].open_tasks ?? 0);
    const doneTasks = Number(counts.rows[0].done_tasks ?? 0);
    const acceptedFindings = Number(counts.rows[0].accepted_findings ?? 0);
    const artifacts = Number(counts.rows[0].artifacts ?? 0);

    // ADR-0012 completion rule A: all tasks terminal, and either a task reached
    // done/verified or Curator accepted at least one finding. Artifact count is
    // an internal quality metric, never a completion gate.
    let state = 'running';
    let failureClass: string | null = null;
    let completedAt: string | null = null;
    if (openTasks === 0) {
      const completed = doneTasks > 0 || acceptedFindings > 0;
      state = completed ? 'completed' : 'failed';
      failureClass = completed ? null : 'no_progress';
      completedAt = new Date().toISOString();
    }
    const resumeSnapshot = {
      resumedAt: new Date().toISOString(),
      openTasks,
      doneTasks,
      acceptedFindings,
      artifacts,
      stateAfterResume: state,
    };
    await client.query(
      `UPDATE missions
       SET state = $2,
           paused_at = NULL,
           checkpoint = checkpoint || $3::jsonb,
           failure_class = COALESCE($4, failure_class),
           completed_at = $5::timestamptz,
           updated_at = now()
       WHERE id = $1`,
      [id, state, JSON.stringify(resumeSnapshot), failureClass, completedAt],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'mission.resumed',$2,$3)`,
      [id, id, JSON.stringify(resumeSnapshot)],
    );
    await client.query('COMMIT');
    const mission = await readMission(id);
    if (!mission) throw new Error(`mission ${id} disappeared`);
    return mission;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
