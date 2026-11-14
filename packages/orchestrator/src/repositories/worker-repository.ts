import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  GrantScopeSchema,
  MissionTargetSchema,
  type GrantScope,
  type MissionSummary,
  type MissionTarget,
  type ReportFinding,
  type TaskState,
} from '@src-agent/contracts';
import { evaluateReadiness } from '../scheduler/readiness.js';
import { evaluateCoverageGate, type CoverageGateResult } from './coverage-gate.js';
import { MAX_TASK_ATTEMPTS, stateAfterFailedReport } from '../scheduler/state-machine.js';
import { recordFindingTriggers } from './trigger-repository.js';
import { resolveFollowUpLimit, selectFollowUpGaps } from '../summary/followups.js';
import { autoReviewFinding, curateWithEvidence, type EvidenceContext } from '@src-agent/curator';

// ── Worker repository ───────────────────────────────────────
// The database is the source of truth for missions, tasks, evidence and
// findings. Everything the worker needs to run a task is loaded here; nothing
// about a mission is hardcoded in the worker image.
//
// P1: task lifecycle is driven by the scheduler helpers in `src/scheduler` and
// every report is fenced by the token issued at claim time.

/** PostgreSQL text/JSONB cannot store NUL bytes produced by binary tool output. */
function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stripNul(item)]));
  }
  return value;
}

export interface TaskBudget {
  // Safety limits only: no token/cost cap is enforced per task.
  maxSteps: number;
  maxWallClockMs: number;
}

export interface ClaimedTask {
  taskId: string;
  type: string;
  missionId: string;
  grantId: string;
  grantVersion: number;
  fencingToken: number;
  attempt: number;
  leaseExpiresAt: string;
  /** Error from the previous failed attempt, used for the recovery note. */
  lastError?: string;
  budget: TaskBudget;
  payload: Record<string, unknown>;
  mission: {
    id: string;
    name: string;
    target: MissionTarget;
    objective: string;
  };
  scope: GrantScope;
}

export interface EvidenceInput {
  trafficRef: string;
  kind: 'target' | 'internet';
  method: string;
  url: string;
  requestText: string;
  responseText: string;
  requestSha256: string;
  responseSha256: string;
  requestBytes: number;
  responseBytes: number;
  untrusted: boolean;
}

export interface AssetInput {
  type: string;
  value: string;
  notes?: string;
}

export interface FindingInput {
  title: string;
  category: string;
  severity: ReportFinding['severity'];
  /** Legacy rows may still say 'review'; persisted as 'needs_review'. */
  status: 'accepted' | 'needs_review' | 'review';
  artifact?: string;
  reportMd: string;
  evidenceIds: string[];
  curatorReasons: string[];
  claimsAnonymous?: boolean;
  isCredentialLeak?: boolean;
}

export interface PersistedFinding {
  id: string;
  title: string;
  category: string;
  severity: ReportFinding['severity'];
  status: 'accepted' | 'needs_review' | 'rejected';
  artifact: string | null;
  confidence: 'observed' | 'inferred' | 'unverified';
  rootCauseKey: string;
  evidenceIds: string[];
  curatorReasons: string[];
  merged: boolean;
}

export class FencingError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} no longer belongs to this worker (stale fencing token)`);
    this.name = 'FencingError';
  }
}

const BudgetSchema = z.object({
  // 0 means unlimited (ARTEX defaults: max_turns=0, run wall clock=1200s).
  maxSteps: z.number().int().nonnegative().default(0),
  maxWallClockMs: z.number().int().nonnegative().default(1_200_000),
}).passthrough();

const TaskRowSchema = z.object({
  id: z.string(),
  type: z.string().default('explore'),
  mission_id: z.string(),
  grant_id: z.string(),
  grant_version: z.number(),
  fencing_token: z.number(),
  attempt: z.number(),
  lease_expires_at: z.union([z.string(), z.date()]),
  budget: z.unknown(),
  payload: z.unknown(),
  last_error: z.union([z.string(), z.null()]).optional(),
});

// ── Claim ───────────────────────────────────────────────────

/**
 * Atomically claim the highest-priority ready task. SKIP LOCKED lets multiple
 * workers coexist without stealing each other's work; the fencing token is
 * incremented on every claim so a zombie worker's report is rejected.
 */
export async function claimTask(pool: Pool, workerId: string, missionId?: string): Promise<ClaimedTask | null> {
  const claimed = await pool.query(
    `
      WITH candidate AS (
        SELECT id FROM tasks
        WHERE state = 'ready'
          AND ($2::uuid IS NULL OR mission_id = $2)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks t
      SET state = 'leased',
          lease_owner = $1,
          lease_expires_at = now() + interval '45 minutes',
          fencing_token = t.fencing_token + 1,
          attempt = t.attempt + 1,
          started_at = COALESCE(t.started_at, now())
      FROM candidate c
      WHERE t.id = c.id
      RETURNING t.id, t.type, t.mission_id, t.grant_id, t.grant_version, t.budget, t.payload,
                t.fencing_token, t.attempt, t.lease_expires_at, t.last_error
    `,
    [workerId, missionId ?? null],
  );
  const rawTask = claimed.rows[0];
  if (!rawTask) return null;
  const task = TaskRowSchema.parse(rawTask);

  const details = await pool.query(
    `
      SELECT m.name, m.target, m.objective, g.scope
      FROM missions m
      LEFT JOIN grants g ON g.id = m.grant_id AND g.version = m.grant_version
      WHERE m.id = $1
    `,
    [task.mission_id],
  );
  const mission = details.rows[0];
  if (!mission) throw new Error(`claimed task ${task.id} references missing mission ${task.mission_id}`);

  const target = MissionTargetSchema.parse(mission.target);
  const scope = GrantScopeSchema.parse(mission.scope ?? {});
  const budget = BudgetSchema.parse(task.budget);
  const leaseExpiresAt = new Date(task.lease_expires_at).toISOString();

  await pool.query(`UPDATE missions SET state = 'running', worker_id = $2, updated_at = now() WHERE id = $1`, [
    task.mission_id,
    workerId,
  ]);
  await recordEvent(pool, task.mission_id, 'task.claimed', task.id, {
    workerId,
    attempt: task.attempt,
    fencingToken: task.fencing_token,
    target,
    objective: mission.objective,
  });

  return {
    taskId: String(task.id),
    type: String(task.type ?? 'explore'),
    missionId: String(task.mission_id),
    grantId: String(task.grant_id),
    grantVersion: Number(task.grant_version),
    fencingToken: Number(task.fencing_token),
    attempt: Number(task.attempt),
    leaseExpiresAt,
    lastError: task.last_error ?? undefined,
    budget: { maxSteps: budget.maxSteps, maxWallClockMs: budget.maxWallClockMs },
    payload: (task.payload ?? {}) as Record<string, unknown>,
    mission: {
      id: String(task.mission_id),
      name: String(mission.name),
      target,
      objective: String(mission.objective ?? ''),
    },
    scope,
  };
}

/** leased → running, fenced by the claim token. */
export async function markTaskRunning(
  pool: Pool,
  taskId: string,
  workerId: string,
  fencingToken: number,
): Promise<void> {
  const result = await pool.query(
    `UPDATE tasks SET state = 'running'
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'leased'
     RETURNING id`,
    [taskId, fencingToken, workerId],
  );
  if (result.rowCount === 0) throw new FencingError(taskId);
}

/** Extend the lease; a stale token means the task was reassigned. */
export async function taskState(
  pool: Pool,
  taskId: string,
  fencingToken: number,
): Promise<{ state: string }> {
  const result = await pool.query(
    `SELECT state FROM tasks WHERE id = $1 AND fencing_token = $2`,
    [taskId, fencingToken],
  );
  if (result.rowCount === 0) throw new FencingError(taskId);
  return { state: String(result.rows[0].state) };
}

export async function heartbeatTask(
  pool: Pool,
  taskId: string,
  fencingToken: number,
  leaseMs = 600_000,
): Promise<void> {
  const result = await pool.query(
    `UPDATE tasks
     SET lease_expires_at = now() + ($3::int * interval '1 millisecond')
     WHERE id = $1 AND fencing_token = $2 AND state IN ('leased', 'running')
     RETURNING id`,
    [taskId, fencingToken, leaseMs],
  );
  if (result.rowCount === 0) throw new FencingError(taskId);
}

// ── Scheduler: lease expiry + readiness ─────────────────────

export function leaseRetryBackoffMs(attempt: number): number {
  const base = Number(process.env.WORKER_RETRY_BASE_MS || 15_000);
  return Math.min(base * Math.max(1, attempt), 120_000);
}

export interface ClaimedHint {
  id: string;
  content: string;
  source: string;
  kind: string;
}

/**
 * Claims pending hints for a task at a run boundary. Mission-wide hints
 * (task_id IS NULL) and task-specific hints are both delivered; claiming marks
 * them delivered so the same hint is never injected twice.
 */
export async function claimTaskHints(
  pool: Pool,
  missionId: string,
  taskId: string,
  limit = 8,
): Promise<ClaimedHint[]> {
  const result = await pool.query(
    `WITH candidates AS (
       SELECT id FROM task_hints
       WHERE mission_id = $1 AND state = 'pending' AND (task_id IS NULL OR task_id = $2)
       ORDER BY created_at ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE task_hints h
     SET state = 'delivered', delivered_at = now(), task_id = $2
     FROM candidates c
     WHERE h.id = c.id
     RETURNING h.id, h.content, h.source, h.kind`,
    [missionId, taskId, limit],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    content: String(row.content),
    source: String(row.source),
    kind: String(row.kind ?? 'guidance'),
  }));
}

export interface SchedulerTickResult {
  expired: number;
  exhausted: number;
  promoted: number;
  blocked: number;
  writeBlocked: number;
}

export async function schedulerTick(pool: Pool): Promise<SchedulerTickResult> {
  const expired = await pool.query(
    `UPDATE tasks
     SET state = CASE WHEN attempt >= $1 THEN 'exhausted' ELSE 'retry_wait' END,
         retry_after = CASE WHEN attempt >= $1 THEN NULL ELSE now() + ($2::int * interval '1 millisecond') END,
         last_error = COALESCE(last_error, 'lease expired'),
         lease_owner = NULL,
         lease_expires_at = NULL
     WHERE state IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
     RETURNING id, mission_id, state, attempt`,
    [MAX_TASK_ATTEMPTS, leaseRetryBackoffMs(1)],
  );
  for (const row of expired.rows) {
    await recordEvent(pool, row.mission_id, `task.${row.state}`, row.id, {
      reason: 'lease expired',
      attempt: row.attempt,
    });
  }
  let exhausted = 0;
  for (const row of expired.rows) {
    if (row.state === 'exhausted') {
      exhausted += 1;
      await finalizeMissionIfNoOpenTasks(pool, row.mission_id, 'task exhausted');
    }
  }

  const proposal = await pool.query(
    `SELECT t.id, t.mission_id, t.type, t.state, t.depends_on, t.attempt, t.fingerprint,
            m.state AS mission_state,
            (SELECT COALESCE(jsonb_object_agg(d.id::text, d.state), '{}'::jsonb)
               FROM tasks d WHERE d.id = ANY(t.depends_on)) AS dependency_states,
            EXISTS (
              SELECT 1 FROM tasks o
              WHERE o.mission_id = t.mission_id
                AND o.fingerprint = t.fingerprint
                AND o.fingerprint IS NOT NULL
                AND o.id <> t.id
                AND o.state IN ('proposed', 'ready', 'leased', 'running')
            ) AS fingerprint_conflict,
            EXISTS (
              SELECT 1 FROM action_ledger a
              WHERE a.mission_id = t.mission_id
                AND (a.task_id = t.id OR (a.task_id IS NULL AND a.observed_at >= COALESCE(t.started_at, t.created_at)))
                AND (t.write_actions_confirmed_at IS NULL OR a.observed_at > t.write_actions_confirmed_at)
            ) AS has_write_actions
     FROM tasks t
     JOIN missions m ON m.id = t.mission_id
     WHERE t.state = 'proposed'
        OR (t.state = 'retry_wait' AND (t.retry_after IS NULL OR t.retry_after <= now()))
     ORDER BY t.priority DESC, t.created_at ASC
     LIMIT 250`,
  );

  let promoted = 0;
  let blocked = 0;
  let writeBlocked = 0;
  for (const row of proposal.rows) {
    const dependencyStates = (row.dependency_states ?? {}) as Record<string, TaskState>;
    const verdict = evaluateReadiness({
      missionState: String(row.mission_state),
      dependsOn: (row.depends_on ?? []) as string[],
      dependencyStates,
      fingerprintConflict: Boolean(row.fingerprint_conflict),
      attempt: Number(row.attempt),
      budgetExhausted: false,
    });
    if (verdict.state === row.state) continue;
    // A retry must not silently repeat a target write. The proxy ledger is
    // authoritative; only a human confirmation endpoint can clear this block.
    if (verdict.state === 'ready' && Boolean(row.has_write_actions) && String(row.type) !== 'summary') {
      const writeBlockedUpdate = await pool.query(
        `UPDATE tasks SET state = 'blocked', last_error = 'write_actions_require_confirmation', retry_after = NULL
         WHERE id = $1 AND state = $2 RETURNING id`,
        [row.id, row.state],
      );
      if (writeBlockedUpdate.rowCount === 0) continue;
      writeBlocked += 1;
      blocked += 1;
      await recordEvent(pool, String(row.mission_id), 'task.blocked', String(row.id), {
        reason: 'write_actions_require_confirmation',
        from: row.state,
      });
      continue;
    }
    const updated = await pool.query(
      `UPDATE tasks SET state = $2, retry_after = NULL WHERE id = $1 AND state = $3 RETURNING id`,
      [row.id, verdict.state, row.state],
    );
    if (updated.rowCount === 0) continue;
    if (verdict.state === 'ready') promoted += 1;
    if (verdict.state === 'blocked' || verdict.state === 'stale' || verdict.state === 'exhausted') {
      blocked += 1;
      await finalizeMissionIfNoOpenTasks(pool, String(row.mission_id), 'no open tasks');
    }
    await recordEvent(pool, row.mission_id, `task.${verdict.state}`, row.id, { reason: verdict.reason });
  }

  return { expired: expired.rowCount ?? 0, exhausted, promoted, blocked, writeBlocked };
}

export interface MissionFinalState {
  state: 'running' | 'completed' | 'failed';
  openTasks: number;
  doneTasks: number;
  failedTasks: number;
  acceptedFindings: number;
  artifacts: number;
  coverageGate?: CoverageGateResult | null;
  summaryRequested?: boolean;
}

/**
 * ADR-0012 completion rule A. Once no task is open, the mission is completed
 * if any task reached done/verified or Curator accepted a finding; otherwise it
 * failed. Artifact count is an internal quality metric and never gates this.
 */
export async function finalizeMissionState(
  db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  missionId: string,
): Promise<MissionFinalState> {
  const open = await db.query(
    `SELECT count(*)::int AS count FROM tasks
     WHERE mission_id = $1
       AND state IN ('proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked')`,
    [missionId],
  );
  const openTasks = Number(open.rows[0]?.count ?? 0);
  const stats = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state IN ('done','verified'))::int AS done,
            count(*) FILTER (WHERE state IN ('failed','exhausted','stale','cancelled','handed_back'))::int AS failed
     FROM tasks WHERE mission_id = $1`,
    [missionId],
  );
  const findings = await db.query(
    `SELECT count(*)::int AS accepted,
            count(DISTINCT artifact) FILTER (WHERE artifact IS NOT NULL AND artifact <> '')::int AS artifacts
     FROM findings WHERE mission_id = $1 AND status = 'accepted'`,
    [missionId],
  );
  const doneTasks = Number(stats.rows[0]?.done ?? 0);
  const failedTasks = Number(stats.rows[0]?.failed ?? 0);
  const acceptedFindings = Number(findings.rows[0]?.accepted ?? 0);
  const artifacts = Number(findings.rows[0]?.artifacts ?? 0);
  if (openTasks > 0) {
    return { state: 'running', openTasks, doneTasks, failedTasks, acceptedFindings, artifacts };
  }
  // Summary/补漏: before declaring the mission complete/failed, run one
  // bounded read-only review over the mission's coverage and findings. The
  // summary task is an ordinary task, so the normal scheduler/claim/fencing
  // path applies. A failed summary falls through to normal completion.
  const mission = await db.query(
    `SELECT success_criteria, checkpoint FROM missions WHERE id = $1`,
    [missionId],
  );
  const criteria = (mission.rows[0]?.success_criteria ?? {}) as { coverageGate?: { enabled?: boolean; minRatio?: number; requireAcceptedFinding?: boolean } };
  const checkpoint = (mission.rows[0]?.checkpoint ?? {}) as { summary?: { runs?: number; state?: string } };
  const summaryTask = await db.query(`SELECT 1 FROM tasks WHERE mission_id = $1 AND type = 'summary' LIMIT 1`, [missionId]);
  const summarySettings = await db.query(
    `SELECT key, value FROM runtime_settings WHERE key IN ('worker.summaryEnabled','worker.summaryMaxRounds')`,
  );
  const summarySettingMap = new Map(summarySettings.rows.map(row => [String(row.key), row.value]));
  const summaryEnabled = process.env.SUMMARY_ENABLED === '0'
    ? false
    : summarySettingMap.has('worker.summaryEnabled')
      ? summarySettingMap.get('worker.summaryEnabled') !== false
      : true;
  if (summaryEnabled && (doneTasks > 0 || acceptedFindings > 0) && (summaryTask.rowCount ?? 0) === 0) {
    const runs = Number(checkpoint.summary?.runs ?? 0);
    const maxRounds = Math.max(0, Number(summarySettingMap.get('worker.summaryMaxRounds') ?? process.env.SUMMARY_MAX_ROUNDS ?? 1));
    if (runs < maxRounds) {
      const summaryBudget = {
        maxSteps: Math.max(1, Number(process.env.SUMMARY_MAX_STEPS || 60)),
        maxWallClockMs: Math.max(10_000, Number(process.env.SUMMARY_WALL_CLOCK_MS || 300_000)),
      };
      const task = await db.query(
        `INSERT INTO tasks (mission_id, type, state, grant_id, grant_version, budget, payload, priority)
         SELECT id, 'summary', 'proposed', grant_id, grant_version, $2::jsonb, $3::jsonb, 1
         FROM missions WHERE id = $1 RETURNING id`,
        [
          missionId,
          JSON.stringify(summaryBudget),
          JSON.stringify({ summary: true, objective: 'Review mission coverage, gaps and missing evidence; produce a bounded summary.' }),
        ],
      );
      await db.query(
        `UPDATE missions SET checkpoint = checkpoint || jsonb_build_object(
           'summary', jsonb_build_object('runs', $2::int, 'state', 'pending', 'requestedAt', now())
         ), updated_at = now() WHERE id = $1`,
        [missionId, runs + 1],
      );
      await db.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'mission.summary_requested',$2,$3)`,
        [missionId, String(task.rows[0]?.id ?? missionId), JSON.stringify({ runs: runs + 1, maxRounds })],
      );
      return { state: 'running', openTasks, doneTasks, failedTasks, acceptedFindings, artifacts, summaryRequested: true };
    }
  }
  const gate = criteria.coverageGate;
  let coverageGate: MissionFinalState['coverageGate'] = null;
  let gateFailure: string | null = null;
  if (gate && gate.enabled !== false) {
    const coverage = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (
                WHERE a.task_id IS NOT NULL
                   OR EXISTS (SELECT 1 FROM evidence e WHERE e.mission_id = a.mission_id AND e.url LIKE '%' || a.value || '%')
                   OR EXISTS (SELECT 1 FROM mission_facts f WHERE f.mission_id = a.mission_id AND (f.value LIKE '%' || a.value || '%' OR f.key LIKE '%' || a.value || '%'))
              )::int AS covered
       FROM assets a WHERE a.mission_id = $1`,
      [missionId],
    );
    const total = Number(coverage.rows[0]?.total ?? 0);
    const covered = Number(coverage.rows[0]?.covered ?? 0);
    coverageGate = evaluateCoverageGate(gate, total, covered, acceptedFindings);
    if (coverageGate && !coverageGate.passed) gateFailure = coverageGate.failure ?? 'coverage_below_target';
  }
  const completed = (doneTasks > 0 || acceptedFindings > 0) && gateFailure === null;
  const state = completed ? 'completed' : 'failed';
  await db.query(
    `UPDATE missions
     SET state = $2, failure_class = $3, completed_at = now(), updated_at = now()
     WHERE id = $1 AND state IN ('pending', 'running', 'active')`,
    [missionId, state, completed ? null : (gateFailure ?? 'no_progress')],
  );
  // Reconcile the planner's todo cursor: terminal mission => no todo should
  // remain pending/in_progress. (Tasks remain the execution source of truth.)
  await db.query(
    `UPDATE mission_todo SET status = 'done', updated_at = now()
     WHERE mission_id = $1 AND status IN ('pending','in_progress')`,
    [missionId],
  );
  return { state, openTasks, doneTasks, failedTasks, acceptedFindings, artifacts, coverageGate };
}

async function finalizeMissionIfNoOpenTasks(pool: Pool, missionId: string, reason: string): Promise<void> {
  const result = await finalizeMissionState(pool, missionId);
  if (result.state === 'completed' || result.state === 'failed') {
    await recordEvent(pool, missionId, `mission.${result.state}`, missionId, {
      reason,
      tasks: result.openTasks + result.doneTasks + result.failedTasks,
      doneTasks: result.doneTasks,
      failedTasks: result.failedTasks,
      acceptedFindings: result.acceptedFindings,
      artifacts: result.artifacts,
      failureClass: result.state === 'failed' ? (result.coverageGate && !result.coverageGate.passed ? 'coverage_incomplete' : 'no_progress') : null,
      coverageGate: result.coverageGate ?? null,
    });
  }
}

// ── Evidence & findings ─────────────────────────────────────

/**
 * Persists worker-discovered assets in the same transaction as the report.
 * `assets` is an authoritative table (deduplicated by mission + type::value);
 * the P3-B1 blackboard derives typed facts from it. Credential values are
 * stored in plaintext by explicit user decision (see ADR-0010).
 */
export async function insertTaskAssets(
  client: PoolClient,
  missionId: string,
  taskId: string,
  assets: readonly AssetInput[] = [],
): Promise<number> {
  let inserted = 0;
  for (const asset of assets) {
    const type = String(asset?.type ?? '').trim().slice(0, 100);
    const value = String(asset?.value ?? '').trim().slice(0, 8_000);
    if (!type || !value) continue;
    const result = await client.query(
      `INSERT INTO assets (mission_id, type, value, task_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (mission_id, identity_key) DO NOTHING`,
      [missionId, type, value, taskId],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export async function insertEvidence(
  client: PoolClient,
  missionId: string,
  taskId: string,
  entries: EvidenceInput[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const entry of entries) {
    const result = await client.query(
      `
        INSERT INTO evidence (
          mission_id, task_id, traffic_ref, kind, method, url,
          request_text, response_text, request_sha256, response_sha256,
          request_bytes, response_bytes, untrusted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (task_id, traffic_ref) DO UPDATE SET
          kind = EXCLUDED.kind,
          method = EXCLUDED.method,
          url = EXCLUDED.url,
          request_text = EXCLUDED.request_text,
          response_text = EXCLUDED.response_text,
          request_sha256 = EXCLUDED.request_sha256,
          response_sha256 = EXCLUDED.response_sha256,
          request_bytes = EXCLUDED.request_bytes,
          response_bytes = EXCLUDED.response_bytes,
          untrusted = EXCLUDED.untrusted
        RETURNING id
      `,
      [
        missionId,
        taskId,
        entry.trafficRef,
        entry.kind,
        entry.method,
        entry.url,
        entry.requestText,
        entry.responseText,
        entry.requestSha256,
        entry.responseSha256,
        entry.requestBytes,
        entry.responseBytes,
        entry.untrusted,
      ],
    );
    ids.set(entry.trafficRef, String(result.rows[0].id));
  }
  return ids;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const CONFIDENCE_RANK: Record<string, number> = { observed: 3, inferred: 2, unverified: 1 };

function betterConfidence(
  first: string,
  second: string,
): 'observed' | 'inferred' | 'unverified' {
  const pick = (CONFIDENCE_RANK[first] ?? 0) >= (CONFIDENCE_RANK[second] ?? 0) ? first : second;
  return pick === 'observed' || pick === 'inferred' ? pick : 'unverified';
}

/**
 * P2 authoritative evidence gate + dedupe/merge.
 *
 * The plugin curates for immediate feedback, but the control plane re-runs the
 * same six gates against the persisted evidence rows (the plugin is untrusted
 * for acceptance) and then merges findings that share a root-cause key. A
 * review verdict never silently disappears: it becomes a `needs_review` finding
 * plus a pending `finding_review` approval for a human.
 */
export async function insertCuratedFindings(
  client: PoolClient,
  missionId: string,
  taskId: string,
  findings: FindingInput[],
  evidence: EvidenceInput[],
  evidenceIdMap?: Map<string, string>,
): Promise<PersistedFinding[]> {
  const contexts = new Map<string, EvidenceContext>();
  for (const entry of evidence) {
    const context: EvidenceContext = {
      trafficId: entry.trafficRef,
      kind: entry.kind,
      method: entry.method,
      url: entry.url,
      requestText: entry.requestText,
      responseText: entry.responseText,
      requestSha256: entry.requestSha256,
      responseSha256: entry.responseSha256,
      untrusted: entry.untrusted,
    };
    contexts.set(entry.trafficRef, context);
    // Finding.evidenceIds are rewritten to DB UUIDs before persistence; keep a
    // second lookup key so curation can still resolve the real traffic rows.
    const dbId = evidenceIdMap?.get(entry.trafficRef);
    if (dbId) contexts.set(dbId, context);
  }

  const persisted: PersistedFinding[] = [];
  for (const finding of findings) {
    const findingEvidence = finding.evidenceIds
      .map(id => contexts.get(id))
      .filter((item): item is EvidenceContext => item !== undefined);
    const reportFinding: ReportFinding = {
      title: finding.title,
      category: finding.category,
      severity: finding.severity,
      assetRefs: finding.artifact ? [finding.artifact] : [],
      evidenceRefs: findingEvidence.map(item => ({
        trafficId: item.trafficId,
        requestHash: item.requestSha256,
        responseHash: item.responseSha256,
      })),
      claimsAnonymous: finding.claimsAnonymous ?? false,
      isCredentialLeak: finding.isCredentialLeak ?? false,
    };
    const verdict = curateWithEvidence(reportFinding, findingEvidence, { reportMd: finding.reportMd });
    const reviewSetting = await client.query(`SELECT value FROM runtime_settings WHERE key='worker.findingReviewMode' LIMIT 1`);
    const reviewMode = reviewSetting.rows[0]?.value === 'manual' ? 'manual' : 'auto';
    const review = verdict.action === 'accept'
      ? null
      : autoReviewFinding({
          finding: reportFinding,
          evidence: findingEvidence,
          reportMd: finding.reportMd,
          verdict,
          mode: reviewMode,
        });
    const effectiveFinding = review?.action === 'accept' ? review.finding : reportFinding;
    const status: 'accepted' | 'needs_review' | 'rejected' =
      review?.action === 'accept' ? 'accepted' : review?.action === 'reject' ? 'rejected' : 'needs_review';
    const reasons = review?.action === 'accept' ? [] : (review?.reasons ?? verdict.reasons);

    const existing = await client.query(
      `SELECT id, status, severity, artifact, evidence_ids, curator_reasons, merged_count, confidence, report_md
       FROM findings WHERE mission_id = $1 AND root_cause_key = $2 FOR UPDATE`,
      [missionId, verdict.rootCauseKey],
    );
    let persistedRow: PersistedFinding;
    if (existing.rowCount && existing.rows[0]) {
      const row = existing.rows[0];
      const existingEvidence = (row.evidence_ids ?? []) as string[];
      const mergedEvidence = [...new Set([...existingEvidence, ...finding.evidenceIds])];
      const mergedReasons = [...new Set([...((row.curator_reasons ?? []) as string[]), ...reasons])];
      const severity = (SEVERITY_RANK[effectiveFinding.severity] ?? 0) > (SEVERITY_RANK[String(row.severity)] ?? 0)
        ? effectiveFinding.severity
        : (String(row.severity) as ReportFinding['severity']);
      const mergedStatus: 'accepted' | 'needs_review' | 'rejected' =
        row.status === 'accepted' || status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'needs_review';
      const confidence = betterConfidence(String(row.confidence ?? 'unverified'), verdict.confidence);
      const artifact = finding.artifact ?? (row.artifact ? String(row.artifact) : null);
      await client.query(
        `UPDATE findings
         SET status = $2, severity = $3, artifact = $4, evidence_ids = $5, curator_reasons = $6,
             confidence = $7, merged_count = merged_count + 1, merged_at = now(), updated_at = now()
         WHERE id = $1`,
        [
          row.id,
          mergedStatus,
          severity,
          artifact,
          JSON.stringify(mergedEvidence),
          JSON.stringify(mergedReasons),
          confidence,
        ],
      );
      await client.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
         VALUES ($1, 'finding.merged', $2, $3)`,
        [missionId, row.id, JSON.stringify({ taskId, rootCauseKey: verdict.rootCauseKey, status: mergedStatus })],
      );
      persistedRow = {
        id: String(row.id),
        title: finding.title,
        category: finding.category,
        severity,
        status: mergedStatus,
        artifact,
        confidence,
        rootCauseKey: verdict.rootCauseKey,
        evidenceIds: mergedEvidence,
        curatorReasons: mergedReasons,
        merged: true,
      };
    } else {
      const inserted = await client.query(
        `INSERT INTO findings (
           mission_id, task_id, title, category, severity, status, artifact, report_md,
           evidence_ids, curator_reasons, root_cause_key, confidence, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         RETURNING id`,
        [
          missionId,
          taskId,
          finding.title,
          finding.category,
          effectiveFinding.severity,
          status,
          finding.artifact ?? null,
          finding.reportMd,
          JSON.stringify(finding.evidenceIds),
          JSON.stringify(reasons),
          verdict.rootCauseKey,
          verdict.confidence,
        ],
      );
      persistedRow = {
        id: String(inserted.rows[0].id),
        title: finding.title,
        category: finding.category,
        severity: effectiveFinding.severity,
        status,
        artifact: finding.artifact ?? null,
        confidence: verdict.confidence,
        rootCauseKey: verdict.rootCauseKey,
        evidenceIds: finding.evidenceIds,
        curatorReasons: reasons,
        merged: false,
      };
      await client.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
         VALUES ($1, 'finding.recorded', $2, $3)`,
        [
          missionId,
          persistedRow.id,
          JSON.stringify({
            taskId,
            status,
            confidence: verdict.confidence,
            rootCauseKey: verdict.rootCauseKey,
            reasons,
          }),
        ],
      );
    }

    if (review) {
      await client.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'finding.auto_reviewed',$2,$3)`,
        [
          missionId,
          persistedRow.id,
          JSON.stringify({
            decision: review.action,
            normalized: review.normalized,
            reasons: review.reasons,
            severity: effectiveFinding.severity,
            mode: reviewMode,
          }),
        ],
      );
    }
    if (persistedRow.status === 'needs_review') {
      const pending = await client.query(
        `SELECT 1 FROM approvals
         WHERE mission_id = $1 AND type = 'finding_review' AND status = 'pending'
           AND payload->>'findingId' = $2 LIMIT 1`,
        [missionId, persistedRow.id],
      );
      if ((pending.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO approvals (mission_id, type, status, payload) VALUES ($1, 'finding_review', 'pending', $2)`,
          [
            missionId,
            JSON.stringify({ findingId: persistedRow.id, title: persistedRow.title, reasons }),
          ],
        );
        await client.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'approval.requested',$2,$3)`,
          [missionId, persistedRow.id, JSON.stringify({ type: 'finding_review' })],
        );
      }
    }
    persisted.push(persistedRow);
  }
  return persisted;
}

// ── Finish (fenced, idempotent) ─────────────────────────────

export async function finishTask(
  pool: Pool,
  input: {
    taskId: string;
    missionId: string;
    workerId: string;
    fencingToken: number;
    attempt: number;
    status: 'done' | 'failed' | 'handed_back';
    completed: boolean;
    failureClass?: string;
    result: Record<string, unknown>;
    evidence: EvidenceInput[];
    findings: FindingInput[];
    /** Worker-discovered assets (plaintext credentials included, per policy). */
    assets?: AssetInput[];
    /** Bounded output of a summary task. */
    summary?: MissionSummary;
  },
): Promise<{ duplicate: boolean }> {
  // finalText/artifacts/evidence can contain NUL from binary or IDA output.
  input = stripNul(input) as typeof input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fencing is checked before idempotency: a stale worker must be rejected
    // even if it replays the same attempt key, otherwise a lost lease could
    // masquerade as a harmless duplicate report.
    const current = await client.query(
      `SELECT state, fencing_token, type FROM tasks WHERE id = $1 FOR UPDATE`,
      [input.taskId],
    );
    if (current.rowCount === 0) throw new FencingError(input.taskId);
    if (Number(current.rows[0].fencing_token) !== input.fencingToken) {
      throw new FencingError(input.taskId);
    }
    // A cancelled task is terminal even if a late executor/worker report
    // arrives with the correct fencing token. The controller already recorded
    // the operator cancellation; never overwrite it with a done/failed state.
    if (String(current.rows[0].state) === 'cancelled') {
      throw new FencingError(input.taskId);
    }

    const idempotencyKey = `${input.taskId}:report:${input.attempt}`;
    const reportInsert = await client.query(
      `INSERT INTO worker_reports (task_id, mission_id, worker_id, fencing_token, idempotency_key, status, report)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.taskId,
        input.missionId,
        input.workerId,
        input.fencingToken,
        idempotencyKey,
        input.status,
        JSON.stringify(input.result),
      ],
    );
    if (reportInsert.rowCount === 0) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    const fenced = await client.query(
      `UPDATE tasks SET state = 'reported'
       WHERE id = $1 AND fencing_token = $2 AND state IN ('leased', 'running')
       RETURNING id`,
      [input.taskId, input.fencingToken],
    );
    if (fenced.rowCount === 0) {
      throw new FencingError(input.taskId);
    }

    const evidenceIds = await insertEvidence(client, input.missionId, input.taskId, input.evidence);
    await insertTaskAssets(client, input.missionId, input.taskId, input.assets ?? []);
    const findings = input.findings.map(finding => ({
      ...finding,
      evidenceIds: finding.evidenceIds.map(ref => evidenceIds.get(ref) ?? ref),
    }));
    const persistedFindings = await insertCuratedFindings(
      client,
      input.missionId,
      input.taskId,
      findings,
      input.evidence,
      evidenceIds,
    );
    // Direct-pass triggers: findings become scoped hints for the other open
    // tasks of the same mission (never a new authorization).
    await recordFindingTriggers(client, input.missionId, input.taskId, persistedFindings).catch(() => undefined);

    let finalState: TaskState;
    if (input.status === 'handed_back') {
      finalState = 'handed_back';
    } else if (input.completed) {
      finalState = 'verified';
    } else {
      finalState = stateAfterFailedReport(input.attempt);
    }
    await client.query(`UPDATE tasks SET state = $2, completed_at = now(), last_error = $3 WHERE id = $1`, [
      input.taskId,
      finalState,
      input.failureClass ?? null,
    ]);
    if (finalState === 'verified') {
      await client.query(`UPDATE tasks SET state = 'done' WHERE id = $1`, [input.taskId]);
    }
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
      [
        input.missionId,
        `task.${finalState === 'verified' ? 'done' : finalState}`,
        input.taskId,
        JSON.stringify({ workerId: input.workerId, status: input.status, failureClass: input.failureClass ?? null }),
      ],
    );

    if (String(current.rows[0].type) === 'summary') {
      if (input.summary) {
        await client.query(
          `INSERT INTO mission_summaries (mission_id, task_id, markdown, coverage_assessment, gaps, duplicate_finding_ids, missing_evidence_ids)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
           ON CONFLICT (mission_id) DO UPDATE SET
             task_id=EXCLUDED.task_id, markdown=EXCLUDED.markdown,
             coverage_assessment=EXCLUDED.coverage_assessment, gaps=EXCLUDED.gaps,
             duplicate_finding_ids=EXCLUDED.duplicate_finding_ids,
             missing_evidence_ids=EXCLUDED.missing_evidence_ids`,
          [
            input.missionId,
            input.taskId,
            input.summary.markdown,
            input.summary.coverageAssessment ?? null,
            JSON.stringify(input.summary.gaps),
            JSON.stringify(input.summary.duplicateFindingIds),
            JSON.stringify(input.summary.missingEvidenceIds),
          ],
        );
        const gaps = input.summary.gaps.slice(0, 3);
        for (const gap of gaps) {
          await client.query(
            `INSERT INTO task_hints (mission_id, task_id, content, source, kind) VALUES ($1,NULL,$2,'summary','guidance')`,
            [input.missionId, `[summary] ${gap.area}: ${gap.suggestedCheck}`.slice(0, 2_000)],
          );
        }
        // 补漏 is opt-in and capped at one task: a summary is a report by
        // default, and it never spawns work once the objective is achieved.
        const followUpSettings = await client.query(
          `SELECT key, value FROM runtime_settings
           WHERE key IN ('worker.summaryFollowUpEnabled','worker.summaryMaxFollowUps')`,
        );
        const followUpMap = new Map(followUpSettings.rows.map(row => [String(row.key), row.value]));
        const followUpEnabled = process.env.SUMMARY_FOLLOWUP_ENABLED === '1'
          || followUpMap.get('worker.summaryFollowUpEnabled') === true;
        const followUps = selectFollowUpGaps({
          enabled: followUpEnabled,
          maxFollowUps: resolveFollowUpLimit(Number(
            followUpMap.get('worker.summaryMaxFollowUps') ?? process.env.SUMMARY_MAX_FOLLOWUPS ?? 1,
          )),
          objectiveAchieved: input.summary.objectiveAchieved === true,
          gaps: input.summary.gaps,
        });
        for (const gap of followUps) {
          await client.query(
            `INSERT INTO tasks (mission_id, type, state, grant_id, grant_version, budget, payload, priority)
             SELECT id, 'intent', 'proposed', grant_id, grant_version,
               '{"maxSteps":0,"maxWallClockMs":1200000}'::jsonb, $2::jsonb, 0.6
             FROM missions WHERE id = $1`,
            [
              input.missionId,
              JSON.stringify({ objective: `补漏：${gap.suggestedCheck}`, summaryGap: gap }),
            ],
          );
        }
        await client.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'mission.summary_completed',$2,$3)`,
          [
            input.missionId,
            input.taskId,
            JSON.stringify({
              gaps: gaps.length,
              followUps: followUps.length,
              objectiveAchieved: input.summary.objectiveAchieved === true,
              markdownChars: input.summary.markdown.length,
            }),
          ],
        );
      }
      await client.query(
        `UPDATE missions SET checkpoint = checkpoint || jsonb_build_object(
           'summary', jsonb_build_object('state', $2::text, 'completedAt', now())
         ), updated_at = now() WHERE id = $1`,
        [input.missionId, input.summary ? 'done' : 'failed'],
      );
    }

    // A pause freezes the mission: record the task result in the checkpoint,
    // but a late finishing task must not flip the mission to completed/failed.
    const missionRow = await client.query(`SELECT state FROM missions WHERE id = $1 FOR UPDATE`, [input.missionId]);
    const missionPaused = String(missionRow.rows[0]?.state ?? '') === 'paused';
    if (missionPaused) {
      await client.query(
        `UPDATE missions SET checkpoint = checkpoint || $2::jsonb, updated_at = now() WHERE id = $1`,
        [
          input.missionId,
          JSON.stringify({
            lastTaskReportedWhilePaused: {
              taskId: input.taskId,
              status: input.status,
              completed: input.completed,
              findings: findings.length,
              at: new Date().toISOString(),
            },
          }),
        ],
      );
      await client.query(
        `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
        [
          input.missionId,
          'mission.task_reported_while_paused',
          input.taskId,
          JSON.stringify({ workerId: input.workerId, status: input.status, findings: findings.length }),
        ],
      );
    } else {
      // ADR-0012: mission completion is aggregated over all tasks, never
      // decided by a single report or by the artifact count.
      const final = await finalizeMissionState(client, input.missionId);
      if (final.state !== 'running') {
        await client.query(
          `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
          [
            input.missionId,
            `mission.${final.state}`,
            input.taskId,
            JSON.stringify({
              workerId: input.workerId,
              fencingToken: input.fencingToken,
              status: input.status,
              findings: findings.length,
              evidence: input.evidence.length,
              result: input.result,
              doneTasks: final.doneTasks,
              failedTasks: final.failedTasks,
              acceptedFindings: final.acceptedFindings,
              artifacts: final.artifacts,
              failureClass: final.state === 'failed'
                ? (final.coverageGate && !final.coverageGate.passed ? 'coverage_incomplete' : 'no_progress')
                : null,
              coverageGate: final.coverageGate ?? null,
            }),
          ],
        );
      }
    }
    // Planner signal: batched, debounced reason input (P1-β).
    await client.query(
      `INSERT INTO planner_signals (mission_id, kind, payload)
       VALUES ($1, 'worker_report', $2)`,
      [
        input.missionId,
        JSON.stringify({
          taskId: input.taskId,
          status: input.status,
          completed: input.completed,
          failureClass: input.failureClass ?? null,
          findings: findings.length,
          evidence: input.evidence.length,
        }),
      ],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        input.missionId,
        missionPaused
          ? 'mission.task_reported_while_paused'
          : input.completed
            ? 'mission.completed'
            : 'mission.failed',
        input.taskId,
        JSON.stringify({
          workerId: input.workerId,
          fencingToken: input.fencingToken,
          status: input.status,
          findings: findings.length,
          evidence: input.evidence.length,
          result: input.result,
        }),
      ],
    );
    await client.query('COMMIT');
    return { duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordEvent(
  pool: Pool,
  missionId: string,
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
    [missionId, eventType, aggregateId, JSON.stringify(payload)],
  );
}
