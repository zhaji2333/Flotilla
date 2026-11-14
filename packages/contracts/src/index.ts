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

export * from './request-dedupe.js';
