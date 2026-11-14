import type { MissionTarget } from '@src-agent/contracts';
import { getPool } from '../db';

// ── Read repository ─────────────────────────────────────────
// Every query used by the read-only console lives here.

export interface MissionListItem {
  id: string;
  name: string;
  state: string;
  target: MissionTarget | null;
  objective: string | null;
  workerId: string | null;
  findingsCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface MissionDetail extends MissionListItem {
  failureClass: string | null;
  checkpoint: Record<string, unknown>;
  pausedAt: string | null;
  tasks: TaskListItem[];
  todo: TodoItem[];
  triggers: TriggerRow[];
  hints: HintRow[];
  approvals: ApprovalRow[];
  plannerRuns: PlannerRunListItem[];
}

export interface PlannerRunListItem {
  id: string;
  state: string;
  actionCount: number;
  reason: string | null;
  signalCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface TraceRow {
  id: number;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TaskListItem {
  id: string;
  state: string;
  type: string;
  /** Optional P3-B4 angle (web/api/infra/binary). */
  angle: string | null;
  dependsOn: string[];
  attempt: number;
  priority: number;
  lastError: string | null;
  plannerRunId: string | null;
  createdAt: string;
  completedAt: string | null;
  result: Record<string, unknown> | null;
}

export interface TodoItem {
  id: string;
  content: string;
  status: string;
  position: number;
}

export interface TriggerRow {
  id: string;
  source: string;
  kind: string;
  route: string;
  state: string;
  createdAt: string;
}

export interface HintRow {
  id: string;
  content: string;
  source: string;
  kind: string;
  state: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ApprovalRow {
  id: string;
  missionId: string;
  missionName?: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface FindingListItem {
  id: string;
  missionId: string;
  missionName: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  artifact: string | null;
  evidenceCount: number;
  confidence: 'observed' | 'inferred' | 'unverified';
  mergedCount: number;
  createdAt: string;
}

export interface FindingDetail extends FindingListItem {
  reportMd: string;
  curatorReasons: string[];
  evidence: EvidenceRow[];
}

export interface EvidenceRow {
  id: string;
  trafficRef: string;
  kind: string;
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


export async function listMissions(limit = 50): Promise<MissionListItem[]> {
  const result = await getPool().query(
    `SELECT m.id, m.name, m.state, m.target, m.objective, m.worker_id, m.created_at, m.completed_at,
            (SELECT count(*)::int FROM findings f WHERE f.mission_id = m.id) AS findings_count
     FROM missions m
     ORDER BY m.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(rowToMission);
}

export async function getMission(id: string): Promise<MissionDetail | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT m.id, m.name, m.state, m.target, m.objective, m.worker_id, m.created_at, m.completed_at,
            m.failure_class, m.checkpoint, m.paused_at,
            (SELECT count(*)::int FROM findings f WHERE f.mission_id = m.id) AS findings_count
     FROM missions m WHERE m.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [tasks, todo, triggers, hints, approvals, plannerRuns] = await Promise.all([
    pool.query(
      `SELECT id, state, type, angle, depends_on, attempt, priority, last_error, planner_run_id,
              created_at, completed_at, result
       FROM tasks WHERE mission_id = $1 ORDER BY created_at ASC`,
      [id],
    ),
    pool.query(`SELECT id, content, status, position FROM mission_todo WHERE mission_id = $1 ORDER BY position ASC, id ASC`, [id]),
    pool.query(`SELECT id, source, kind, route, state, created_at FROM triggers WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 200`, [id]),
    pool.query(`SELECT id, content, source, kind, state, created_at, delivered_at FROM task_hints WHERE mission_id = $1 ORDER BY created_at ASC LIMIT 200`, [id]),
    pool.query(`SELECT id, mission_id, type, status, payload, decided_by, decided_at, created_at FROM approvals WHERE mission_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]),
    pool.query(`SELECT id, state, action_count, signal_count, reason, started_at, finished_at FROM planner_runs WHERE mission_id = $1 ORDER BY started_at DESC LIMIT 50`, [id]),
  ]);
  return {
    ...rowToMission(row),
    failureClass: row.failure_class ?? null,
    checkpoint: (row.checkpoint ?? {}) as Record<string, unknown>,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    tasks: tasks.rows.map(task => ({
      id: String(task.id),
      state: String(task.state),
      type: String(task.type),
      angle: task.angle ? String(task.angle) : null,
      dependsOn: ((task.depends_on ?? []) as string[]).map(String),
      attempt: Number(task.attempt ?? 0),
      priority: Number(task.priority ?? 0.5),
      lastError: task.last_error ? String(task.last_error) : null,
      plannerRunId: task.planner_run_id ? String(task.planner_run_id) : null,
      createdAt: new Date(task.created_at).toISOString(),
      completedAt: task.completed_at ? new Date(task.completed_at).toISOString() : null,
      result: task.result ?? null,
    })),
    todo: todo.rows.map(item => ({
      id: String(item.id),
      content: String(item.content),
      status: String(item.status),
      position: Number(item.position),
    })),
    triggers: triggers.rows.map(item => rowToTrigger(item)),
    hints: hints.rows.map(item => ({
      id: String(item.id),
      content: String(item.content),
      source: String(item.source),
      kind: String(item.kind ?? 'guidance'),
      state: String(item.state),
      createdAt: new Date(item.created_at).toISOString(),
      deliveredAt: item.delivered_at ? new Date(item.delivered_at).toISOString() : null,
    })),
    approvals: approvals.rows.map(item => rowToApproval(item)),
    plannerRuns: plannerRuns.rows.map(item => ({
      id: String(item.id),
      state: String(item.state),
      actionCount: Number(item.action_count ?? 0),
      reason: item.reason ? String(item.reason) : null,
      signalCount: Number(item.signal_count ?? 0),
      startedAt: new Date(item.started_at).toISOString(),
      finishedAt: item.finished_at ? new Date(item.finished_at).toISOString() : null,
    })),
  };
}

/** Trajectory rows for one worker task or planner run (ordered by insert id). */
export async function listTrace(
  subjectType: 'worker' | 'planner',
  subjectId: string,
  limit = 3_000,
): Promise<TraceRow[]> {
  const result = await getPool().query(
    `SELECT id, seq, event_type, payload, created_at FROM task_trace
     WHERE subject_type = $1 AND subject_id = $2
     ORDER BY id ASC LIMIT $3`,
    [subjectType, subjectId, limit],
  );
  return result.rows.map(row => ({
    id: Number(row.id),
    seq: Number(row.seq),
    eventType: String(row.event_type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function listApprovals(limit = 100, status?: string): Promise<ApprovalRow[]> {
  const pool = getPool();
  const result = status
    ? await pool.query(
        `SELECT a.id, a.mission_id, m.name AS mission_name, a.type, a.status, a.payload,
                a.decided_by, a.decided_at, a.created_at
         FROM approvals a JOIN missions m ON m.id = a.mission_id
         WHERE a.status = $2 ORDER BY a.created_at DESC LIMIT $1`,
        [limit, status],
      )
    : await pool.query(
        `SELECT a.id, a.mission_id, m.name AS mission_name, a.type, a.status, a.payload,
                a.decided_by, a.decided_at, a.created_at
         FROM approvals a JOIN missions m ON m.id = a.mission_id
         ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT $1`,
        [limit],
      );
  return result.rows.map(rowToApproval);
}

export async function getApproval(id: string): Promise<ApprovalRow | null> {
  const result = await getPool().query(
    `SELECT id, mission_id, type, status, payload, decided_by, decided_at, created_at FROM approvals WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToApproval(result.rows[0]) : null;
}

function rowToTrigger(row: Record<string, unknown>): TriggerRow {
  return {
    id: String(row.id),
    source: String(row.source),
    kind: String(row.kind),
    route: String(row.route),
    state: String(row.state),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    ...(row.mission_name ? { missionName: String(row.mission_name) } : {}),
    type: String(row.type),
    status: String(row.status),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export interface ReplaySnapshot {
  missionId: string;
  toSeq: number;
  state: string;
  grantVersion: number;
  tasks: Array<{ id: string; state: string }>;
  matchesCurrent: boolean;
  diffs: string[];
  current: { state: string; grantVersion: number; tasks: Array<{ id: string; state: string }> };
}

/**
 * P2 events replay: rebuild mission/task/grant state from `events` up to an
 * arbitrary seq. This is the deterministic audit path; it compares the replay
 * against the live projection so a drifted writer shows up as a diff.
 */
export async function replayMission(missionId: string, toSeq?: number): Promise<ReplaySnapshot | null> {
  const pool = getPool();
  const mission = await pool.query(`SELECT id, state, grant_version FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const maxSeq = await pool.query(`SELECT COALESCE(max(seq), 0) AS seq FROM events WHERE mission_id = $1`, [missionId]);
  const targetSeq = toSeq ?? Number(maxSeq.rows[0]?.seq ?? 0);
  const events = await pool.query(
    `SELECT seq, event_type, aggregate_id, payload FROM events
     WHERE mission_id = $1 AND seq <= $2 ORDER BY seq ASC`,
    [missionId, targetSeq],
  );
  let state = 'pending';
  let grantVersion = 1;
  const tasks = new Map<string, string>();
  for (const event of events.rows) {
    const type = String(event.event_type);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const aggregate = String(event.aggregate_id ?? '');
    if (type === 'mission.created') {
      state = 'pending';
    } else if (type === 'task.created') {
      if (aggregate) tasks.set(aggregate, String(payload.state ?? 'proposed'));
    } else if (type === 'task.claimed') {
      if (aggregate) tasks.set(aggregate, 'leased');
      if (state === 'pending') state = 'running';
    } else if (type.startsWith('task.')) {
      const next = type.slice('task.'.length);
      if (aggregate && ['proposed', 'ready', 'leased', 'running', 'reported', 'verified', 'done', 'retry_wait', 'blocked', 'stale', 'exhausted', 'cancelled', 'handed_back'].includes(next)) {
        tasks.set(aggregate, next);
      }
    } else if (type === 'mission.paused') {
      state = 'paused';
    } else if (type === 'mission.resumed') {
      state = String(payload.stateAfterResume ?? 'running');
    } else if (type === 'mission.completed') {
      state = 'completed';
    } else if (type === 'mission.failed') {
      state = 'failed';
    } else if (type === 'grant.upgraded') {
      grantVersion = Number(payload.toVersion ?? grantVersion);
    }
  }
  const currentTasks = await pool.query(
    `SELECT id, state FROM tasks WHERE mission_id = $1 ORDER BY created_at ASC`,
    [missionId],
  );
  const current = {
    state: String(mission.rows[0].state),
    grantVersion: Number(mission.rows[0].grant_version),
    tasks: currentTasks.rows.map(row => ({ id: String(row.id), state: String(row.state) })),
  };
  const replayedTasks = [...tasks.entries()].map(([id, taskState]) => ({ id, state: taskState }));
  const diffs: string[] = [];
  if (current.state !== state) diffs.push(`mission.state: current=${current.state} replay=${state}`);
  if (current.grantVersion !== grantVersion) diffs.push(`mission.grantVersion: current=${current.grantVersion} replay=${grantVersion}`);
  for (const task of current.tasks) {
    const replayed = tasks.get(task.id);
    if (replayed === undefined) diffs.push(`task ${task.id}: missing task.created event (current=${task.state})`);
    else if (replayed !== task.state) diffs.push(`task ${task.id}: current=${task.state} replay=${replayed}`);
  }
  return {
    missionId,
    toSeq: targetSeq,
    state,
    grantVersion,
    tasks: replayedTasks,
    matchesCurrent: diffs.length === 0,
    diffs,
    current,
  };
}

export interface MissionBoard {
  missionId: string;
  version: number;
  baseVersion: number;
  conflicts: Array<{ section: string; reason: string }>;
  sections: {
    scope: Record<string, unknown>;
    assets: Array<Record<string, unknown>>;
    facts: Array<Record<string, unknown>>;
    capabilities: Array<Record<string, unknown>>;
    negatives: Array<Record<string, unknown>>;
    findings: Array<Record<string, unknown>>;
    todo: Array<Record<string, unknown>>;
    evidence: Record<string, unknown>;
  };
  generatedAt: string;
}

/**
 * P2 clue-board projection. It is derived from the authoritative tables (the
 * same source `events` are written from), versioned by the mission event
 * sequence, and exposes the eight board sections for the read-only console.
 */
export async function getMissionBoard(missionId: string): Promise<MissionBoard | null> {
  const pool = getPool();
  const mission = await pool.query(
    `SELECT m.id, m.name, m.state, m.target, m.grant_id, m.grant_version, g.scope,
            (SELECT COALESCE(max(seq), 0) FROM events WHERE mission_id = m.id) AS version
     FROM missions m LEFT JOIN grants g ON g.id = m.grant_id AND g.version = m.grant_version
     WHERE m.id = $1`,
    [missionId],
  );
  const row = mission.rows[0];
  if (!row) return null;
  const [tasks, todo, findings, evidence, triggers] = await Promise.all([
    pool.query(`SELECT id, type, state, attempt, last_error FROM tasks WHERE mission_id = $1 ORDER BY created_at ASC`, [missionId]),
    pool.query(`SELECT id, content, status, position FROM mission_todo WHERE mission_id = $1 ORDER BY position ASC`, [missionId]),
    pool.query(`SELECT id, title, category, severity, status, artifact, confidence, merged_count FROM findings WHERE mission_id = $1 ORDER BY created_at ASC`, [missionId]),
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE kind = 'target')::int AS target_count,
              count(*) FILTER (WHERE kind = 'internet')::int AS internet_count,
              count(DISTINCT url)::int AS distinct_urls
       FROM evidence WHERE mission_id = $1`,
      [missionId],
    ),
    pool.query(`SELECT kind, route, count(*)::int AS count FROM triggers WHERE mission_id = $1 GROUP BY kind, route`, [missionId]),
  ]);
  const evidenceRow = evidence.rows[0] ?? {};
  const hostSet = await pool.query(
    `SELECT DISTINCT split_part(regexp_replace(url, '^https?://', ''), '/', 1) AS host FROM evidence WHERE mission_id = $1`,
    [missionId],
  );
  const accepted = findings.rows.filter(item => item.status === 'accepted');
  const review = findings.rows.filter(item => item.status === 'needs_review' || item.status === 'review');
  return {
    missionId,
    version: Number(row.version ?? 0),
    baseVersion: Number(row.version ?? 0),
    conflicts: [],
    sections: {
      scope: {
        name: row.name,
        state: row.state,
        target: row.target,
        grantId: row.grant_id,
        grantVersion: row.grant_version,
        scope: row.scope ?? {},
      },
      assets: hostSet.rows.map(item => ({ host: String(item.host), source: 'evidence' })),
      facts: accepted.map(item => ({
        findingId: item.id,
        title: item.title,
        category: item.category,
        severity: item.severity,
        artifact: item.artifact,
      })),
      capabilities: tasks.rows
        .filter(task => task.state === 'done' || task.state === 'verified')
        .map(task => ({ taskId: task.id, type: task.type })),
      negatives: [
        ...review.map(item => ({ type: 'needs_review', findingId: item.id, title: item.title })),
        ...tasks.rows
          .filter(task => ['blocked', 'stale', 'exhausted'].includes(task.state))
          .map(task => ({ type: 'blocked_task', taskId: task.id, state: task.state, lastError: task.last_error })),
      ],
      findings: accepted.map(item => ({
        id: item.id,
        title: item.title,
        category: item.category,
        severity: item.severity,
        artifact: item.artifact,
        confidence: item.confidence,
        mergedCount: Number(item.merged_count ?? 0),
      })),
      todo: todo.rows.map(item => ({ id: item.id, position: item.position, content: item.content, status: item.status })),
      evidence: {
        total: Number(evidenceRow.total ?? 0),
        target: Number(evidenceRow.target_count ?? 0),
        internet: Number(evidenceRow.internet_count ?? 0),
        distinctUrls: Number(evidenceRow.distinct_urls ?? 0),
        triggers: triggers.rows.map(item => ({ kind: item.kind, route: item.route, count: Number(item.count) })),
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

export type MetricGroup = 'quality' | 'efficiency' | 'safety' | 'control';
export type MetricUnit = 'count' | 'ratio' | 'seconds' | 'tokens';

/**
 * One entry of the P3-A2 metric catalog. `value` is null ("N/A") whenever the
 * denominator is empty; an explicit null is different from a real 0 rate.
 */
export interface MetricValue {
  id: string;
  group: MetricGroup;
  label: string;
  unit: MetricUnit;
  definition: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface MetricsSummary {
  generatedAt: string;
  missions: { total: number; active: number; completed: number; failed: number };
  findings: {
    total: number;
    accepted: number;
    needsReview: number;
    rejected: number;
    merged: number;
    validated: number;
    /** Internal quality metric: accepted findings that carry an artifact value. */
    artifacts: number;
  };
  rates: {
    reviewRate: number;
    validationRate: number;
    stuckRate: number;
    duplicateMergeRate: number;
    /** P3-A2 nullable rates: null means "no data yet" (N/A), never a fake zero. */
    falsePositiveRate: number | null;
    taskSuccessRate: number | null;
    taskRetryRate: number | null;
    handbackRate: number | null;
    evidenceDepth: number | null;
  };
  timing: { avgTimeToFirstFactSeconds: number | null; avgMissionSeconds: number | null };
  tasks: {
    total: number;
    running: number;
    stale: number;
    stuck: number;
    done: number;
    failed: number;
    exhausted: number;
    handedBack: number;
    attempted: number;
    retried: number;
  };
  evidence: { total: number; target: number; internet: number };
  cost: { totalTokens: number; tokensPerValidatedFinding: number | null };
  /** The 12-metric P3-A2 catalog (ADR-0019 removed the denial metric) (order is stable for the console). */
  indicators: MetricValue[];
}

/** Raw SQL aggregates; converted to MetricsSummary by a pure, tested builder. */
export interface MetricsAggregates {
  generatedAt: string;
  missions: { total: number; active: number; completed: number; failed: number; avgSeconds: number | null };
  findings: {
    total: number;
    accepted: number;
    needsReview: number;
    rejected: number;
    merged: number;
    validated: number;
    artifacts: number;
    acceptedEvidenceRefs: number;
  };
  tasks: {
    total: number;
    running: number;
    stale: number;
    stuck: number;
    done: number;
    failed: number;
    exhausted: number;
    handedBack: number;
    attempted: number;
    retried: number;
  };
  evidence: { total: number; target: number; internet: number };
  timing: { avgTimeToFirstFactSeconds: number | null };
  cost: { totalTokens: number };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * P3-A2 metric catalog: 12 indicators over quality / efficiency / safety /
 * control. Formulas are documented in docs/decisions/0009-p3-thirteen-metrics.md（历史 13 项口径；ADR-0019 后为 12）;
 * this function is pure so the empty-denominator (N/A) semantics stay tested
 * without a database.
 */
export function buildMetricsSummary(aggregates: MetricsAggregates): MetricsSummary {
  const { missions, findings, tasks, evidence, timing, cost } = aggregates;
  const terminalTasks = tasks.done + tasks.failed + tasks.exhausted;
  const acceptedEvidenceRefs = findings.acceptedEvidenceRefs;
  const rate = (id: string, group: MetricGroup, label: string, definition: string, numerator: number, denominator: number, unit: MetricUnit = 'ratio'): MetricValue => ({
    id,
    group,
    label,
    unit,
    definition,
    value: ratio(numerator, denominator),
    numerator,
    denominator,
  });
  const count = (id: string, group: MetricGroup, label: string, definition: string, value: number): MetricValue => ({
    id,
    group,
    label,
    unit: 'count',
    definition,
    value,
    numerator: value,
    denominator: null,
  });
  const indicators: MetricValue[] = [
    count('validated_findings', 'quality', '已验证发现',
      'status=accepted 且 evidence_ids 引用数 ≥2 的 finding 数', findings.validated),
    rate('validation_rate', 'quality', '验证率',
      '已验证发现 / 全部 finding', findings.validated, findings.total),
    rate('review_rate', 'quality', '复核率',
      'needs_review finding / 全部 finding', findings.needsReview, findings.total),
    rate('false_positive_rate', 'quality', '误报率',
      '被拒绝 finding / (accepted + rejected)，排除待复核', findings.rejected, findings.accepted + findings.rejected),
    rate('duplicate_intent_rate', 'quality', '重复意图率',
      'root-cause 合并次数 / (accepted + 合并次数)', findings.merged, findings.accepted + findings.merged),
    rate('evidence_depth', 'quality', '证据深度',
      'accepted finding 的平均证据引用数', acceptedEvidenceRefs, findings.accepted),
    {
      id: 'time_to_first_fact_seconds',
      group: 'efficiency',
      label: '首个事实耗时',
      unit: 'seconds',
      definition: 'mission 创建到第一条 finding 的平均秒数（按有 finding 的 mission 平均）',
      value: timing.avgTimeToFirstFactSeconds,
      numerator: null,
      denominator: null,
    },
    rate('stuck_rate', 'safety', '卡死率',
      'running/leased 超过 15 分钟的任务 / 全部任务', tasks.stuck, tasks.total),
    rate('task_success_rate', 'efficiency', '任务成功率',
      'done / (done + failed + exhausted)，排除人工 cancelled', tasks.done, terminalTasks),
    rate('task_retry_rate', 'efficiency', '任务重试率',
      'attempt > 1 的任务 / 被领取过的任务 (attempt > 0)', tasks.retried, tasks.attempted),
    rate('handback_rate', 'control', '交还率',
      'handed_back 任务 / 被领取过的任务 (attempt > 0)', tasks.handedBack, tasks.attempted),
    rate('tokens_per_validated_finding', 'efficiency', '单位验证成本',
      '累计 Harness token 用量 / 已验证发现数（token 为成本代理，不是账单）',
      cost.totalTokens, findings.validated, 'tokens'),
  ];

  return {
    generatedAt: aggregates.generatedAt,
    missions: {
      total: missions.total,
      active: missions.active,
      completed: missions.completed,
      failed: missions.failed,
    },
    findings: {
      total: findings.total,
      accepted: findings.accepted,
      needsReview: findings.needsReview,
      rejected: findings.rejected,
      merged: findings.merged,
      validated: findings.validated,
      artifacts: findings.artifacts,
    },
    rates: {
      reviewRate: ratio(findings.needsReview, findings.total) ?? 0,
      validationRate: ratio(findings.validated, findings.total) ?? 0,
      stuckRate: ratio(tasks.stuck, tasks.total) ?? 0,
      duplicateMergeRate: ratio(findings.merged, findings.accepted + findings.merged) ?? 0,
      falsePositiveRate: ratio(findings.rejected, findings.accepted + findings.rejected),
      taskSuccessRate: ratio(tasks.done, terminalTasks),
      taskRetryRate: ratio(tasks.retried, tasks.attempted),
      handbackRate: ratio(tasks.handedBack, tasks.attempted),
      evidenceDepth: ratio(acceptedEvidenceRefs, findings.accepted),
    },
    timing: {
      avgTimeToFirstFactSeconds: timing.avgTimeToFirstFactSeconds,
      avgMissionSeconds: missions.avgSeconds,
    },
    tasks,
    evidence,
    cost: {
      totalTokens: cost.totalTokens,
      tokensPerValidatedFinding: ratio(cost.totalTokens, findings.validated),
    },
    indicators,
  };
}

/** P3-A2 metrics: 12 indicators, all derived from PostgreSQL projections. */
export async function getMetrics(): Promise<MetricsSummary> {
  const pool = getPool();
  const [missions, findings, tasks, evidence, tokens] = await Promise.all([
    pool.query(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE state IN ('pending','running'))::int AS active,
        count(*) FILTER (WHERE state = 'completed')::int AS completed,
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        avg(extract(epoch FROM (completed_at - created_at))) FILTER (WHERE completed_at IS NOT NULL) AS avg_seconds
      FROM missions`),
    pool.query(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE status = 'needs_review' OR status = 'review')::int AS needs_review,
        count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COALESCE(sum(merged_count), 0)::int AS merged,
        count(*) FILTER (WHERE status = 'accepted'
          AND jsonb_typeof(evidence_ids) = 'array'
          AND jsonb_array_length(evidence_ids) >= 2)::int AS validated,
        COALESCE(sum(CASE WHEN jsonb_typeof(evidence_ids) = 'array' THEN jsonb_array_length(evidence_ids) ELSE 0 END)
          FILTER (WHERE status = 'accepted'), 0)::int AS accepted_evidence_refs
      FROM findings`),
    pool.query(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE state = 'running')::int AS running,
        count(*) FILTER (WHERE state = 'stale')::int AS stale,
        count(*) FILTER (WHERE state IN ('running','leased') AND started_at < now() - interval '15 minutes')::int AS stuck,
        count(*) FILTER (WHERE state = 'done')::int AS done,
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        count(*) FILTER (WHERE state = 'exhausted')::int AS exhausted,
        count(*) FILTER (WHERE state = 'handed_back')::int AS handed_back,
        count(*) FILTER (WHERE attempt > 0)::int AS attempted,
        count(*) FILTER (WHERE attempt > 1)::int AS retried
      FROM tasks`),
    pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE kind = 'target')::int AS target,
        count(*) FILTER (WHERE kind = 'internet')::int AS internet
      FROM evidence`),
    pool.query(`SELECT COALESCE(sum(
        CASE
          WHEN jsonb_typeof(report->'tokens'->'total') = 'number' THEN (report->'tokens'->>'total')::bigint
          ELSE
            (CASE WHEN jsonb_typeof(report->'tokens'->'input') = 'number' THEN (report->'tokens'->>'input')::bigint ELSE 0 END) +
            (CASE WHEN jsonb_typeof(report->'tokens'->'output') = 'number' THEN (report->'tokens'->>'output')::bigint ELSE 0 END)
        END), 0)::bigint AS total_tokens
      FROM worker_reports`),
  ]);
  const timeToFirst = await pool.query(
    `SELECT avg(extract(epoch FROM (first_finding.created_at - m.created_at))) AS avg_seconds
     FROM missions m
     JOIN LATERAL (SELECT created_at FROM findings WHERE mission_id = m.id ORDER BY created_at ASC LIMIT 1) first_finding ON true`,
  );
  const m = missions.rows[0] ?? {};
  const f = findings.rows[0] ?? {};
  const t = tasks.rows[0] ?? {};
  const e = evidence.rows[0] ?? {};
  return buildMetricsSummary({
    generatedAt: new Date().toISOString(),
    missions: {
      total: Number(m.total ?? 0),
      active: Number(m.active ?? 0),
      completed: Number(m.completed ?? 0),
      failed: Number(m.failed ?? 0),
      avgSeconds: m.avg_seconds == null ? null : Number(m.avg_seconds),
    },
    findings: {
      total: Number(f.total ?? 0),
      accepted: Number(f.accepted ?? 0),
      needsReview: Number(f.needs_review ?? 0),
      rejected: Number(f.rejected ?? 0),
      merged: Number(f.merged ?? 0),
      validated: Number(f.validated ?? 0),
      artifacts: Number(f.artifacts ?? 0),
      acceptedEvidenceRefs: Number(f.accepted_evidence_refs ?? 0),
    },
    tasks: {
      total: Number(t.total ?? 0),
      running: Number(t.running ?? 0),
      stale: Number(t.stale ?? 0),
      stuck: Number(t.stuck ?? 0),
      done: Number(t.done ?? 0),
      failed: Number(t.failed ?? 0),
      exhausted: Number(t.exhausted ?? 0),
      handedBack: Number(t.handed_back ?? 0),
      attempted: Number(t.attempted ?? 0),
      retried: Number(t.retried ?? 0),
    },
    evidence: { total: Number(e.total ?? 0), target: Number(e.target ?? 0), internet: Number(e.internet ?? 0) },
    timing: {
      avgTimeToFirstFactSeconds: timeToFirst.rows[0]?.avg_seconds == null ? null : Number(timeToFirst.rows[0].avg_seconds),
    },
    cost: { totalTokens: Number(tokens.rows[0]?.total_tokens ?? 0) },
  });
}

export async function listFindings(limit = 100, missionId?: string): Promise<FindingListItem[]> {
  const result = await getPool().query(
    `SELECT f.id, f.mission_id, m.name AS mission_name, f.title, f.category, f.severity,
            f.status, f.artifact, f.confidence, f.merged_count, f.created_at,
            COALESCE(jsonb_array_length(f.evidence_ids), 0) AS evidence_count
     FROM findings f
     JOIN missions m ON m.id = f.mission_id
     WHERE ($2::uuid IS NULL OR f.mission_id = $2::uuid)
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit, missionId ?? null],
  );
  return result.rows.map(rowToFinding);
}

export async function getFinding(id: string): Promise<FindingDetail | null> {
  const result = await getPool().query(
    `SELECT f.id, f.mission_id, m.name AS mission_name, f.title, f.category, f.severity,
            f.status, f.artifact, f.confidence, f.merged_count, f.created_at, f.report_md, f.curator_reasons,
            COALESCE(jsonb_array_length(f.evidence_ids), 0) AS evidence_count
     FROM findings f
     JOIN missions m ON m.id = f.mission_id
     WHERE f.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const evidenceIds = await getPool().query(`SELECT evidence_ids FROM findings WHERE id = $1`, [id]);
  const ids: string[] = evidenceIds.rows[0]?.evidence_ids ?? [];
  let evidence: EvidenceRow[] = [];
  if (ids.length > 0) {
    const rows = await getPool().query(
      `SELECT id, traffic_ref, kind, method, url, request_text, response_text,
              request_sha256, response_sha256, request_bytes, response_bytes, untrusted, created_at
       FROM evidence WHERE id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [ids],
    );
    evidence = rows.rows.map(rowToEvidence);
  }
  return {
    ...rowToFinding(row),
    reportMd: String(row.report_md),
    curatorReasons: (row.curator_reasons ?? []) as string[],
    evidence,
  };
}

export async function getEvidence(id: string): Promise<EvidenceRow | null> {
  const result = await getPool().query(
    `SELECT id, traffic_ref, kind, method, url, request_text, response_text,
            request_sha256, response_sha256, request_bytes, response_bytes, untrusted, created_at
     FROM evidence WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToEvidence(result.rows[0]) : null;
}


function rowToMission(row: Record<string, unknown>): MissionListItem {
  return {
    id: String(row.id),
    name: String(row.name),
    state: String(row.state),
    target: (row.target as MissionTarget | null) ?? null,
    objective: (row.objective as string | null) ?? null,
    workerId: (row.worker_id as string | null) ?? null,
    findingsCount: Number(row.findings_count ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
  };
}

function rowToFinding(row: Record<string, unknown>): FindingListItem {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    missionName: String(row.mission_name),
    title: String(row.title),
    category: String(row.category),
    severity: String(row.severity),
    status: String(row.status),
    artifact: (row.artifact as string | null) ?? null,
    evidenceCount: Number(row.evidence_count ?? 0),
    confidence: (String(row.confidence ?? 'unverified') as 'observed' | 'inferred' | 'unverified'),
    mergedCount: Number(row.merged_count ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToEvidence(row: Record<string, unknown>): EvidenceRow {
  return {
    id: String(row.id),
    trafficRef: String(row.traffic_ref),
    kind: String(row.kind),
    method: String(row.method),
    url: String(row.url),
    requestText: String(row.request_text),
    responseText: String(row.response_text),
    requestSha256: String(row.request_sha256),
    responseSha256: String(row.response_sha256),
    requestBytes: Number(row.request_bytes),
    responseBytes: Number(row.response_bytes),
    untrusted: Boolean(row.untrusted),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
