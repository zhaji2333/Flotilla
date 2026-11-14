import { z } from 'zod';
import type { Pool } from 'pg';
import { getPool } from '../db';

// ── Runtime settings / project deletion ─────────────────────
// Only the allowlisted, non-secret runtime knobs are editable. Credentials,
// network endpoints, container replicas and model keys stay deployment-only.

export const RuntimeSettingValuesSchema = z.object({
  'planner.maxOpenTasks': z.number().int().min(1).max(5).optional(),
  'planner.parallelTasks': z.number().int().min(1).max(3).optional(),
  'planner.frontierEnabled': z.boolean().optional(),
  'worker.missionContextEnabled': z.boolean().optional(),
  'worker.traceSearchEnabled': z.boolean().optional(),
  'worker.findingReviewMode': z.enum(['auto', 'manual']).optional(),
  'worker.summaryEnabled': z.boolean().optional(),
  'worker.summaryMaxRounds': z.number().int().min(0).max(2).optional(),
  // 补漏 is opt-in: the summary task reports by default. At most one
  // gap-filling task may be created per mission.
  'worker.summaryFollowUpEnabled': z.boolean().optional(),
  'worker.summaryMaxFollowUps': z.number().int().min(0).max(1).optional(),
  'worker.requestDedupeMode': z.enum(['off', 'warn']).optional(),
  'worker.requestDedupeTtlMinutes': z.number().int().min(1).max(1_440).optional(),
}).strict();

export type RuntimeSettingValues = z.infer<typeof RuntimeSettingValuesSchema>;
export type RuntimeSettingKey = keyof RuntimeSettingValues;

export const RUNTIME_SETTING_KEYS = Object.keys(RuntimeSettingValuesSchema.shape) as RuntimeSettingKey[];

export interface RuntimeSettings extends RuntimeSettingValues {
  version: number;
}

function envDefaults(): RuntimeSettings {
  // Legacy PLANNER_PARALLEL_TASKS was a boolean-ish flag: 1 = enabled, 0 = a
  // single-task plan. Keep old .env files working while the new numeric
  // setting is the maximum number of independent creates per plan.
  const legacyParallel = Number(process.env.PLANNER_PARALLEL_TASKS || 3);
  return {
    'planner.maxOpenTasks': Number(process.env.PLANNER_MAX_OPEN_TASKS || 3),
    'planner.parallelTasks': legacyParallel <= 0 ? 1 : legacyParallel <= 1 ? 3 : legacyParallel,
    'planner.frontierEnabled': process.env.PLANNER_FRONTIER_ENABLED !== '0',
    'worker.missionContextEnabled': process.env.MISSION_CONTEXT_ENABLED !== '0',
    'worker.traceSearchEnabled': process.env.WORKER_TRACE_SEARCH_ENABLED !== '0',
    'worker.findingReviewMode': process.env.FINDING_REVIEW_MODE === 'manual' ? 'manual' : 'auto',
    'worker.summaryEnabled': process.env.SUMMARY_ENABLED !== '0',
    'worker.summaryMaxRounds': Number(process.env.SUMMARY_MAX_ROUNDS || 1),
    'worker.summaryFollowUpEnabled': process.env.SUMMARY_FOLLOWUP_ENABLED === '1',
    'worker.summaryMaxFollowUps': Number(process.env.SUMMARY_MAX_FOLLOWUPS || 1) > 0 ? 1 : 0,
    'worker.requestDedupeMode': process.env.REQUEST_DEDUPE_MODE === 'off' ? 'off' : 'warn',
    'worker.requestDedupeTtlMinutes': Number(process.env.REQUEST_DEDUPE_TTL_MINUTES || 30),
    version: 0,
  };
}

export async function getRuntimeSettings(db?: Pool): Promise<RuntimeSettings> {
  const defaults = envDefaults();
  const pool = db ?? getPool();
  const result = await pool.query(`SELECT key, value FROM runtime_settings ORDER BY key`);
  let version = 0;
  for (const row of result.rows) {
    const key = String(row.key) as RuntimeSettingKey;
    if (!(key in defaults)) continue;
    const parsed = RuntimeSettingValuesSchema.shape[key].safeParse(row.value);
    if (parsed.success) (defaults as unknown as Record<string, unknown>)[key] = parsed.data;
  }
  const versionRow = await pool.query(`SELECT COALESCE(max(version),0)::int AS version FROM runtime_settings`);
  version = Number(versionRow.rows[0]?.version ?? 0);
  return { ...defaults, version };
}

export interface RuntimeSettingPatch {
  [key: string]: unknown;
}

export async function updateRuntimeSettings(
  patch: RuntimeSettingPatch,
  input: { actorUserId: string | null; actorName: string },
): Promise<RuntimeSettings> {
  const parsed = RuntimeSettingValuesSchema.partial().safeParse(patch);
  if (!parsed.success) throw new Error(`invalid runtime settings: ${JSON.stringify(parsed.error.issues)}`);
  const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new Error('no settings provided');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO runtime_settings (key, value, version, updated_by)
         VALUES ($1,$2::jsonb,1,$3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, version=runtime_settings.version+1, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [key, JSON.stringify(value), input.actorUserId],
      );
    }
    await client.query(
      `INSERT INTO admin_audit (actor_user_id, actor_name, action, target_type, detail) VALUES ($1,$2,'settings.update','runtime_settings',$3)`,
      [input.actorUserId, input.actorName, JSON.stringify(parsed.data)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return getRuntimeSettings();
}

// ── Project (mission) hard deletion ─────────────────────────

export interface MissionDeletionCounts {
  tasks: number;
  workerReports: number;
  evidence: number;
  findings: number;
  assets: number;
  approvals: number;
  events: number;
  traces: number;
  summaries: number;
  requestIndex: number;
  grants: number;
  hints: number;
  plannerSignals: number;
  plannerRuns: number;
  triggers: number;
  todo: number;
  steering: number;
  outbox: number;
}

export interface DeletedMission {
  missionId: string;
  name: string;
  counts: MissionDeletionCounts;
  taskIds: string[];
}

/**
 * Hard-deletes one mission and every project-scoped row. Child tables do not
 * all have ON DELETE CASCADE, so deletion is explicit and ordered inside one
 * transaction. The caller writes the platform-level admin audit after commit.
 */
/**
 * Marks the mission's open tasks cancelled and commits before the caller
 * deletes the mission. The worker polls task state every 2 seconds and
 * hard-cancels its executor job on `cancelled`; without this pre-step the
 * cascade would remove the rows and a deleted project's Harness run would keep
 * probing the target (and pollute the next mission's write-action ledger).
 */
export async function cancelMissionTasksForDeletion(missionId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE tasks SET state='cancelled', last_error='mission deleted', completed_at=now()
     WHERE mission_id=$1 AND state IN ('proposed','ready','leased','running','retry_wait','blocked')
     RETURNING id`,
    [missionId],
  );
  if ((result.rowCount ?? 0) > 0) {
    await pool.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
       VALUES ($1::uuid,'mission.delete_cancel_observed',$1::text,$2)`,
      [missionId, JSON.stringify({ tasks: result.rowCount })],
    );
  }
  return result.rowCount ?? 0;
}

/** Name lookup used to validate the confirmation before any state changes. */
export async function getMissionNameForDeletion(missionId: string): Promise<string | null> {
  const result = await getPool().query(`SELECT name FROM missions WHERE id = $1`, [missionId]);
  return result.rowCount === 0 ? null : String(result.rows[0].name);
}

export async function deleteMissionCascade(
  missionId: string,
  confirmName: string,
): Promise<DeletedMission> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [missionId]);
    const mission = await client.query(
      `SELECT id, name, grant_id FROM missions WHERE id = $1 FOR UPDATE`,
      [missionId],
    );
    const row = mission.rows[0];
    if (!row) throw new Error('mission not found');
    if (String(row.name) !== confirmName) throw new Error('mission name confirmation does not match');
    await client.query(
      `UPDATE missions SET state='cancelled', updated_at=now() WHERE id=$1`,
      [missionId],
    );
    const taskIdsResult = await client.query(`SELECT id FROM tasks WHERE mission_id = $1`, [missionId]);
    const taskIds = taskIdsResult.rows.map(taskRow => String(taskRow.id));
    await client.query(
      `UPDATE tasks SET state='cancelled', completed_at=now() WHERE mission_id=$1 AND state IN ('proposed','ready','leased','running','retry_wait','blocked')`,
      [missionId],
    );

    const counts: MissionDeletionCounts = {
      tasks: 0, workerReports: 0, evidence: 0, findings: 0, assets: 0, approvals: 0,
      events: 0, traces: 0, summaries: 0, requestIndex: 0, grants: 0, hints: 0,
      plannerSignals: 0, plannerRuns: 0, triggers: 0, todo: 0, steering: 0, outbox: 0,
    };
    const del = async (table: string, sql: string, key?: keyof MissionDeletionCounts): Promise<void> => {
      const result = await client.query(sql, [missionId]);
      if (key) counts[key] = result.rowCount ?? 0;
    };
    await del('explore_edges', `DELETE FROM explore_edges WHERE mission_id=$1`);
    await del('explore_nodes', `DELETE FROM explore_nodes WHERE mission_id=$1`);
    await del('worker_reports', `DELETE FROM worker_reports WHERE mission_id=$1`, 'workerReports');
    await del('evidence', `DELETE FROM evidence WHERE mission_id=$1`, 'evidence');
    await del('findings', `DELETE FROM findings WHERE mission_id=$1`, 'findings');
    await del('assets', `DELETE FROM assets WHERE mission_id=$1`, 'assets');
    await del('approvals', `DELETE FROM approvals WHERE mission_id=$1`, 'approvals');
    await del('task_hints', `DELETE FROM task_hints WHERE mission_id=$1`, 'hints');
    await del('planner_signals', `DELETE FROM planner_signals WHERE mission_id=$1`, 'plannerSignals');
    await del('planner_runs', `DELETE FROM planner_runs WHERE mission_id=$1`, 'plannerRuns');
    await del('reason_lease', `DELETE FROM reason_lease WHERE mission_id=$1`);
    await del('triggers', `DELETE FROM triggers WHERE mission_id=$1`, 'triggers');
    await del('mission_todo', `DELETE FROM mission_todo WHERE mission_id=$1`, 'todo');
    await del('steering', `DELETE FROM steering WHERE mission_id=$1`, 'steering');
    await del('outbox', `DELETE FROM outbox WHERE mission_id=$1`, 'outbox');
    await del('mission_summaries', `DELETE FROM mission_summaries WHERE mission_id=$1`, 'summaries');
    await del('mission_request_index', `DELETE FROM mission_request_index WHERE mission_id=$1`, 'requestIndex');
    await del('task_trace', `DELETE FROM task_trace WHERE mission_id=$1`, 'traces');
    await del('events', `DELETE FROM events WHERE mission_id=$1`, 'events');
    await del('tasks', `DELETE FROM tasks WHERE mission_id=$1`, 'tasks');
    if (row.grant_id) {
      const grant = await client.query(`DELETE FROM grants WHERE id=$1`, [row.grant_id]);
      counts.grants = grant.rowCount ?? 0;
    }
    const deleted = await client.query(`DELETE FROM missions WHERE id=$1`, [missionId]);
    if ((deleted.rowCount ?? 0) === 0) throw new Error('mission disappeared during deletion');
    await client.query('COMMIT');
    return { missionId, name: String(row.name), counts, taskIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}


export async function listAdminAudit(limit = 100): Promise<Array<{
  id: string; actorName: string; action: string; targetType: string; targetIdHash: string | null; detail: Record<string, unknown>; createdAt: string;
}>> {
  const result = await getPool().query(
    `SELECT id, actor_name, action, target_type, target_id_hash, detail, created_at
     FROM admin_audit ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    actorName: String(row.actor_name),
    action: String(row.action),
    targetType: String(row.target_type),
    targetIdHash: row.target_id_hash ? String(row.target_id_hash) : null,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
