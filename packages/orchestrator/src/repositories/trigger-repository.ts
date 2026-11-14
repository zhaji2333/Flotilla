import type { Pool, PoolClient } from 'pg';
import { buildDirectFindingHint, routeTrigger, watchdogHint, type TriggerKind, type TriggerSource } from '../scheduler/triggers.js';
import type { WatchdogObservation } from '../scheduler/watchdog.js';

// ── Trigger repository (P1-γ) ───────────────────────────────
// Triggers are the auditable routing record: planner (needs judgement) or
// direct (informational hint delivered to running workers at run boundaries).

export interface TriggerRecord {
  id: string;
  source: TriggerSource;
  kind: TriggerKind;
  route: 'planner' | 'direct';
  state: string;
  createdAt: string;
}

async function insertTrigger(
  client: Pool | PoolClient,
  input: {
    missionId: string;
    taskId?: string | null;
    source: TriggerSource;
    kind: TriggerKind;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const route = routeTrigger(input.source);
  const result = await client.query(
    `INSERT INTO triggers (mission_id, task_id, source, kind, route, payload, state, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'processed',now()) RETURNING id`,
    [input.missionId, input.taskId ?? null, input.source, input.kind, route, JSON.stringify(input.payload)],
  );
  return String(result.rows[0].id);
}

/**
 * Finding triggers: record the trigger and push a direct, scoped hint to the
 * other open tasks of the same mission (never a new authorization).
 */
export async function recordFindingTriggers(
  client: PoolClient,
  missionId: string,
  sourceTaskId: string,
  findings: Array<{ title: string; artifact?: string | null }>,
): Promise<{ triggers: number; hints: number }> {
  if (findings.length === 0) return { triggers: 0, hints: 0 };
  const triggerId = await insertTrigger(client, {
    missionId,
    taskId: sourceTaskId,
    source: 'finding',
    kind: 'finding',
    payload: { sourceTaskId, findings: findings.slice(0, 5).map(finding => finding.title) },
  });
  const content = buildDirectFindingHint({ sourceTaskId, findings });
  const inserted = await client.query(
    `INSERT INTO task_hints (mission_id, task_id, content, source)
     SELECT $1, id, $2, 'trigger:finding'
     FROM tasks
     WHERE mission_id = $1 AND id <> $3 AND state IN ('proposed','ready','leased','running','retry_wait')
     RETURNING id`,
    [missionId, content, sourceTaskId],
  );
  await client.query(`UPDATE triggers SET payload = payload || $2::jsonb WHERE id = $1`, [
    triggerId,
    JSON.stringify({ hintCount: inserted.rowCount ?? 0 }),
  ]);
  return { triggers: 1, hints: inserted.rowCount ?? 0 };
}

/** Watchdog observations become direct hints with a dedupe window. */
export async function recordWatchdogObservation(pool: Pool, observation: WatchdogObservation): Promise<boolean> {
  const dedupeMinutes = Number(process.env.WATCHDOG_DEDUPE_MINUTES || 30);
  const source = `watchdog:${observation.rule}`;
  const recent = await pool.query(
    `SELECT 1 FROM task_hints
     WHERE mission_id = $1 AND source = $2 AND created_at > now() - ($3::int * interval '1 minute')
     LIMIT 1`,
    [observation.missionId, source, dedupeMinutes],
  );
  if ((recent.rowCount ?? 0) > 0) return false;

  const content = watchdogHint(observation.rule, observation.detail);
  const targetTask = observation.taskId ?? null;
  await pool.query(
    `INSERT INTO task_hints (mission_id, task_id, content, source)
     VALUES ($1,$2,$3,$4)`,
    [observation.missionId, targetTask, content, source],
  );
  await insertTrigger(pool, {
    missionId: observation.missionId,
    taskId: targetTask,
    source: 'watchdog',
    kind: observation.rule,
    payload: { detail: observation.detail, hint: content.slice(0, 500) },
  });
  return true;
}

export async function listTriggers(pool: Pool, missionId: string): Promise<TriggerRecord[]> {
  const result = await pool.query(
    `SELECT id, source, kind, route, state, created_at FROM triggers
     WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [missionId],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    source: String(row.source) as TriggerRecord['source'],
    kind: String(row.kind) as TriggerRecord['kind'],
    route: String(row.route) as TriggerRecord['route'],
    state: String(row.state),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
