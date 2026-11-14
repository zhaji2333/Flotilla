import type { Pool } from 'pg';
import type { WatchdogObservation } from '../scheduler/watchdog.js';
import { recordWatchdogObservation } from './trigger-repository.js';

// ── Watchdog state, escalation and effect capture ──────────
// The rule/LLM layers only decide that something looks wrong. This module is
// the single write path (always behind the dispatcher) that:
//   1. tracks consecutive stall signals per task,
//   2. writes an auditable watchdog_observations row,
//   3. escalates once per streak (planner signal + human approval),
//   4. later sweeps the row to record whether the hint actually helped.

export const ESCALATION_RULES = new Set(['no_progress', 'direction_drift'] as const);

export interface WatchdogObservationInput extends WatchdogObservation {
  /** `llm`/`rules`: which layer produced the observation. */
  source?: 'rules' | 'llm';
  /** True when the observer saw real progress (LLM verdict=ok): resets streak. */
  progress?: boolean;
}

export type WatchdogAction = 'hint' | 'deduped' | 'reset' | 'escalated';

export interface WatchdogApplyResult {
  recorded: boolean;
  action: WatchdogAction;
  streak: number;
  escalated: boolean;
  approvalId: string | null;
  observationId: string | null;
}

export function escalationThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.WATCHDOG_ESCALATE_AFTER || 2);
  return Number.isFinite(value) && value >= 1 ? Math.min(10, Math.trunc(value)) : 2;
}

export function outcomeDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.WATCHDOG_OUTCOME_DELAY_MS || 600_000);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/** Resets the stall streak for a task (progress observed or human review). */
export async function resetWatchdogStreak(pool: Pool, taskId: string): Promise<void> {
  await pool.query(
    `UPDATE watchdog_task_state
        SET stalled_streak = 0, escalated_streak = 0, last_observed_at = now()
      WHERE task_id = $1`,
    [taskId],
  );
}

async function recordObservation(
  pool: Pool,
  input: WatchdogObservationInput,
  fields: {
    action: WatchdogAction;
    streak: number;
    hintId: string | null;
    approvalId: string | null;
    escalationSignal: boolean;
  },
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO watchdog_observations
       (mission_id, task_id, rule, source, detail, action, stalled_streak, hint_id, escalation_signal, approval_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.missionId,
      input.taskId ?? null,
      input.rule,
      input.source ?? 'rules',
      input.detail.slice(0, 1_000),
      fields.action,
      fields.streak,
      fields.hintId,
      fields.escalationSignal,
      fields.approvalId,
    ],
  );
  return String(result.rows[0].id);
}

async function findPendingEscalationApproval(pool: Pool, taskId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT id FROM approvals
      WHERE type = 'stalled_task' AND status = 'pending'
        AND payload->>'taskId' = $1
      ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  return result.rowCount ? String(result.rows[0].id) : null;
}

/**
 * Applies one observation atomically enough for audit purposes:
 * streak bookkeeping -> observation row -> deduped hint -> one-shot escalation.
 */
export async function applyWatchdogObservation(
  pool: Pool,
  input: WatchdogObservationInput,
  options: { escalateAfter?: number } = {},
): Promise<WatchdogApplyResult> {
  if (!input.taskId) {
    // Mission-level observations have no streak; keep the hint/audit path.
    const recorded = await recordWatchdogObservation(pool, input);
    const observationId = await recordObservation(pool, input, {
      action: recorded ? 'hint' : 'deduped',
      streak: 0,
      hintId: null,
      approvalId: null,
      escalationSignal: false,
    });
    return { recorded, action: recorded ? 'hint' : 'deduped', streak: 0, escalated: false, approvalId: null, observationId };
  }

  const taskId = input.taskId;
  if (input.progress === true) {
    await resetWatchdogStreak(pool, taskId);
    return { recorded: false, action: 'reset', streak: 0, escalated: false, approvalId: null, observationId: null };
  }

  let streak = 0;
  let escalatedStreak = 0;
  if (ESCALATION_RULES.has(input.rule as 'no_progress' | 'direction_drift')) {
    const state = await pool.query(
      `INSERT INTO watchdog_task_state (task_id, mission_id, stalled_streak, last_rule, last_detail)
       VALUES ($1,$2,1,$3,$4)
       ON CONFLICT (task_id) DO UPDATE
         SET stalled_streak = watchdog_task_state.stalled_streak + 1,
             last_rule = EXCLUDED.last_rule,
             last_detail = EXCLUDED.last_detail,
             last_observed_at = now()
       RETURNING stalled_streak, escalated_streak`,
      [taskId, input.missionId, input.rule, input.detail.slice(0, 1_000)],
    );
    streak = Number(state.rows[0]?.stalled_streak ?? 1);
    escalatedStreak = Number(state.rows[0]?.escalated_streak ?? 0);
  }

  const hinted = await recordWatchdogObservation(pool, input);
  const threshold = Math.max(1, options.escalateAfter ?? escalationThreshold());
  let action: WatchdogAction = hinted ? 'hint' : 'deduped';
  let approvalId: string | null = null;
  let escalationSignal = false;

  // Exactly one escalation per stall cycle: `escalated_streak` stays > 0 until a
  // progress verdict or a rejected review resets the state, so a task that
  // keeps producing stall observations cannot spam planner signals every tick.
  if (streak >= threshold && escalatedStreak === 0) {
    const taskRow = await pool.query(
      `SELECT state FROM tasks WHERE id = $1`,
      [taskId],
    );
    const taskState = taskRow.rowCount ? String(taskRow.rows[0].state) : '';
    if (['proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked'].includes(taskState)) {
      await pool.query(
        `INSERT INTO planner_signals (mission_id, kind, payload)
         VALUES ($1, 'watchdog_stall', $2)`,
        [
          input.missionId,
          JSON.stringify({
            taskId,
            rule: input.rule,
            streak,
            detail: input.detail.slice(0, 500),
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      escalationSignal = true;

      approvalId = await findPendingEscalationApproval(pool, taskId);
      if (!approvalId) {
        const approval = await pool.query(
          `INSERT INTO approvals (mission_id, type, status, payload)
           VALUES ($1,'stalled_task','pending',$2) RETURNING id`,
          [
            input.missionId,
            JSON.stringify({
              type: 'stalled_task',
              taskId,
              rule: input.rule,
              streak,
              detail: input.detail.slice(0, 1_000),
            }),
          ],
        );
        approvalId = String(approval.rows[0].id);
        await pool.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
           VALUES ($1,'approval.requested',$2,$3)`,
          [input.missionId, approvalId, JSON.stringify({ type: 'stalled_task', taskId })],
        );
      }

      const content = `[trigger:stall_escalation] Task stalled ${streak} consecutive observations (${input.rule}): ${input.detail.slice(0, 300)} `
        + 'A planner reason pass was requested and a human review (cancel / redirect) is waiting in the approval center. '
        + 'Either change direction now or report a dead end explicitly.';
      await pool.query(
        `INSERT INTO task_hints (mission_id, task_id, content, source) VALUES ($1,$2,$3,'watchdog:escalation')`,
        [input.missionId, taskId, content.slice(0, 2_000)],
      );
      await pool.query(
        `UPDATE watchdog_task_state SET escalated_streak = $2, last_observed_at = now() WHERE task_id = $1`,
        [taskId, streak],
      );
      action = 'escalated';
    }
  }

  const observationId = await recordObservation(pool, input, {
    action,
    streak,
    hintId: null,
    approvalId,
    escalationSignal,
  });
  return { recorded: hinted, action, streak, escalated: action === 'escalated', approvalId, observationId };
}

export interface WatchdogOutcomeSweep {
  checked: number;
  progress: number;
  noProgress: number;
}

/**
 * Records whether a hint produced any change: new findings, or target URLs the
 * mission had not requested before the observation. Runs on observations older
 * than WATCHDOG_OUTCOME_DELAY_MS (10 minutes by default).
 */
export async function evaluateWatchdogOutcomes(
  pool: Pool,
  options: { minAgeMs?: number; limit?: number } = {},
): Promise<WatchdogOutcomeSweep> {
  const minAgeMs = Math.max(0, options.minAgeMs ?? outcomeDelayMs());
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const pending = await pool.query(
    `SELECT id, mission_id, task_id, created_at
       FROM watchdog_observations
      WHERE outcome = 'pending' AND action <> 'reset'
        AND created_at <= now() - ($1::bigint * interval '1 millisecond')
      ORDER BY created_at ASC
      LIMIT $2`,
    [String(minAgeMs), limit],
  );
  let progress = 0;
  let noProgress = 0;
  for (const row of pending.rows) {
    const observationId = String(row.id);
    const missionId = String(row.mission_id);
    const taskId = row.task_id ? String(row.task_id) : null;
    const since = new Date(row.created_at as string).toISOString();
    const findings = await pool.query(
      `SELECT count(*)::int AS count FROM findings
        WHERE mission_id = $1 AND created_at > $2 AND ($3::uuid IS NULL OR task_id = $3)`,
      [missionId, since, taskId],
    );
    const newFindings = Number(findings.rows[0]?.count ?? 0);
    const urls = await pool.query(
      `SELECT count(DISTINCT p.url)::int AS count
         FROM proxy_traffic p
        WHERE p.mission_id = $1 AND p.kind = 'target' AND p.observed_at > $2
          AND NOT EXISTS (
            SELECT 1 FROM proxy_traffic q
             WHERE q.mission_id = $1 AND q.url = p.url AND q.observed_at <= $2
          )`,
      [missionId, since],
    );
    const newUrls = Number(urls.rows[0]?.count ?? 0);
    const improved = newFindings > 0 || newUrls > 0;
    await pool.query(
      `UPDATE watchdog_observations
          SET outcome = $2, outcome_detail = $3, outcome_checked_at = now()
        WHERE id = $1 AND outcome = 'pending'`,
      [observationId, improved ? 'progress' : 'no_progress', JSON.stringify({ newFindings, newUrls })],
    );
    if (improved) progress += 1;
    else noProgress += 1;
  }
  return { checked: progress + noProgress, progress, noProgress };
}
