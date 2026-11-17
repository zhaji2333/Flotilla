import { z } from 'zod';
import { getPool } from '../db';
import { hasUnconfirmedTaskActions } from './action-ledger-repository';

// ── Manual task control (P1 1.7) ────────────────────────────
// Human operators can spawn one independent intent, cancel a task, and confirm
// a write-action retry. Every operation is synchronous, transactional and
// written to the steering audit table. The planner remains the normal source
// of autonomous tasks; these endpoints are the explicit human override path.

const IdSchema = z.string().uuid();
const AngleSchema = z.enum(['web', 'api', 'infra', 'binary']);

export const CreateManualTaskSchema = z.object({
  objective: z.string().trim().min(1).max(2_000),
  angle: AngleSchema.optional(),
  priority: z.number().min(0).max(1).optional(),
  maxSteps: z.number().int().nonnegative().max(3_000).optional(),
  maxWallClockMs: z.number().int().nonnegative().max(7_200_000).optional(),
  methodology: z.string().max(8_000).optional(),
  artifactIds: z.array(z.string().uuid()).max(20).default([]),
}).strict();

export type CreateManualTaskInput = z.infer<typeof CreateManualTaskSchema>;

export interface ManualTaskResult {
  taskId: string;
  state: string;
}

export interface TaskControlResult {
  taskId: string;
  missionId: string;
  state: string;
  actionCount?: number;
}

const OPEN_STATES = ['proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked'];
const CANCELLABLE_STATES = new Set(['proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked']);

async function recordSteering(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  missionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO steering (mission_id, type, payload, processed) VALUES ($1,$2,$3,true)`,
    [missionId, type, JSON.stringify(payload)],
  );
}

/**
 * ADR-0012 completion rule for manual control paths. Unlike the worker
 * finalizer this deliberately does NOT create a summary task; a human cancel is
 * an explicit terminal action. Summary tasks still use the normal worker path.
 */
async function finalizeIfNoOpenTasks(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> },
  missionId: string,
): Promise<void> {
  const mission = await client.query(`SELECT state FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return;
  if (String(mission.rows[0].state) === 'paused') return;
  const open = await client.query(
    `SELECT count(*)::int AS count FROM tasks WHERE mission_id = $1 AND state = ANY($2::text[])`,
    [missionId, OPEN_STATES],
  );
  if (Number(open.rows[0]?.count ?? 0) > 0) return;
  const stats = await client.query(
    `SELECT count(*) FILTER (WHERE state IN ('done','verified'))::int AS done,
            count(*) FILTER (WHERE state IN ('failed','exhausted','stale','cancelled','handed_back'))::int AS failed
     FROM tasks WHERE mission_id = $1`,
    [missionId],
  );
  const findings = await client.query(
    `SELECT count(*)::int AS accepted FROM findings WHERE mission_id = $1 AND status = 'accepted'`,
    [missionId],
  );
  const done = Number(stats.rows[0]?.done ?? 0);
  const failed = Number(stats.rows[0]?.failed ?? 0);
  const accepted = Number(findings.rows[0]?.accepted ?? 0);
  const completed = done > 0 || accepted > 0;
  const state = completed ? 'completed' : 'failed';
  await client.query(
    `UPDATE missions SET state = $2, failure_class = $3, completed_at = now(), updated_at = now()
     WHERE id = $1 AND state IN ('pending','running','active')`,
    [missionId, state, completed ? null : 'no_progress'],
  );
  await client.query(
    `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
    [missionId, `mission.${state}`, missionId, JSON.stringify({ reason: 'manual control', done, failed, accepted })],
  );
  // A terminal mission has no open tasks; do not leave its plan cursor
  // (pending/in_progress todo) looking active forever.
  await client.query(
    `UPDATE mission_todo SET status = 'done', updated_at = now()
     WHERE mission_id = $1 AND status IN ('pending','in_progress')`,
    [missionId],
  );
}

export async function createManualTask(
  rawMissionId: string,
  input: CreateManualTaskInput,
  actor: string,
): Promise<ManualTaskResult> {
  const missionId = IdSchema.parse(rawMissionId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const mission = await client.query(
      `SELECT id, state, grant_id, grant_version FROM missions WHERE id = $1 FOR UPDATE`,
      [missionId],
    );
    if (mission.rowCount === 0) throw new Error(`mission ${missionId} not found`);
    const missionRow = mission.rows[0];
    const missionState = String(missionRow.state);
    if (['completed', 'failed', 'cancelled'].includes(missionState)) {
      throw new Error(`mission ${missionId} is ${missionState}; cannot spawn a task`);
    }
    const open = await client.query(
      `SELECT count(*)::int AS count FROM tasks WHERE mission_id = $1 AND state = ANY($2::text[])`,
      [missionId, OPEN_STATES],
    );
    const maxOpen = Math.max(1, Math.min(50, Number(process.env.MANUAL_MAX_OPEN_TASKS || 10)));
    if (Number(open.rows[0]?.count ?? 0) >= maxOpen) {
      throw new Error(`mission ${missionId} already has ${maxOpen} open tasks`);
    }
    if (input.artifactIds.length > 0) {
      const artifacts = await client.query(
        `SELECT id FROM artifacts WHERE mission_id = $1 AND id = ANY($2::uuid[])`,
        [missionId, input.artifactIds],
      );
      if ((artifacts.rowCount ?? 0) !== input.artifactIds.length) {
        throw new Error('one or more artifactIds do not belong to this mission');
      }
    }
    const budget = {
      maxSteps: input.maxSteps ?? Number(process.env.TASK_MAX_STEPS || 0),
      maxWallClockMs: input.maxWallClockMs ?? Number(process.env.TASK_MAX_WALL_CLOCK_MS || 1_200_000),
    };
    const payload = {
      objective: input.objective,
      kind: 'manual',
      source: 'manual',
      ...(input.angle ? { angle: input.angle } : {}),
      ...(input.methodology ? { methodology: input.methodology } : {}),
      ...(input.artifactIds.length > 0 ? { artifactIds: input.artifactIds } : {}),
    };
    const task = await client.query(
      `INSERT INTO tasks
         (mission_id, type, state, grant_id, grant_version, budget, payload, priority, success_criteria)
       VALUES ($1, 'intent', 'proposed', $2, $3, $4, $5, $6, '{}'::jsonb)
       RETURNING id`,
      [
        missionId,
        missionRow.grant_id,
        Number(missionRow.grant_version),
        JSON.stringify(budget),
        JSON.stringify(payload),
        input.priority ?? 0.5,
      ],
    );
    const taskId = String(task.rows[0].id);
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.created',$2,$3)`,
      [missionId, taskId, JSON.stringify({ type: 'intent', state: 'proposed', source: 'manual', objective: input.objective, angle: input.angle ?? null, actor })],
    );
    await recordSteering(client, missionId, 'spawn_intent', { taskId, objective: input.objective, angle: input.angle ?? null, actor });
    await client.query('COMMIT');
    return { taskId, state: 'proposed' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelTask(
  rawMissionId: string,
  rawTaskId: string,
  actor: string,
  reason = 'cancelled by operator',
): Promise<TaskControlResult> {
  const missionId = IdSchema.parse(rawMissionId);
  const taskId = IdSchema.parse(rawTaskId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT id, mission_id, state FROM tasks WHERE id = $1 AND mission_id = $2 FOR UPDATE`,
      [taskId, missionId],
    );
    if (current.rowCount === 0) throw new Error(`task ${taskId} not found in mission ${missionId}`);
    const state = String(current.rows[0].state);
    if (!CANCELLABLE_STATES.has(state)) {
      throw new Error(`task ${taskId} cannot be cancelled from state ${state}`);
    }
    await client.query(
      `UPDATE tasks SET state = 'cancelled', completed_at = now(), last_error = $2,
       disposition = COALESCE(disposition, 'cancelled'),
       lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
      [taskId, reason],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.cancelled',$2,$3)`,
      [missionId, taskId, JSON.stringify({ from: state, reason, actor })],
    );
    await recordSteering(client, missionId, 'cancel_task', { taskId, from: state, reason, actor });
    await finalizeIfNoOpenTasks(client, missionId);
    await client.query('COMMIT');
    return { taskId, missionId, state: 'cancelled' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Human confirmation for a task blocked by action_ledger. The task remains
 * blocked until this succeeds; the next scheduler pass promotes retry_wait to
 * ready. This is the only path that clears a write-action retry block.
 */
export async function confirmTaskRetry(
  rawMissionId: string,
  rawTaskId: string,
  actor: string,
): Promise<TaskControlResult> {
  const missionId = IdSchema.parse(rawMissionId);
  const taskId = IdSchema.parse(rawTaskId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT id, mission_id, state FROM tasks WHERE id = $1 AND mission_id = $2 FOR UPDATE`,
      [taskId, missionId],
    );
    if (current.rowCount === 0) throw new Error(`task ${taskId} not found in mission ${missionId}`);
    if (String(current.rows[0].state) !== 'blocked') {
      throw new Error(`task ${taskId} is ${String(current.rows[0].state)}, not blocked`);
    }
    const actionCount = await hasUnconfirmedTaskActions(client as never, missionId, taskId);
    if (actionCount === 0) throw new Error(`task ${taskId} has no recorded write actions`);
    await client.query(
      `UPDATE tasks SET state = 'retry_wait', retry_after = now(), last_error = NULL, write_actions_confirmed_at = now() WHERE id = $1`,
      [taskId],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.retry_confirmed',$2,$3)`,
      [missionId, taskId, JSON.stringify({ actionCount, actor })],
    );
    await recordSteering(client, missionId, 'confirm_retry', { taskId, actionCount, actor });
    await client.query('COMMIT');
    return { taskId, missionId, state: 'retry_wait', actionCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface SteeringRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  processed: boolean;
  createdAt: string;
}

/** Read the synchronous human-command audit trail for a mission. */
export async function listSteering(
  missionId: string,
  limit = 100,
): Promise<SteeringRecord[]> {
  const set = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await getPool().query(
    `SELECT id, type, payload, processed, created_at FROM steering
     WHERE mission_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [IdSchema.parse(missionId), set],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    type: String(row.type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    processed: Boolean(row.processed),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
