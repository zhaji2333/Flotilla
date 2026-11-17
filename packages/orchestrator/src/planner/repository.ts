import { randomUUID } from 'node:crypto';
import { getMissionOverview, getRuntimeSettings } from '@src-agent/control-plane';
import type { Pool } from 'pg';
import { finalizeMissionState } from '../repositories/worker-repository.js';
import { isPlanCreateBlockedByPhase } from '../scheduler/mission-phase.js';
import { buildCoverageRepairObjective, needsCoverageRepair } from './coverage.js';
import { computePlannerPriority } from './roi.js';
import { getMissionFrontier } from '@src-agent/control-plane';
import {
  parsePlan,
  resolveDependencies,
  resolvePlanRef,
  taskFingerprint,
  validatePlan,
} from './plan.js';
import {
  PlannerPlanError,
  type PlannerPlan,
  type PlannerSignal,
  type PlannerSnapshot,
  type PlannerTaskSummary,
} from './types.js';

// ── Planner repository ──────────────────────────────────────
// Single-writer lease + batched signal claim + transactional plan application.
// The Planner model never writes here directly: applyPlannerPlan validates and
// applies the plan in one transaction, like the worker report path.

const OPEN_TASK_STATES = ['proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked'];
const ACTIVE_MISSION_STATES = ['pending', 'running', 'active'];
const FRONTIER_FACT_LIMIT = Math.max(1, Math.min(100, Number(process.env.PLANNER_FRONTIER_FACT_LIMIT || 20) || 20));
const FRONTIER_INTENT_LIMIT = Math.max(1, Math.min(100, Number(process.env.PLANNER_FRONTIER_INTENT_LIMIT || 20) || 20));
// P3-B1: frontier injection is feature-flagged so the A/B evaluation can run
// the same Planner state with and without the typed blackboard.


export interface PlannerJob {
  runId: string;
  missionId: string;
  owner: string;
  signals: PlannerSignal[];
}

export interface ClaimPlannerJobOptions {
  owner: string;
  debounceMs: number;
  leaseMs: number;
  maxSignals?: number;
}

export async function claimPlannerJob(pool: Pool, options: ClaimPlannerJobOptions): Promise<PlannerJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query(
      `SELECT m.id
       FROM missions m
       LEFT JOIN reason_lease l ON l.mission_id = m.id
       WHERE m.state = ANY($1::text[])
         AND (l.lease_until IS NULL OR l.lease_until < now())
         AND EXISTS (
           SELECT 1 FROM planner_signals s
           WHERE s.mission_id = m.id AND s.state = 'pending'
             AND s.created_at <= now() - ($2::int * interval '1 millisecond')
         )
       ORDER BY m.updated_at ASC
       LIMIT 1
       FOR UPDATE OF m SKIP LOCKED`,
      [ACTIVE_MISSION_STATES, options.debounceMs],
    );
    if (candidate.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }
    const missionId = String(candidate.rows[0].id);
    await client.query(
      `INSERT INTO reason_lease (mission_id, lease_owner, fence, acquired_at, lease_until, last_reason_at, updated_at)
       VALUES ($1, $2, 1, now(), now() + ($3::int * interval '1 millisecond'), NULL, now())
       ON CONFLICT (mission_id) DO UPDATE
       SET lease_owner = excluded.lease_owner,
           fence = reason_lease.fence + 1,
           acquired_at = now(),
           lease_until = excluded.lease_until,
           updated_at = now()`,
      [missionId, options.owner, options.leaseMs],
    );
    const run = await client.query(
      `INSERT INTO planner_runs (mission_id, state, started_at) VALUES ($1, 'running', now()) RETURNING id`,
      [missionId],
    );
    const runId = String(run.rows[0].id);
    const claimed = await client.query(
      `WITH candidates AS (
         SELECT id FROM planner_signals
         WHERE mission_id = $1 AND state = 'pending'
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE planner_signals s
       SET state = 'consumed', consumed_by_run = $3, consumed_at = now()
       FROM candidates c
       WHERE s.id = c.id
       RETURNING s.id, s.kind, s.payload, s.created_at`,
      [missionId, options.maxSignals ?? 20, runId],
    );
    await client.query('COMMIT');
    return {
      runId,
      missionId,
      owner: options.owner,
      signals: claimed.rows.map(row => ({
        id: String(row.id),
        kind: String(row.kind),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadPlannerSnapshot(pool: Pool, missionId: string): Promise<PlannerSnapshot> {
  const [mission, tasks, findings, assets, todo] = await Promise.all([
    pool.query(`SELECT name, state, objective, target, success_criteria, checkpoint FROM missions WHERE id = $1`, [missionId]),
    pool.query(
      `SELECT id, type, state, payload->>'objective' AS objective, attempt, depends_on, last_error
       FROM tasks WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [missionId],
    ),
    pool.query(
      `SELECT id, title, artifact, status FROM findings WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [missionId],
    ),
    pool.query(`SELECT type, value FROM assets WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 50`, [missionId]),
    pool.query(
      `SELECT id, content, status, position FROM mission_todo WHERE mission_id = $1 ORDER BY position ASC LIMIT 50`,
      [missionId],
    ),
  ]);
  if (mission.rowCount === 0) throw new PlannerPlanError(`mission ${missionId} not found`);
  const row = mission.rows[0];
  const target = (row.target ?? {}) as { type?: string; value?: string };
  const settings = await getRuntimeSettings(pool);
  const frontier = (settings['planner.frontierEnabled'] ?? true)
    ? await getMissionFrontier(pool, missionId, { factLimit: FRONTIER_FACT_LIMIT, intentLimit: FRONTIER_INTENT_LIMIT })
    : null;
  const overview = await getMissionOverview(pool, missionId, { maxChars: 8_000 }).catch(() => null);
  return {
    mission: {
      id: missionId,
      name: String(row.name),
      state: String(row.state),
      objective: String(row.objective ?? ''),
      targetType: String(target.type ?? 'url'),
      targetValue: String(target.value ?? ''),
      checkpoint: (row.checkpoint ?? {}) as Record<string, unknown>,
    },
    tasks: tasks.rows.map((task): PlannerTaskSummary => ({
      id: String(task.id),
      type: String(task.type),
      state: String(task.state),
      objective: String(task.objective ?? ''),
      attempt: Number(task.attempt),
      dependsOn: (task.depends_on ?? []) as string[],
      lastError: task.last_error ? String(task.last_error) : null,
    })),
    findings: findings.rows.map(finding => ({
      id: String(finding.id),
      title: String(finding.title),
      artifact: finding.artifact ? String(finding.artifact) : null,
      status: String(finding.status),
    })),
    assets: assets.rows.map(asset => ({ type: String(asset.type), value: String(asset.value) })),
    ...(frontier ? { frontier } : {}),
    ...(overview ? {
      facts: overview.facts.items.map(fact => ({
        id: fact.id, kind: fact.kind, key: fact.key, value: fact.value, summary: fact.summary,
        trust: fact.trust, sensitive: fact.sensitive, provenance: fact.provenance, taskId: fact.taskId,
      })),
      hints: overview.hints.items,
      negatives: overview.negatives,
      traceSummary: overview.traces,
      coverage: overview.coverage,
      budget: overview.budget,
      overviewVersion: overview.version,
    } : {}),
    todo: todo.rows.map(item => ({
      id: String(item.id),
      content: String(item.content),
      status: String(item.status),
      position: Number(item.position),
    })),
  };
}

function triggerAngle(raw: string | undefined): string | null {
  return raw === 'web' || raw === 'api' || raw === 'infra' || raw === 'binary' ? raw : null;
}

export interface AppliedPlan {
  createdTasks: number;
  todos: number;
  hints: number;
  cancelled: number;
  checkpointUpdated: boolean;
}

export async function applyPlannerPlan(
  pool: Pool,
  job: PlannerJob,
  plan: PlannerPlan,
  snapshot: PlannerSnapshot,
): Promise<AppliedPlan> {
  const knownTaskIds = new Set(snapshot.tasks.map(task => task.id));
  const openTaskIds = new Set(snapshot.tasks.filter(task => OPEN_TASK_STATES.includes(task.state)).map(task => task.id));
  const settings = await getRuntimeSettings(pool);
  const validated = validatePlan(plan, { knownTaskIds, openTaskIds });
  const parallelTasks = settings['planner.parallelTasks'] ?? 3;
  if (validated.creates.length > parallelTasks) {
    throw new PlannerPlanError(`create_task: plan creates ${validated.creates.length} tasks, exceeding runtime setting planner.parallelTasks=${parallelTasks}`);
  }
  const maxOpenTasks = settings['planner.maxOpenTasks'] ?? 3;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(`SELECT state FROM planner_runs WHERE id = $1 FOR UPDATE`, [job.runId]);
    if (run.rowCount === 0 || run.rows[0].state !== 'running') {
      throw new PlannerPlanError(`planner run ${job.runId} is not running`);
    }
    const mission = await client.query(
      `SELECT target, objective, success_criteria, grant_id, grant_version, phase FROM missions WHERE id = $1 FOR UPDATE`,
      [job.missionId],
    );
    if (mission.rowCount === 0) throw new PlannerPlanError(`mission ${job.missionId} not found`);
    const missionRow = mission.rows[0];
    // v1.0.2: reporting/closed missions may not create new attack tasks. The
    // plan may still update todos/hints/checkpoints so the Planner can steer
    // the reporting endgame.
    if (process.env.V102_MISSION_DEADLINE !== '0' && isPlanCreateBlockedByPhase(String(missionRow.phase ?? 'active'), plan.actions)) {
      throw new PlannerPlanError(`mission is in ${String(missionRow.phase)} phase; creating new tasks is not allowed`);
    }
    const target = (missionRow.target ?? {}) as { value?: string };
    const targetValue = String(target.value ?? '');
    // B4: intentional parallelism is capped at two distinct angles per mission.
    const activeAngles = new Set<string>(
      (await client.query(
        `SELECT DISTINCT angle FROM tasks
         WHERE mission_id = $1 AND angle IS NOT NULL
           AND state IN ('proposed','ready','leased','running','retry_wait','blocked')`,
        [job.missionId],
      )).rows.map(row => String(row.angle)),
    );

    // v1.0.2 ROI ordering (ADR-0054): generic features only; reserved slot for
    // pending high-value coverage. Disabled by default (V102_PLANNER_ROI).
    let pendingCoverageCount = 0;
    if (process.env.V102_PLANNER_ROI === '1') {
      const pending = await client.query(
        `SELECT count(*)::int AS count FROM coverage_requirements
          WHERE mission_id = $1 AND status = 'pending'`,
        [job.missionId],
      );
      pendingCoverageCount = Number(pending.rows[0]?.count ?? 0);
    }
    const createPriority = process.env.V102_PLANNER_ROI === '1'
      ? computePlannerPriority({
          targetCriticality: 0.5,
          coverageGap: pendingCoverageCount,
          priorAttempts: 0,
          expectedFindings: 0.5,
          expensiveTools: 0,
          remainingBudgetMs: 1_200_000,
        })
      : 0.5;

    let createdTasks = 0;
    let createdThisPlan = 0;
    let todos = 0;
    let hints = 0;
    let cancelled = 0;
    let checkpointUpdated = false;
    const createIdByAction = new Map<number, string>(validated.creates.map(create => [create.actionIndex, create.id]));

    for (const [actionIndex, action] of plan.actions.entries()) {
      if (action.type === 'create_task') {
        if (openTaskIds.size + createdThisPlan >= maxOpenTasks) {
          throw new PlannerPlanError(`create_task: open task limit ${maxOpenTasks} reached (open=${openTaskIds.size}, new=${createdThisPlan})`);
        }
        const id = createIdByAction.get(actionIndex) ?? randomUUID();
        const dependsOn = resolveDependencies(action.dependsOn, validated.creates);
        const objective = action.objective.slice(0, 2_000);
        const angle = triggerAngle(action.angle);
        if (angle && !activeAngles.has(angle)) {
          if (activeAngles.size >= 2) {
            throw new PlannerPlanError(`create_task: angle ${angle} would exceed the 2 parallel-angle limit (active: ${[...activeAngles].join(',')})`);
          }
          activeAngles.add(angle);
        }
        await client.query(
          `INSERT INTO tasks
             (id, mission_id, type, state, depends_on, grant_id, grant_version, budget, payload,
              success_criteria, fingerprint, idempotency_key, priority, planner_run_id, angle)
           VALUES ($1,$2,'intent','proposed',$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$13,$11,$12)`,
          [
            id,
            job.missionId,
            dependsOn,
            missionRow.grant_id,
            missionRow.grant_version,
            JSON.stringify({ maxSteps: 0, maxWallClockMs: 1_200_000 }),
            JSON.stringify({ objective, targetUrl: targetValue, kind: 'intent', ...(angle ? { angle } : {}) }),
            JSON.stringify({}),
            taskFingerprint(objective, targetValue, angle),
            `planner:${job.runId}:${actionIndex}`,
            job.runId,
            angle ?? null,
            createPriority,
          ],
        );
        await client.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.created',$2,$3)`,
          [job.missionId, id, JSON.stringify({ type: 'intent', state: 'proposed', dependsOn, ...(angle ? { angle } : {}) })],
        );
        createdTasks += 1;
        createdThisPlan += 1;
      } else if (action.type === 'update_todo') {
        const updated = await client.query(
          `UPDATE mission_todo SET status = $3, updated_at = now() WHERE id = $1 AND mission_id = $2`,
          [action.todoId, job.missionId, action.status],
        );
        if (updated.rowCount === 0) throw new PlannerPlanError(`update_todo: todo ${action.todoId} not found in mission`);
      } else if (action.type === 'add_todo') {
        const position = action.position ?? await nextTodoPosition(client, job.missionId);
        await client.query(
          `INSERT INTO mission_todo (mission_id, content, status, position) VALUES ($1,$2,'pending',$3)`,
          [job.missionId, action.content, position],
        );
        todos += 1;
      } else if (action.type === 'update_checkpoint') {
        await client.query(
          `UPDATE missions SET checkpoint = checkpoint || $2::jsonb, updated_at = now() WHERE id = $1`,
          [job.missionId, JSON.stringify({ summary: action.summary, runId: job.runId, at: new Date().toISOString() })],
        );
        checkpointUpdated = true;
      } else if (action.type === 'add_hint') {
        const hintTaskId = action.taskId ? resolvePlanRef(action.taskId, validated.creates) : null;
        await client.query(
          `INSERT INTO task_hints (mission_id, task_id, content, source, kind) VALUES ($1,$2,$3,'planner',$4)`,
          [job.missionId, hintTaskId, action.content, action.kind ?? 'guidance'],
        );
        hints += 1;
      } else if (action.type === 'cancel_task') {
        const cancelTaskId = resolvePlanRef(action.taskId, validated.creates);
        // Summary is the platform's bounded coverage review, not a competing
        // attack task; a Planner cancellation must never remove it.
        const target = await client.query(`SELECT type FROM tasks WHERE id = $1 LIMIT 1`, [cancelTaskId]);
        if (target.rows[0]?.type === 'summary') continue;
        const updated = await client.query(
          `UPDATE tasks SET state = 'cancelled', completed_at = now() WHERE id = $1 AND state = ANY($2::text[])`,
          [cancelTaskId, OPEN_TASK_STATES],
        );
        if (updated.rowCount === 0) throw new PlannerPlanError(`cancel_task: task ${cancelTaskId} is not open`);
        // Replay reconstructs state from events; write the cancellation event in
        // the same transaction so a planner-cancelled task never drifts from the
        // live projection.
        await client.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.cancelled',$2,$3)`,
          [job.missionId, cancelTaskId, JSON.stringify({ source: 'planner', runId: job.runId, reason: action.reason ?? null })],
        );
        // ADR-0039 auto-cancel: if this cancellation answers a watchdog stall
        // escalation, close the pending human review instead of leaving a stale
        // approval for a task that no longer exists in open state, and clear the
        // stall bookkeeping.
        const staleReviews = await client.query(
          `UPDATE approvals
              SET status = 'rejected', decided_by = 'planner:auto', decided_at = now(),
                  payload = payload || $3::jsonb
            WHERE mission_id = $1 AND type = 'stalled_task' AND status = 'pending'
              AND payload->>'taskId' = $2
            RETURNING id`,
          [
            job.missionId,
            cancelTaskId,
            JSON.stringify({ resolution: 'planner_cancelled', reason: action.reason ?? null }),
          ],
        );
        for (const approvalRow of staleReviews.rows) {
          await client.query(
            `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'approval.resolved',$2,$3)`,
            [
              job.missionId,
              String(approvalRow.id),
              JSON.stringify({ decision: 'rejected', decidedBy: 'planner:auto', source: 'watchdog_stall' }),
            ],
          );
        }
        await client.query(`DELETE FROM watchdog_task_state WHERE task_id = $1`, [cancelTaskId]);
        cancelled += 1;
      }
    }

    // v1.0.2 coverage invariant (ADR-0054): if the plan creates no task while a
    // required target/attack surface is still pending, auto-repair with a
    // generic assessment task instead of silently closing the mission.
    if (process.env.V102_PLANNER_COVERAGE_INVARIANT === '1' && validated.creates.length === 0) {
      const requirements = await client.query(
        `SELECT target_ref, attack_surface, status FROM coverage_requirements
          WHERE mission_id = $1 AND status = 'pending' ORDER BY target_ref, attack_surface LIMIT 3`,
        [job.missionId],
      );
      const pending = requirements.rows.map(row => ({
        targetRef: String(row.target_ref),
        attackSurface: String(row.attack_surface),
        status: String(row.status) as 'pending',
        evidenceRef: null,
        disposition: null,
      }));
      if (needsCoverageRepair(pending as never, 0)) {
        for (const requirement of pending.slice(0, 2)) {
          const id = randomUUID();
          await client.query(
            `INSERT INTO tasks
               (id, mission_id, type, state, depends_on, grant_id, grant_version, budget, payload,
                success_criteria, fingerprint, idempotency_key, priority, planner_run_id)
             VALUES ($1,$2,'intent','proposed','{}'::uuid[],$3,$4,$5,$6,$7,$8,$9,0.9,$10)`,
            [
              id,
              job.missionId,
              missionRow.grant_id,
              missionRow.grant_version,
              JSON.stringify({ maxSteps: 0, maxWallClockMs: 1_200_000 }),
              JSON.stringify({ objective: buildCoverageRepairObjective(requirement), kind: 'coverage_repair', targetUrl: targetValue }),
              JSON.stringify({}),
              taskFingerprint(buildCoverageRepairObjective(requirement), targetValue),
              `planner:${job.runId}:coverage:${requirement.targetRef}`.slice(0, 200),
              job.runId,
            ],
          );
          await client.query(
            `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'task.created',$2,$3)`,
            [job.missionId, id, JSON.stringify({ type: 'intent', state: 'proposed', coverageRepair: true, targetRef: requirement.targetRef })],
          );
          createdTasks += 1;
        }
      }
    }

    // A plan may cancel the last open task. Re-run ADR-0012 aggregation so the
    // mission does not stay `running` with no dispatchable work.
    const final = await finalizeMissionState(client, job.missionId);
    if (final.state !== 'running') {
      await client.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
        [
          job.missionId,
          `mission.${final.state}`,
          job.missionId,
          JSON.stringify({
            source: 'planner',
            runId: job.runId,
            doneTasks: final.doneTasks,
            failedTasks: final.failedTasks,
            acceptedFindings: final.acceptedFindings,
            artifacts: final.artifacts,
            failureClass: final.state === 'failed' ? 'no_progress' : null,
          }),
        ],
      );
    }
    const applied: AppliedPlan = { createdTasks, todos, hints, cancelled, checkpointUpdated };
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'planner.plan_applied',$2,$3)`,
      [job.missionId, job.runId, JSON.stringify({ ...applied, signalCount: job.signals.length, actions: plan.actions.length })],
    );
    await client.query(
      `UPDATE planner_runs SET state = 'completed', reason = $2, action_count = $3,
              plan = $4, finished_at = now() WHERE id = $1`,
      [job.runId, plan.analysis.slice(0, 2_000), plan.actions.length, JSON.stringify(plan)],
    );
    await client.query(
      `UPDATE reason_lease SET lease_until = now(), last_reason_at = now(), updated_at = now()
       WHERE mission_id = $1 AND lease_owner = $2`,
      [job.missionId, job.owner],
    );
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function nextTodoPosition(client: import('pg').PoolClient, missionId: string): Promise<number> {
  const result = await client.query(`SELECT COALESCE(MAX(position), -1) + 1 AS position FROM mission_todo WHERE mission_id = $1`, [missionId]);
  return Number(result.rows[0].position);
}

export async function completePlannerRun(
  pool: Pool,
  runId: string,
  sessionId: string | undefined,
  metrics: { steps?: number; tokens?: Record<string, number> } = {},
): Promise<void> {
  await pool.query(
    `UPDATE planner_runs SET state = 'completed', session_id = COALESCE($2, session_id),
            steps = COALESCE($3, steps), tokens = COALESCE($4, tokens), finished_at = now()
     WHERE id = $1`,
    [runId, sessionId ?? null, metrics.steps ?? null, metrics.tokens ? JSON.stringify(metrics.tokens) : null],
  ).catch(() => undefined);
}

export async function failPlannerRun(pool: Pool, job: PlannerJob, message: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE planner_runs SET state = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
      job.runId,
      message.slice(0, 4_000),
    ]);
    // Requeue this run's signals so the next reason pass sees them.
    await client.query(
      `UPDATE planner_signals SET state = 'pending', consumed_by_run = NULL, consumed_at = NULL
       WHERE consumed_by_run = $1 AND state = 'consumed'`,
      [job.runId],
    );
    await client.query(
      `UPDATE reason_lease SET lease_until = now(), updated_at = now() WHERE mission_id = $1 AND lease_owner = $2`,
      [job.missionId, job.owner],
    );
    await client.query('COMMIT');
  } catch (rollbackError) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw rollbackError;
  } finally {
    client.release();
  }
}

export { parsePlan };
