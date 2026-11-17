import { z } from 'zod';

// ── Grant Scope ──────────────────────────────────────────────

export const UrlPrefixSchema = z.object({
  prefix: z.string().url(),
  ports: z.array(z.number().int().min(1).max(65535)).optional(),
}).strict();

export const GrantScopeSchema = z.object({
  domainSuffixes: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
  urlPrefixes: z.array(UrlPrefixSchema).default([]),
  exclude: z.array(z.string()).default([]),
  // Explicit unrestricted egress for attachment-only missions. Every request
  // still traverses the audited proxy; this is an operator-authorized scope.
  allowAll: z.boolean().default(false),
}).strict();
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const GrantConstraintsSchema = z.object({
  readOnly: z.boolean().default(false),
  excludedPaths: z.array(z.string()).default([]),
  rateLimitPerMin: z.number().int().positive().optional(),
  maxBudget: z.number().int().positive().default(30),
  allowedCategories: z.array(z.enum(['http', 'browser', 'codeExec', 'llm', 'io', 'task'])).default(['http']),
}).strict();
export type GrantConstraints = z.infer<typeof GrantConstraintsSchema>;

export const GrantSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  scope: GrantScopeSchema,
  constraints: GrantConstraintsSchema,
  issuedBy: z.enum(['user', 'approver', 'system']),
  createdAt: z.string().datetime(),
}).strict();
export type Grant = z.infer<typeof GrantSchema>;

// ── Task ─────────────────────────────────────────────────────

export const TaskTypeSchema = z.enum(['explore', 'reason', 'bootstrap', 'summary']);

export const TaskBudgetSchema = z.object({
  // 0 means unlimited; defaults follow ARTEX (max_turns=0, run wall clock=1200s).
  maxSteps: z.number().int().nonnegative().default(0),
  maxWallClockMs: z.number().int().nonnegative().default(1_200_000),
}).strict();

export const TaskSpecSchema = z.object({
  id: z.string().uuid(),
  missionId: z.string().uuid(),
  type: TaskTypeSchema,
  intentNodeId: z.string().uuid().nullable(),
  dependsOn: z.array(z.string().uuid()).default([]),
  grantId: z.string().uuid(),
  grantVersion: z.number().int().positive(),
  budget: TaskBudgetSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// ── Evidence / Finding ───────────────────────────────────────

export const EvidenceRefSchema = z.object({
  trafficId: z.string(),
  requestHash: z.string().min(1),
  responseHash: z.string().min(1),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const FailureClassSchema = z.enum([
  'policy_denied', 'tool_error', 'budget_exhausted',
  'no_progress', 'scope_denied', 'network_error',
  'model_error', 'container_error',
]);

export const ReportFindingSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  assetRefs: z.array(z.string()),
  evidenceRefs: z.array(EvidenceRefSchema).min(2),
  claimsAnonymous: z.boolean().default(false),
  isCredentialLeak: z.boolean().default(false),
}).strict();
export type ReportFinding = z.infer<typeof ReportFindingSchema>;

// ── Summary / gap review ─────────────────────────────────────

export const MissionGapSchema = z.object({
  area: z.string().min(1).max(300),
  reason: z.string().min(1).max(1_000),
  suggestedCheck: z.string().min(1).max(1_000),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
}).strict();
export type MissionGap = z.infer<typeof MissionGapSchema>;

export const MissionSummarySchema = z.object({
  markdown: z.string().min(1).max(8_000),
  coverageAssessment: z.string().max(2_000).optional(),
  /**
   * True when the mission objective is already satisfied (for example every
   * expected flag is an accepted finding). The controller then produces the
   * report only and never spawns a gap-filling task.
   */
  objectiveAchieved: z.boolean().optional(),
  gaps: z.array(MissionGapSchema).max(20).default([]),
  duplicateFindingIds: z.array(z.string()).max(50).default([]),
  missingEvidenceIds: z.array(z.string()).max(50).default([]),
}).strict();
export type MissionSummary = z.infer<typeof MissionSummarySchema>;

// ── Worker Report ────────────────────────────────────────────

export const AssetSchema = z.object({
  type: z.enum(['host', 'url', 'api', 'identity', 'credential', 'service', 'vuln']),
  value: z.string().min(1),
}).strict();

export const FactSchema = z.object({
  assetRefs: z.array(z.string()),
  statement: z.string().min(1),
  trafficRefs: z.array(z.string()),
}).strict();

export const SuggestedIntentSchema = z.object({
  statement: z.string().min(1),
  source: z.enum(['htn', 'llm']),
  operatorId: z.string().optional(),
}).strict();

export const WorkerReportSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(['done', 'failed', 'suspended']),
  insertedAssets: z.array(AssetSchema).default([]),
  insertedFacts: z.array(FactSchema).default([]),
  findings: z.array(ReportFindingSchema).default([]),
  suggestedIntents: z.array(SuggestedIntentSchema).default([]),
  failureClass: FailureClassSchema.optional(),
  stepCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
}).strict();
export type WorkerReport = z.infer<typeof WorkerReportSchema>;

// ── Commands (durable steering) ──────────────────────────────

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PauseMission'), payload: z.object({ missionId: z.string().uuid() }) }),
  z.object({ type: z.literal('ResumeMission'), payload: z.object({ missionId: z.string().uuid() }) }),
  z.object({ type: z.literal('CancelMission'), payload: z.object({ missionId: z.string().uuid() }) }),
  z.object({ type: z.literal('SetGrant'), payload: z.object({ missionId: z.string().uuid(), grantId: z.string().uuid() }) }),
  z.object({ type: z.literal('InjectHint'), payload: z.object({ missionId: z.string().uuid(), hint: z.string() }) }),
]);
export type Command = z.infer<typeof CommandSchema>;

// ── Mission ──────────────────────────────────────────────────

export const MissionStateSchema = z.enum([
  'pending', 'running', 'paused', 'completed', 'failed', 'cancelled',
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

// ── Tool Gateway ─────────────────────────────────────────────

export const RiskLevelSchema = z.enum(['A0', 'A1', 'A2', 'A3', 'A4']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const InternetToolSet = new Set(['web.search', 'web.fetch', 'github.fetch']);

export const SystemBlockSchema = z.object({
  ok: z.literal(false),
  blocked_by: z.literal('platform'),
  reason: z.string(),
  approval_required: z.boolean().default(false),
  approval_id: z.string().optional(),
  suggested_upgrade: z.object({
    url_prefix: z.string().optional(),
    ip: z.string().optional(),
  }).optional(),
}).strict();
export type SystemBlock = z.infer<typeof SystemBlockSchema>;

// ── Subsystem Result ─────────────────────────────────────────

export const SubsystemResultSchema = z.object({
  ok: z.boolean(),
  subsystem: z.string(),
  status: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
}).strict();

// ── Mission target (P0: target enters the database) ─────────

export const MissionTargetSchema = z.object({
  type: z.enum(['url', 'ip', 'domain', 'file']),
  value: z.string().min(1),
}).strict();
export type MissionTarget = z.infer<typeof MissionTargetSchema>;

// ── Task state machine (P1) ─────────────────────────────────

export const TaskStateSchema = z.enum([
  'proposed', 'ready', 'leased', 'running', 'reported', 'verified', 'done',
  'retry_wait', 'exhausted', 'blocked', 'cancelled', 'stale', 'handed_back',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'done', 'exhausted', 'blocked', 'cancelled', 'stale', 'handed_back',
];

export const OPEN_TASK_STATES: readonly TaskState[] = ['proposed', 'ready', 'leased', 'running'];

export const TaskClaimSchema = z.object({
  taskId: z.string().uuid(),
  workerId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  leaseExpiresAt: z.string().datetime(),
}).strict();
export type TaskClaim = z.infer<typeof TaskClaimSchema>;

// ── v1.0.2 reliability primitives ───────────────────────────
// Deadline/reporting, no-silent-abandonment dispositions, structured handoff,
// preflight checks, retry policy and coverage requirements. All additive: old
// missions/tasks keep their previous semantics when flags are off.

export const MissionPhaseSchema = z.enum(['active', 'reporting', 'closed']);
export const SearchPolicySchema = z.enum(['disabled', 'limited', 'allowed']);
export type SearchPolicy = z.infer<typeof SearchPolicySchema>;
export type MissionPhase = z.infer<typeof MissionPhaseSchema>;

export const MissionDeadlineSchema = z.object({
  /** Absolute mission deadline; null keeps the legacy unbounded behavior. */
  deadlineAt: z.string().datetime().nullable(),
  phase: MissionPhaseSchema.default('active'),
  /** How long before the deadline the mission enters `reporting`. */
  reportingLeadMs: z.number().int().min(0).max(86_400_000).default(900_000),
}).strict();
export type MissionDeadline = z.infer<typeof MissionDeadlineSchema>;

export const TaskDispositionSchema = z.enum([
  'completed',
  'exhausted',
  'blocked',
  'out_of_scope',
  'insufficient_evidence',
  'cancelled',
  'timeout',
]);
export type TaskDisposition = z.infer<typeof TaskDispositionSchema>;

/** Derive a disposition for legacy terminal rows when the column is NULL. */
export function deriveTaskDisposition(
  state: TaskState,
  failureClass?: string | null,
): TaskDisposition | null {
  if (state === 'done' || state === 'verified') return 'completed';
  if (state === 'exhausted') return 'exhausted';
  if (state === 'blocked') return 'blocked';
  if (state === 'cancelled' || state === 'stale' || state === 'handed_back') return 'cancelled';
  if (state === 'retry_wait' && failureClass === 'budget_exhausted') return 'timeout';
  return null;
}

const HandoffForbiddenKey = /(password|passwd|secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token)/i;
const HandoffSecretValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|rk|pk)[_-][A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;

function assertNoHandoffSecrets(value: unknown, path: string, ctx: z.RefinementCtx): void {
  if (typeof value === 'string') {
    if (value.length > 2_000) {
      ctx.addIssue({ code: 'custom', message: `handoff field is too long (${path})`, path: [path] });
      return;
    }
    if (HandoffSecretValue.test(value)) {
      ctx.addIssue({ code: 'custom', message: `handoff contains secret material (${path})`, path: [path] });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoHandoffSecrets(item, `${path}[${index}]`, ctx));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (HandoffForbiddenKey.test(key)) {
        ctx.addIssue({ code: 'custom', message: `handoff must not contain sensitive field "${key}"`, path: [key] });
        continue;
      }
      assertNoHandoffSecrets(nested, `${path}.${key}`, ctx);
    }
  }
}

export const TaskHandoffSchema = z.object({
  targetRef: z.string().min(1).max(500).nullable().default(null),
  scopeRef: z.string().min(1).max(500).nullable().default(null),
  accessState: z.enum(['unknown', 'authorized', 'authenticated', 'blocked']).default('unknown'),
  /** References only (asset/credential ids), never plaintext credentials. */
  credentialRefs: z.array(z.string().min(1).max(200)).max(5).default([]),
  confirmedFacts: z.array(z.string().min(1).max(500)).max(20).default([]),
  evidenceIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  failedHypotheses: z.array(z.string().min(1).max(500)).max(10).default([]),
  nextActions: z.array(z.string().min(1).max(500)).min(1).max(3),
  blockers: z.array(z.string().min(1).max(500)).max(5).default([]),
  approvalsNeeded: z.array(z.string().min(1).max(200)).max(5).default([]),
  preflightRef: z.string().max(200).nullable().default(null),
  lastActivityRef: z.string().max(200).nullable().default(null),
}).strict().superRefine((value, ctx) => assertNoHandoffSecrets(value, 'handoff', ctx));
export type TaskHandoff = z.infer<typeof TaskHandoffSchema>;

/** Bounded digest injected into the next claim; never the full handoff. */
export const TaskHandoffDigestSchema = z.object({
  version: z.number().int().positive(),
  targetRef: z.string().max(500).nullable(),
  accessState: z.enum(['unknown', 'authorized', 'authenticated', 'blocked']),
  confirmedFacts: z.array(z.string().max(500)).max(8).default([]),
  failedHypotheses: z.array(z.string().max(500)).max(5).default([]),
  nextActions: z.array(z.string().max(500)).max(3).default([]),
  blockers: z.array(z.string().max(500)).max(3).default([]),
  approvalsNeeded: z.array(z.string().max(200)).max(3).default([]),
}).strict();
export type TaskHandoffDigest = z.infer<typeof TaskHandoffDigestSchema>;

/** Bound a handoff for claim-time injection; never includes full text or secrets. */
export function buildTaskHandoffDigest(handoff: TaskHandoff, version: number): TaskHandoffDigest {
  const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  return TaskHandoffDigestSchema.parse({
    version,
    targetRef: handoff.targetRef,
    accessState: handoff.accessState,
    confirmedFacts: handoff.confirmedFacts.slice(0, 8).map(value => clip(value, 240)),
    failedHypotheses: handoff.failedHypotheses.slice(0, 5).map(value => clip(value, 240)),
    nextActions: handoff.nextActions.slice(0, 3).map(value => clip(value, 300)),
    blockers: handoff.blockers.slice(0, 3).map(value => clip(value, 240)),
    approvalsNeeded: handoff.approvalsNeeded.slice(0, 3).map(value => clip(value, 120)),
  });
}

export const PreflightDecisionSchema = z.enum(['proceed', 'blocked', 'out_of_scope', 'retry_wait']);
export type PreflightDecision = z.infer<typeof PreflightDecisionSchema>;

export const PreflightCheckSchema = z.object({
  phaseOk: z.boolean(),
  deadlineOk: z.boolean(),
  scopeOk: z.boolean(),
  targetVersion: z.string().max(200).nullable().default(null),
  authOk: z.boolean(),
  credentialVersion: z.string().max(200).nullable().default(null),
  pendingDestructiveApproval: z.boolean().default(false),
  decision: PreflightDecisionSchema,
  reason: z.string().max(1_000).nullable().default(null),
  evidenceRef: z.string().max(500).nullable().default(null),
}).strict();
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z.number().int().min(100).max(3_600_000).default(30_000),
  maxDelayMs: z.number().int().min(100).max(86_400_000).default(900_000),
  jitterRatio: z.number().min(0).max(1).default(0.2),
}).strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const CoverageStatusSchema = z.enum(['pending', 'covered', 'negative', 'dispositioned']);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

export const CoverageRequirementSchema = z.object({
  targetRef: z.string().min(1).max(500),
  attackSurface: z.string().min(1).max(100),
  status: CoverageStatusSchema.default('pending'),
  evidenceRef: z.string().max(500).nullable().default(null),
  disposition: TaskDispositionSchema.nullable().default(null),
}).strict();
export type CoverageRequirement = z.infer<typeof CoverageRequirementSchema>;

/** Derive the authorized coverage surface(s) a mission must disposition. */
export function deriveCoverageRequirements(
  target: MissionTarget | null | undefined,
): CoverageRequirement[] {
  if (!target) return [];
  if (target.type === 'file') {
    return [{ targetRef: `artifact:${target.value}`, attackSurface: 'artifact', status: 'pending', evidenceRef: null, disposition: null }];
  }
  const surface = target.type === 'ip' ? 'network' : 'web';
  return [{
    targetRef: `target:${target.value}`,
    attackSurface: surface,
    status: 'pending',
    evidenceRef: null,
    disposition: null,
  }];
}

/** Exp backoff with capped jitter; pure so scheduler tests can assert it. */
export function computeRetryDelayMs(
  attempt: number,
  policy: Partial<RetryPolicy> = {},
  random: () => number = Math.random,
): number {
  const parsed = RetryPolicySchema.parse(policy);
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(parsed.maxDelayMs, parsed.baseDelayMs * 2 ** exponent);
  const jitter = base * parsed.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(parsed.maxDelayMs, Math.round(base + jitter)));
}

export * from './request-dedupe.js';
