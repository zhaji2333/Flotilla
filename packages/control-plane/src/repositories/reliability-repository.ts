import {
  CoverageRequirementSchema,
  PreflightCheckSchema,
  RetryPolicySchema,
  TaskDispositionSchema,
  TaskHandoffSchema,
  buildTaskHandoffDigest,
  computeRetryDelayMs,
  type CoverageRequirement,
  type MissionPhase,
  type PreflightCheck,
  type RetryPolicy,
  type TaskDisposition,
  type TaskHandoff,
} from '@src-agent/contracts';
import { getPool } from '../db';

// ── v1.0.2 reliability state (ADR-0054) ────────────────────
// Additive storage for deadline/reporting, dispositions, structured handoff,
// preflight checks, retry backoff and coverage requirements. These functions
// never mutate existing mission/task semantics on their own; callers decide
// when to apply the v1.0.2 behavior (feature-flagged in the scheduler).

export interface TaskHandoffRow {
  id: string;
  missionId: string;
  taskId: string;
  attempt: number;
  handoff: TaskHandoff;
  redactionVersion: number;
  createdAt: string;
}

export interface PreflightCheckRow {
  id: string;
  missionId: string;
  taskId: string;
  checkedAt: string;
  check: PreflightCheck;
}

export interface TaskRetryStateRow {
  missionId: string;
  fingerprint: string;
  attempt: number;
  nextAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface CoverageRequirementRow extends CoverageRequirement {
  id: string;
  missionId: string;
  updatedAt: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** validate + normalise a handoff before it reaches the database. */
export function parseHandoffForStorage(input: unknown): TaskHandoff {
  return TaskHandoffSchema.parse(input);
}

/** validate a preflight record before it reaches the database. */
export function parsePreflightForStorage(input: unknown): PreflightCheck {
  return PreflightCheckSchema.parse(input);
}

/** Validate/normalise a coverage requirement (also used by the planner). */
export function parseCoverageForStorage(input: unknown): CoverageRequirement {
  return CoverageRequirementSchema.parse(input);
}

/** Absolute retry time derived from the attempt number and policy. */
export function computeNextRetryAt(
  attempt: number,
  policy: Partial<RetryPolicy> = {},
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  const delay = computeRetryDelayMs(attempt, RetryPolicySchema.parse(policy), random);
  return new Date(now.getTime() + delay);
}

function mapHandoffRow(row: Record<string, unknown>): TaskHandoffRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: String(row.task_id),
    attempt: Number(row.attempt),
    handoff: TaskHandoffSchema.parse(row.handoff),
    redactionVersion: Number(row.redaction_version),
    createdAt: iso(row.created_at),
  };
}

function mapPreflightRow(row: Record<string, unknown>): PreflightCheckRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: String(row.task_id),
    checkedAt: iso(row.checked_at),
    check: PreflightCheckSchema.parse({
      phaseOk: row.phase_ok,
      deadlineOk: row.deadline_ok,
      scopeOk: row.scope_ok,
      authOk: row.auth_ok,
      targetVersion: row.target_version ?? null,
      credentialVersion: row.credential_version ?? null,
      pendingDestructiveApproval: row.pending_destructive ?? false,
      decision: row.decision,
      reason: row.reason ?? null,
      evidenceRef: row.evidence_ref ?? null,
    }),
  };
}

function mapCoverageRow(row: Record<string, unknown>): CoverageRequirementRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    targetRef: String(row.target_ref),
    attackSurface: String(row.attack_surface),
    status: row.status as CoverageRequirementRow['status'],
    evidenceRef: row.evidence_ref ? String(row.evidence_ref) : null,
    disposition: row.disposition ? TaskDispositionSchema.parse(String(row.disposition)) : null,
    updatedAt: iso(row.updated_at),
  };
}

/** Build a structured handoff from a worker report without raw CoT/response text. */
export function buildHandoffFromReport(input: {
  targetRef?: string | null;
  scopeRef?: string | null;
  findings?: Array<{ title: string }>;
  evidenceIds?: string[];
  failureClass?: string | null;
  nextActions?: string[];
}): TaskHandoff {
  const findings = (input.findings ?? []).map(finding => finding.title).filter(Boolean);
  const failed = input.failureClass ? [`failed with ${input.failureClass}`] : [];
  const nextActions = (input.nextActions ?? []).slice(0, 3);
  if (nextActions.length === 0) {
    nextActions.push(findings.length > 0 ? `review evidence for: ${findings[0]}` : 'continue from the recorded evidence');
  }
  return TaskHandoffSchema.parse({
    targetRef: input.targetRef ?? null,
    scopeRef: input.scopeRef ?? null,
    accessState: findings.length > 0 ? 'authorized' : 'unknown',
    credentialRefs: [],
    confirmedFacts: findings.slice(0, 10),
    evidenceIds: (input.evidenceIds ?? []).slice(0, 50),
    failedHypotheses: failed,
    nextActions,
    blockers: [],
    approvalsNeeded: [],
    preflightRef: null,
    lastActivityRef: null,
  });
}

/** Latest bounded digest from another task in the same mission (never cross-mission). */
export async function getLatestHandoffDigestForMission(
  missionId: string,
  excludeTaskId?: string,
): Promise<{ version: number; digest: string; taskId: string } | null> {
  const result = await getPool().query(
    `SELECT task_id, attempt, handoff FROM task_handoffs
      WHERE mission_id = $1
        AND ($2::uuid IS NULL OR task_id <> $2)
      ORDER BY created_at DESC LIMIT 1`,
    [missionId, excludeTaskId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  const handoff = TaskHandoffSchema.parse(row.handoff);
  const digest = buildTaskHandoffDigest(handoff, Number(row.attempt));
  const lines = [
    `target: ${digest.targetRef ?? 'unknown'}`,
    `access: ${digest.accessState}`,
    ...(digest.confirmedFacts.length ? ['confirmed facts:', ...digest.confirmedFacts.map(item => `- ${item}`)] : []),
    ...(digest.failedHypotheses.length ? ['failed hypotheses:', ...digest.failedHypotheses.map(item => `- ${item}`)] : []),
    ...(digest.nextActions.length ? ['next actions:', ...digest.nextActions.map(item => `- ${item}`)] : []),
    ...(digest.blockers.length ? ['blockers:', ...digest.blockers.map(item => `- ${item}`)] : []),
    ...(digest.approvalsNeeded.length ? ['approvals needed:', ...digest.approvalsNeeded.map(item => `- ${item}`)] : []),
  ];
  return { version: digest.version, digest: lines.join('\n').slice(0, 4_000), taskId: String(row.task_id) };
}

export async function insertTaskHandoff(input: {
  missionId: string;
  taskId: string;
  attempt: number;
  handoff: unknown;
  redactionVersion?: number;
}): Promise<TaskHandoffRow> {
  const handoff = parseHandoffForStorage(input.handoff);
  const result = await getPool().query(
    `INSERT INTO task_handoffs (mission_id, task_id, attempt, handoff, redaction_version)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, mission_id, task_id, attempt, handoff, redaction_version, created_at`,
    [input.missionId, input.taskId, input.attempt, JSON.stringify(handoff), input.redactionVersion ?? 1],
  );
  await getPool().query(
    `UPDATE tasks SET handoff_version = GREATEST(COALESCE(handoff_version, 0), $2) WHERE id = $1`,
    [input.taskId, input.attempt],
  );
  return mapHandoffRow(result.rows[0]);
}

export async function getLatestTaskHandoff(taskId: string): Promise<TaskHandoffRow | null> {
  const result = await getPool().query(
    `SELECT id, mission_id, task_id, attempt, handoff, redaction_version, created_at
       FROM task_handoffs WHERE task_id = $1
      ORDER BY attempt DESC, created_at DESC LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ? mapHandoffRow(result.rows[0]) : null;
}

export async function recordPreflightCheck(input: {
  missionId: string;
  taskId: string;
  check: unknown;
}): Promise<PreflightCheckRow> {
  const check = parsePreflightForStorage(input.check);
  const result = await getPool().query(
    `INSERT INTO task_preflight_checks
       (mission_id, task_id, phase_ok, deadline_ok, scope_ok, auth_ok,
        target_version, credential_version, pending_destructive, decision, reason, evidence_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, mission_id, task_id, checked_at`,
    [
      input.missionId,
      input.taskId,
      check.phaseOk,
      check.deadlineOk,
      check.scopeOk,
      check.authOk,
      check.targetVersion,
      check.credentialVersion,
      check.pendingDestructiveApproval,
      check.decision,
      check.reason,
      check.evidenceRef,
    ],
  );
  const row = result.rows[0];
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: String(row.task_id),
    checkedAt: iso(row.checked_at),
    check,
  };
}

export async function getLatestPreflightCheck(taskId: string): Promise<PreflightCheckRow | null> {
  const result = await getPool().query(
    `SELECT * FROM task_preflight_checks WHERE task_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ? mapPreflightRow(result.rows[0]) : null;
}

export async function setTaskDisposition(
  taskId: string,
  disposition: TaskDisposition,
): Promise<void> {
  const parsed = TaskDispositionSchema.parse(disposition);
  await getPool().query(`UPDATE tasks SET disposition = $2 WHERE id = $1`, [taskId, parsed]);
}

export async function upsertTaskRetryState(input: {
  missionId: string;
  fingerprint: string;
  attempt: number;
  nextAt: string | null;
  lastError: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO task_retry_state (mission_id, fingerprint, attempt, next_at, last_error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mission_id, fingerprint) DO UPDATE
       SET attempt = EXCLUDED.attempt,
           next_at = EXCLUDED.next_at,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [input.missionId, input.fingerprint, input.attempt, input.nextAt, input.lastError],
  );
}

export async function getTaskRetryState(
  missionId: string,
  fingerprint: string,
): Promise<TaskRetryStateRow | null> {
  const result = await getPool().query(
    `SELECT mission_id, fingerprint, attempt, next_at, last_error, updated_at
       FROM task_retry_state WHERE mission_id = $1 AND fingerprint = $2`,
    [missionId, fingerprint],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    missionId: String(row.mission_id),
    fingerprint: String(row.fingerprint),
    attempt: Number(row.attempt),
    nextAt: row.next_at ? iso(row.next_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: iso(row.updated_at),
  };
}

export async function upsertCoverageRequirement(input: {
  missionId: string;
  requirement: unknown;
}): Promise<CoverageRequirementRow> {
  const requirement = parseCoverageForStorage(input.requirement);
  const result = await getPool().query(
    `INSERT INTO coverage_requirements
       (mission_id, target_ref, attack_surface, status, evidence_ref, disposition)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (mission_id, target_ref, attack_surface) DO UPDATE
       SET status = EXCLUDED.status,
           evidence_ref = EXCLUDED.evidence_ref,
           disposition = EXCLUDED.disposition,
           updated_at = now()
     RETURNING id, mission_id, target_ref, attack_surface, status, evidence_ref, disposition, updated_at`,
    [
      input.missionId,
      requirement.targetRef,
      requirement.attackSurface,
      requirement.status,
      requirement.evidenceRef,
      requirement.disposition,
    ],
  );
  return mapCoverageRow(result.rows[0]);
}

export async function listCoverageRequirements(missionId: string): Promise<CoverageRequirementRow[]> {
  const result = await getPool().query(
    `SELECT id, mission_id, target_ref, attack_surface, status, evidence_ref, disposition, updated_at
       FROM coverage_requirements WHERE mission_id = $1
      ORDER BY target_ref, attack_surface`,
    [missionId],
  );
  return result.rows.map(mapCoverageRow);
}

export async function setMissionDeadline(input: {
  missionId: string;
  deadlineAt: string | null;
  phase?: MissionPhase;
  reportingLeadMs?: number;
}): Promise<void> {
  await getPool().query(
    `UPDATE missions
        SET deadline_at = $2,
            phase = COALESCE($3, phase),
            reporting_lead_ms = COALESCE($4, reporting_lead_ms),
            updated_at = now()
      WHERE id = $1`,
    [input.missionId, input.deadlineAt, input.phase ?? null, input.reportingLeadMs ?? null],
  );
}

export async function listMissionsDueForReporting(now: Date = new Date()): Promise<
  Array<{ id: string; deadlineAt: string; reportingLeadMs: number }>
> {
  const result = await getPool().query(
    `SELECT id, deadline_at, reporting_lead_ms FROM missions
      WHERE phase = 'active'
        AND deadline_at IS NOT NULL
        AND deadline_at - make_interval(secs => reporting_lead_ms / 1000.0) <= $1
      ORDER BY deadline_at ASC`,
    [now.toISOString()],
  );
  return result.rows.map(row => ({
    id: String(row.id),
    deadlineAt: iso(row.deadline_at),
    reportingLeadMs: Number(row.reporting_lead_ms),
  }));
}
