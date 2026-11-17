// Frozen v1 frontend contract types (mirrors docs/api/openapi.yaml).
// The UI must ignore unknown fields; never import backend code or the database.

export type MissionState = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskState =
  | 'proposed' | 'ready' | 'leased' | 'running' | 'reported' | 'verified' | 'done'
  | 'retry_wait' | 'exhausted' | 'blocked' | 'cancelled' | 'stale' | 'handed_back';
export type FindingStatus = 'accepted' | 'needs_review' | 'rejected';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type EgressMode = 'scope' | 'policy' | 'open';
export type Confidence = 'observed' | 'inferred' | 'unverified';
export type SubjectType = 'worker' | 'planner';
export type TaskAngle = 'web' | 'api' | 'infra' | 'binary';
export type IntelType = 'technique' | 'artifact' | 'credential';

export interface MissionTarget {
  type: 'url' | 'ip' | 'domain' | 'file';
  value: string;
}

export interface Scope {
  allowAll?: boolean;
  domainSuffixes?: string[];
  ips?: string[];
  urlPrefixes?: Array<{ prefix: string; ports?: number[] } | string>;
  exclude?: string[];
}

export interface CreatedMission {
  missionId: string;
  taskId: string;
  grantId: string;
  scope: Scope;
  artifacts?: MissionArtifact[];
  artifactIds?: string[];
}

export interface MissionListItem {
  id: string;
  name: string;
  state: MissionState;
  target: MissionTarget | null;
  objective: string | null;
  workerId: string | null;
  /** v1.0.2 reporting lifecycle (ADR-0054). */
  phase: MissionPhase;
  deadlineAt: string | null;
  reportingLeadMs: number;
  searchPolicy: SearchPolicy;
  findingsCount: number;
  createdAt: string;
  completedAt: string | null;
}

export type MissionPhase = 'active' | 'reporting' | 'closed';
export type SearchPolicy = 'disabled' | 'limited' | 'allowed';

export interface Task {
  id: string;
  state: TaskState;
  type: string;
  /** v1.0.2 terminal disposition (null while not terminal). */
  disposition: string | null;
  angle: TaskAngle | null;
  dependsOn: string[];
  attempt: number;
  priority: number;
  lastError: string | null;
  plannerRunId: string | null;
  createdAt: string;
  completedAt: string | null;
  result: Record<string, unknown> | null;
}

export interface TaskControlResult {
  taskId: string;
  missionId: string;
  state: string;
  actionCount?: number;
}

export interface SteeringRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  processed: boolean;
  createdAt: string;
}

export interface ActionLedgerEntry {
  id: string;
  missionId: string;
  taskId: string | null;
  method: string;
  url: string;
  statusCode: number | null;
  requestSha256: string;
  observedAt: string;
}

export interface CreateManualTaskRequest {
  objective: string;
  angle?: TaskAngle;
  priority?: number;
  maxSteps?: number;
  maxWallClockMs?: number;
  methodology?: string;
  artifactIds?: string[];
}

export interface MissionArtifact {
  id: string;
  missionId: string;
  taskId: string | null;
  sha256: string;
  size: number;
  filename: string;
  contentType: string;
  createdAt: string;
}

export interface ArtifactGcResult {
  cutoff: string;
  removedFiles: number;
  removedArtifacts: number;
}

export interface Todo {
  id: string;
  content: string;
  status: string;
  position: number;
}

export interface Trigger {
  id: string;
  source: string;
  kind: string;
  route: 'direct' | 'planner';
  state: string;
  createdAt: string;
}

export type HintKind = 'guidance' | 'help' | 'report';

export interface Hint {
  id: string;
  content: string;
  source: string;
  kind?: HintKind | string;
  state: 'pending' | 'delivered' | 'consumed';
  createdAt: string;
  deliveredAt: string | null;
}

export interface Approval {
  id: string;
  missionId: string;
  missionName?: string;
  type: string;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface PlannerRun {
  id: string;
  state: string;
  actionCount: number;
  reason: string | null;
  signalCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface MissionDetail extends MissionListItem {
  failureClass: string | null;
  checkpoint: Record<string, unknown>;
  pausedAt: string | null;
  tasks: Task[];
  todo: Todo[];
  triggers: Trigger[];
  hints: Hint[];
  approvals: Approval[];
  plannerRuns: PlannerRun[];
}

export interface MissionControlResult {
  missionId: string;
  state: string;
  pausedAt: string | null;
  checkpoint: Record<string, unknown>;
}

export interface FindingListItem {
  id: string;
  missionId: string;
  missionName: string;
  title: string;
  category: string;
  severity: Severity;
  status: FindingStatus;
  artifact: string | null;
  evidenceCount: number;
  confidence: Confidence;
  mergedCount: number;
  createdAt: string;
}

export interface Evidence {
  id: string;
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
  createdAt: string;
}

export interface FindingDetail extends FindingListItem {
  reportMd: string;
  curatorReasons: string[];
  evidence: Evidence[];
}

export interface TraceRow {
  id: number;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Health {
  ok: boolean;
  service: string;
  egressMode: EgressMode;
  error?: string;
}

export interface CreateMissionRequest {
  name?: string;
  target: MissionTarget;
  objective: string;
  maxSteps?: number;
  maxWallClockMs?: number;
  methodology?: string;
  scopeExtras?: {
    domainSuffixes?: string[];
    ips?: string[];
    urlPrefixes?: string[];
  };
  priority?: number;
}

export type CreateMissionMultipartRequest = Omit<CreateMissionRequest, 'target'> & {
  target?: MissionTarget;
  targetMode?: 'attachment';
};

export interface ListResponse<T> {
  total: number;
  [key: string]: T[] | number;
}

export interface BoardScopeSection {
  name?: string;
  state?: string;
  target?: MissionTarget | null;
  grantId?: string;
  grantVersion?: number;
  scope?: Scope;
  [key: string]: unknown;
}

export interface BoardFinding {
  id: string;
  title: string;
  category?: string;
  severity?: Severity;
  artifact?: string | null;
  confidence?: Confidence;
  mergedCount?: number;
}

export interface BoardItem {
  id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface MissionBoard {
  missionId: string;
  version: number;
  baseVersion: number;
  conflicts: Array<{ section: string; reason: string }>;
  sections: {
    scope: BoardScopeSection;
    assets: Array<Record<string, unknown>>;
    facts: Array<Record<string, unknown>>;
    capabilities: Array<Record<string, unknown>>;
    negatives: Array<Record<string, unknown>>;
    findings: BoardFinding[];
    todo: Array<Record<string, unknown>>;
    evidence: Record<string, unknown>;
  };
  generatedAt: string;
}

export type IndicatorGroup = 'quality' | 'efficiency' | 'safety' | 'control';
export type IndicatorUnit = 'count' | 'ratio' | 'seconds' | 'tokens';

export interface Indicator {
  id: string;
  group: IndicatorGroup;
  label: string;
  unit: IndicatorUnit;
  definition: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface MetricsSummary {
  generatedAt: string;
  missions: { total: number; active: number; completed: number; failed: number };
  findings: { total: number; accepted: number; needsReview: number; rejected: number; merged: number; validated: number };
  rates: {
    reviewRate: number;
    validationRate: number;
    stuckRate: number;
    duplicateMergeRate: number;
    falsePositiveRate?: number | null;
    taskSuccessRate?: number | null;
    taskRetryRate?: number | null;
    handbackRate?: number | null;
    evidenceDepth?: number | null;
  };
  timing: { avgTimeToFirstFactSeconds: number | null; avgMissionSeconds: number | null };
  tasks: {
    total: number; running: number; stale: number; stuck: number;
    done?: number; failed?: number; exhausted?: number; handedBack?: number; attempted?: number; retried?: number;
  };
  evidence: { total: number; target: number; internet: number };
  cost?: { totalTokens: number; tokensPerValidatedFinding: number | null };
  indicators?: Indicator[];
}

export interface MissionIntelItem {
  id: string;
  type: IntelType;
  title: string;
  detail: string;
  tags: string[];
  trust: Confidence;
  sensitive: boolean;
  sourceFindingId: string | null;
  sourceTaskId: string | null;
  createdAt: string;
}

export interface MissionIntel {
  missionId: string;
  generatedAt: string;
  total: number;
  items: MissionIntelItem[];
}

export type ExploreNodeType = 'mission' | 'task' | 'fact';
export type ExploreEdgeType = 'contains' | 'produced' | 'observes' | 'evidence_of';

export interface ExploreNode {
  id: string;
  type: ExploreNodeType;
  kind: string;
  label: string;
  state?: string;
  angle?: TaskAngle | null;
  trust?: Confidence;
  sensitive?: boolean;
}

export interface ExploreEdge {
  id: string;
  source: string;
  target: string;
  type: ExploreEdgeType;
}

export interface ExploreGroup {
  id: string;
  type: ExploreNodeType;
  kind: string;
  label: string;
  memberIds: string[];
}

export interface ExploreGraph {
  missionId: string;
  version: number;
  generatedAt: string;
  threshold: number;
  folded: boolean;
  original: { nodes: number; edges: number };
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  groups?: ExploreGroup[];
}

// ── P3 M5 revised: single-project closed loop ───────────────

export interface OverviewTask {
  id: string;
  state: TaskState;
  type: string;
  objective: string | null;
  angle: TaskAngle | null;
  priority: number;
  dependsOn: string[];
  attempt: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OverviewFact {
  id: string;
  kind: string;
  key: string;
  value: string;
  summary: string;
  trust: Confidence;
  sensitive: boolean;
  provenance: string;
  taskId: string | null;
  createdAt: string;
}

export interface OverviewFinding {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  artifact: string | null;
  status: FindingStatus;
  confidence: Confidence;
  taskId: string | null;
  createdAt: string;
}

export interface OverviewHint {
  id: string;
  content: string;
  source: string;
  kind?: HintKind | string;
  state: string;
  createdAt: string;
}

export interface OverviewTodo {
  id: string;
  content: string;
  status: string;
  position: number;
}

export interface OverviewAsset {
  type: string;
  value: string;
  taskId: string | null;
  createdAt: string;
}

export interface MissionOverview {
  mission: {
    id: string;
    name: string;
    state: MissionState;
    objective: string;
    target: { type: string; value: string };
    grantVersion: number;
    createdAt: string;
  };
  tasks: { open: OverviewTask[]; recent: OverviewTask[]; counts: { open: number; done: number; failed: number; total: number } };
  facts: { items: OverviewFact[]; counts: { total: number; byKind: Record<string, number>; sensitive: number } };
  frontier?: MissionFrontier | null;
  findings: { accepted: OverviewFinding[]; needsReview: OverviewFinding[]; counts: { accepted: number; needsReview: number } };
  hints: { items: OverviewHint[]; pending: number };
  negatives: { blocked: number; exhausted: number; stale: number; needsReview: number; total: number };
  traces: { totals: Record<string, unknown>; tasks: unknown[] };
  todo: { items: OverviewTodo[] };
  assets: { total: number; byType: Record<string, number>; items: OverviewAsset[] };
  coverage: { total: number; covered: number; ratio: number | null };
  budget: { tokens: number; steps: number };
  version: number;
  generatedAt: string;
  truncated?: boolean;
}

export interface WorkerTraceHit {
  traceId: string;
  taskId: string | null;
  callId?: string | null;
  seq: number;
  eventType: string;
  tool: string | null;
  url?: string | null;
  method?: string | null;
  command?: string | null;
  status?: string | null;
  summary: string;
  createdAt: string;
  untrusted: true;
}

export interface WorkerTraceSearch {
  missionId: string;
  q: string;
  excludeTaskId: string | null;
  hits: WorkerTraceHit[];
  total: number;
  truncated: boolean;
  untrusted: boolean;
}

export type AssetNodeType = 'asset' | 'task' | 'finding' | 'evidence';
export type AssetEdgeType = 'observed_by' | 'seen_in_evidence' | 'produced';

export interface MissionAssetNode {
  id: string;
  type: AssetNodeType;
  kind: string;
  label: string;
  taskId?: string | null;
  covered?: boolean;
}

export interface MissionAssetEdge {
  id: string;
  source: string;
  target: string;
  type: AssetEdgeType;
}

export interface MissionAssetGraph {
  missionId: string;
  version: number;
  generatedAt: string;
  nodes: MissionAssetNode[];
  edges: MissionAssetEdge[];
  counts: { total: number; byType: Record<string, number>; covered: number; ratio: number | null };
}

export interface EvalRun {
  id: string;
  kind: string;
  name: string;
  status: string;
  summary: Record<string, unknown>;
  details: Record<string, unknown> | null;
  recordedBy: string | null;
  createdAt: string;
}

export interface ReplaySummaryItem {
  missionId?: string;
  matchesCurrent?: boolean;
  toSeq?: number;
  [key: string]: unknown;
}

export interface EvalDashboard {
  evals: EvalRun[];
  metrics: MetricsSummary;
  replay: { checked: number; matched: number; mismatched: number; items: ReplaySummaryItem[] };
  generatedAt: string;
}

export interface PriorWorkTokens {
  input: number;
  output: number;
  total: number;
}

export interface PriorWorkTotals {
  tasks: number;
  done: number;
  failed: number;
  running: number;
  steps: number;
  tokens: PriorWorkTokens;
  findings: number;
  acceptedFindings: number;
  evidence: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  skillsLoaded: string[];
}

export interface PriorWorkTask {
  taskId: string;
  type: string;
  state: string;
  attempt: number;
  steps: number;
  tokens: PriorWorkTokens;
  findings: number;
  acceptedFindings: number;
  evidence: number;
  toolCalls: number;
  traceEvents: number;
  toolCounts: Record<string, number>;
  skillsLoaded: string[];
  startedAt: string | null;
  completedAt: string | null;
  firstTraceAt: string | null;
  lastTraceAt: string | null;
  finalText: string | null;
  lastError: string | null;
}

export interface PriorWorkSummary {
  missionId: string;
  missionName: string;
  generatedAt: string;
  totals: PriorWorkTotals;
  tasks: PriorWorkTask[];
  digest: string;
}

export interface ScopeUpgradeInput {
  url?: string;
  domainSuffixes?: string[];
  ips?: string[];
  urlPrefixes?: string[];
  reason?: string;
}

export interface ScopeUpgradeResponse {
  approvalId: string;
  missionId: string;
  scopeExtras: Partial<Scope>;
}

export interface MissionStreamFrame {
  type: 'mission' | 'error' | 'gone';
  missionId?: string;
  state?: MissionState;
  findings?: number;
  tasks?: number;
  openTasks?: number;
  triggers?: number;
  pendingApprovals?: number;
  updatedAt?: string;
  error?: string;
}

// ── P3 M2: typed blackboard read model ─────────────────────
export type FactTrust = 'observed' | 'inferred';
export type FactSource = 'asset' | 'finding' | 'finding_artifact' | 'evidence';

export interface MissionFact {
  id: string;
  missionId: string;
  source: FactSource;
  sourceId: string;
  kind: string;
  key: string;
  value: string;
  summary: string;
  provenance: string;
  trust: FactTrust;
  sensitive: boolean;
  taskId: string | null;
  createdAt: string;
}

export interface MissionIntent {
  id: string;
  missionId: string;
  type: string;
  state: string;
  objective: string;
  priority: number;
  dependsOn: string[];
  attempt: number;
  createdAt: string;
}

export interface MissionFrontier {
  missionId: string;
  version: number;
  generatedAt: string;
  intents: MissionIntent[];
  facts: MissionFact[];
  counts: {
    facts: number;
    intents: number;
    sensitiveFacts: number;
    byKind: Record<string, number>;
  };
}

export interface FactsResponse {
  missionId: string;
  facts: MissionFact[];
  total: number;
}

// ── P3 M3: model configuration module ──────────────────────
export type ModelReasoningEffort = 'low' | 'high' | 'max' | null;
export type ModelRole = 'worker' | 'planner' | 'scout' | 'executor' | 'specialist' | 'guard' | null;
export type ModelTier = 'default' | 'fast' | 'strong' | null;

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelName: string;
  apiKeyEnv?: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningEffort: ModelReasoningEffort;
  compat: Record<string, unknown>;
  role: ModelRole;
  tier: ModelTier;
  enabled: boolean;
  isDefault: boolean;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigTestInput {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  maxOutputTokens?: number;
}

export interface ModelConfigTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  model: string | null;
  reply: string | null;
  usage: Record<string, number> | null;
  error: string | null;
  errorCode: string | null;
  traceId: string | null;
}

export interface ModelConfigInput {
  name: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
  compat?: Record<string, unknown>;
  role?: ModelRole;
  tier?: ModelTier;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface ModelConfigAudit {
  id: string;
  configId: string | null;
  configName: string;
  actor: string;
  action: 'create' | 'update' | 'delete' | 'reveal' | string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModelConfigReveal {
  id: string;
  name: string;
  apiKey: string;
  updatedAt: string;
}

export interface AuthUser {
  id?: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  status?: 'active' | 'disabled';
  mustChangePassword?: boolean;
}

export interface AuthMe {
  user: AuthUser;
  authKind: 'service' | 'user' | 'dev';
  csrfToken: string | null;
  authMode: string;
}

export interface RuntimeSettings {
  'planner.maxOpenTasks': number;
  'planner.parallelTasks': number;
  'planner.frontierEnabled': boolean;
  'worker.missionContextEnabled': boolean;
  'worker.traceSearchEnabled': boolean;
  'worker.findingReviewMode': 'auto' | 'manual';
  'worker.summaryEnabled': boolean;
  'worker.summaryMaxRounds': number;
  'worker.summaryFollowUpEnabled': boolean;
  'worker.summaryMaxFollowUps': number;
  'worker.requestDedupeMode': 'off' | 'warn';
  'worker.requestDedupeTtlMinutes': number;
  version: number;
}

export interface MissionGap {
  area: string;
  reason: string;
  suggestedCheck: string;
  confidence: 'low' | 'medium' | 'high' | string;
}

export interface MissionSummary {
  id: string;
  missionId: string;
  taskId: string | null;
  markdown: string;
  coverageAssessment: string | null;
  gaps: MissionGap[];
  duplicateFindingIds: string[];
  missingEvidenceIds: string[];
  createdAt: string;
}

export interface AdminAuditEntry {
  id: string;
  actorName: string;
  action: string;
  targetType: string;
  targetIdHash: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type FindingLineageNodeType = 'finding' | 'task' | 'evidence';
export type FindingLineageEdgeType = 'produced_by' | 'supported_by' | 'superseded_by' | 'shares_evidence';

export interface FindingLineageNode {
  id: string;
  type: FindingLineageNodeType;
  label: string;
  status?: string;
  artifact?: string | null;
  trafficRef?: string;
  kind?: string;
  method?: string;
  url?: string;
  untrusted?: boolean;
}

export interface FindingLineageEdge {
  source: string;
  target: string;
  type: FindingLineageEdgeType;
}

export interface FindingLineageRelated {
  id: string;
  title: string;
  status: string;
  artifact: string | null;
  sharedEvidenceCount: number;
}

export interface FindingLineage {
  findingId: string;
  missionId: string;
  rootCauseKey: string | null;
  supersededBy: string | null;
  nodes: FindingLineageNode[];
  edges: FindingLineageEdge[];
  relatedFindings: FindingLineageRelated[];
  generatedAt: string;
}

// ── Watchdog dashboard (ADR-0039) ───────────────────────────
export interface WatchdogObservation {
  id: string;
  missionId: string;
  missionName: string | null;
  taskId: string | null;
  rule: string;
  source: string;
  action: 'hint' | 'deduped' | 'escalated' | string;
  stalledStreak: number;
  detail: string;
  outcome: 'pending' | 'progress' | 'no_progress';
  outcomeDetail: { newFindings?: number; newUrls?: number } & Record<string, unknown>;
  approvalId: string | null;
  createdAt: string;
  outcomeCheckedAt: string | null;
}

export interface WatchdogDashboard {
  windowDays: number;
  summary: {
    observations: number;
    hints: number;
    deduped: number;
    escalations: number;
    pendingOutcomes: number;
    checkedOutcomes: number;
    progressOutcomes: number;
    noProgressOutcomes: number;
    hitRate: number | null;
    byRule: Array<{ rule: string; count: number; escalations: number }>;
    byDay: Array<{ date: string; observations: number; escalations: number; progress: number; noProgress: number }>;
  };
  recent: WatchdogObservation[];
  escalations: WatchdogObservation[];
  streaks: Array<{
    taskId: string;
    missionId: string;
    missionName: string | null;
    stalledStreak: number;
    escalatedStreak: number;
    lastRule: string | null;
    lastDetail: string | null;
    lastObservedAt: string;
  }>;
}
