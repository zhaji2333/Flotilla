import { z } from 'zod';
import { getPool } from '../db';

// ── Control-plane hints (P1-γ) ─────────────────────────────
// A hint is a durable steering message for a mission/task. The worker claims
// pending hints at run boundaries (claim, retry, settlement) and injects them
// into the next Harness prompt; delivery is recorded in the row.

export const CreateHintSchema = z.object({
  missionId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  content: z.string().min(1).max(4_000),
  source: z.string().min(1).max(64).optional(),
  /** P3-B6: guidance (default), help, or report. */
  kind: z.enum(['guidance', 'help', 'report']).default('guidance'),
}).strict();

export type CreateHintInput = z.infer<typeof CreateHintSchema>;

export interface HintRow {
  id: string;
  missionId: string;
  taskId: string | null;
  content: string;
  source: string;
  kind: string;
  state: string;
  createdAt: string;
  deliveredAt: string | null;
}

export async function createHint(input: CreateHintInput): Promise<{ hintId: string }> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO task_hints (mission_id, task_id, content, source, kind)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.missionId, input.taskId ?? null, input.content, input.source ?? 'control_plane', input.kind],
  );
  const hintId = String(result.rows[0].id);
  // M5-2: a human/control-plane hint is a Planner signal (debounced by the
  // existing reason lease); failure to buffer must not lose the hint itself.
  await pool.query(
    `INSERT INTO planner_signals (mission_id, kind, payload) VALUES ($1,'hint_created',$2)`,
    [input.missionId, JSON.stringify({ hintId, kind: input.kind, taskId: input.taskId ?? null })],
  ).catch(() => undefined);
  return { hintId };
}

export async function listHints(missionId: string): Promise<HintRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, mission_id, task_id, content, source, kind, state, created_at, delivered_at
     FROM task_hints
     WHERE mission_id = $1
     ORDER BY created_at ASC`,
    [missionId],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: row.task_id ? String(row.task_id) : null,
    content: String(row.content),
    source: String(row.source),
    kind: String(row.kind ?? 'guidance'),
    state: String(row.state),
    createdAt: new Date(row.created_at).toISOString(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
  }));
}
