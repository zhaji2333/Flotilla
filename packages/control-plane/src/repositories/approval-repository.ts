import { z } from 'zod';
import { getPool } from '../db';
import { getApproval, type ApprovalRow } from './read-repository';
import { applyScopeUpgrade, resolveFindingReview } from './grant-repository';
import { cancelTask } from './task-control-repository';

// ── Approval center writes (P1-γ) ──────────────────────────
// Humans decide pending approvals here; decisions are audited in `events`.
// Grant mutation is still a separate, explicitly reviewed step.

export const CreateApprovalSchema = z.object({
  missionId: z.string().uuid(),
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const DecideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1).max(120).optional(),
  note: z.string().max(2_000).optional(),
}).strict();

export async function createApproval(input: z.infer<typeof CreateApprovalSchema>): Promise<{ approvalId: string }> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO approvals (mission_id, type, status, payload) VALUES ($1,$2,'pending',$3) RETURNING id`,
    [input.missionId, input.type, JSON.stringify(input.payload)],
  );
  const approvalId = String(result.rows[0].id);
  await pool.query(
    `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'approval.requested',$2,$3)`,
    [input.missionId, approvalId, JSON.stringify({ type: input.type })],
  );
  return { approvalId };
}

export async function decideApproval(
  id: string,
  input: z.infer<typeof DecideApprovalSchema>,
): Promise<ApprovalRow> {
  const pool = getPool();
  const existing = await getApproval(id);
  if (!existing) throw new Error(`approval ${id} not found`);
  if (existing.status !== 'pending') throw new Error(`approval ${id} is already ${existing.status}`);
  const payload = { ...existing.payload, note: input.note ?? null };
  const updated = await pool.query(
    `UPDATE approvals
     SET status = $2, decided_by = $3, decided_at = now(), payload = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id, input.decision, input.decidedBy ?? 'console', JSON.stringify(payload)],
  );
  if (updated.rowCount === 0) throw new Error(`approval ${id} was decided concurrently`);
  await pool.query(
    `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'approval.resolved',$2,$3)`,
    [existing.missionId, id, JSON.stringify({ decision: input.decision, decidedBy: input.decidedBy ?? 'console' })],
  );
  // P2 side effects: approved scope upgrades create a new immutable grant
  // version and rebind open tasks; finding reviews close the review queue.
  if (existing.type === 'scope_upgrade' && input.decision === 'approved') {
    await applyScopeUpgrade(id);
  }
  await resolveFindingReview(id, input.decision);
  // Watchdog escalation (ADR-0039): approving a stalled-task review cancels the
  // task; rejecting it clears the stall streak so the task keeps running.
  if (existing.type === 'stalled_task') {
    const taskId = typeof existing.payload.taskId === 'string' ? existing.payload.taskId : '';
    if (taskId) {
      if (input.decision === 'approved') {
        await cancelTask(existing.missionId, taskId, input.decidedBy ?? 'watchdog-review', 'cancelled by stalled-task review')
          .catch(async () => {
            // The task may already be terminal; record the decision anyway.
            await pool.query(
              `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
               VALUES ($1,'watchdog.stall_review_noop',$2,$3)`,
              [existing.missionId, id, JSON.stringify({ taskId })],
            );
          });
      } else {
        await pool.query(
          `UPDATE watchdog_task_state SET stalled_streak = 0, escalated_streak = 0, last_observed_at = now()
            WHERE task_id = $1`,
          [taskId],
        );
      }
    }
  }
  const resolved = await getApproval(id);
  if (!resolved) throw new Error(`approval ${id} disappeared`);
  return resolved;
}

// ── Command gate human fallback ─────────────────────────────
// The command guard only requests these when its cheap model could not return
// a parseable decision. A pending/approved/rejected review is reused for the
// same mission+task+command hash so retries cannot spam the approval queue.

export interface CommandReviewInput {
  missionId: string;
  taskId: string;
  command: string;
  commandHash: string;
  reason: string;
}

export interface CommandReviewState {
  approvalId: string;
  status: 'pending' | 'approved' | 'rejected';
}

export async function findCommandReview(
  missionId: string,
  taskId: string,
  commandHash: string,
): Promise<CommandReviewState | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, status FROM approvals
     WHERE mission_id = $1 AND type = 'command_review'
       AND payload->>'taskId' = $2 AND payload->>'commandHash' = $3
     ORDER BY created_at DESC LIMIT 1`,
    [missionId, taskId, commandHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { approvalId: String(row.id), status: String(row.status) as CommandReviewState['status'] };
}

export async function requestCommandReview(input: CommandReviewInput): Promise<CommandReviewState> {
  const existing = await findCommandReview(input.missionId, input.taskId, input.commandHash);
  if (existing) return existing;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-check under a transaction to collapse concurrent guard retries.
    const again = await client.query(
      `SELECT id, status FROM approvals
       WHERE mission_id = $1 AND type = 'command_review'
         AND payload->>'taskId' = $2 AND payload->>'commandHash' = $3
       ORDER BY created_at DESC LIMIT 1`,
      [input.missionId, input.taskId, input.commandHash],
    );
    if (again.rows[0]) {
      await client.query('ROLLBACK');
      return { approvalId: String(again.rows[0].id), status: String(again.rows[0].status) as CommandReviewState['status'] };
    }
    const inserted = await client.query(
      `INSERT INTO approvals (mission_id, type, status, payload)
       VALUES ($1,'command_review','pending',$2) RETURNING id`,
      [input.missionId, JSON.stringify({
        taskId: input.taskId,
        command: input.command.slice(0, 4_000),
        commandHash: input.commandHash,
        reason: input.reason.slice(0, 500),
      })],
    );
    const approvalId = String(inserted.rows[0].id);
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
       VALUES ($1,'approval.requested',$2,$3)`,
      [input.missionId, approvalId, JSON.stringify({ type: 'command_review', taskId: input.taskId, commandHash: input.commandHash })],
    );
    await client.query('COMMIT');
    return { approvalId, status: 'pending' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
