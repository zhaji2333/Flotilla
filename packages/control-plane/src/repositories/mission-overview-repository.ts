import type { Pool } from 'pg';
import { getPool } from '../db';
import { getMissionFrontier, type MissionFrontier } from './blackboard-repository';
import { getMissionTraceSummary, type MissionTraceSummary } from './trace-summary-repository';
import { getMissionAssetGraph } from './asset-graph-repository';

// ── M5-1 project overview read model ───────────────────────
// One bounded, prompt-ready "project situation" shared by Planner, Worker and
// the console. It is assembled from authoritative tables only; no request or
// response bodies are ever included. `fitMissionOverview` enforces a hard JSON
// budget by dropping low-priority sections before trimming values.

const OPEN_TASK_STATES = ['proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked'];

export interface OverviewTask {
  id: string;
  state: string;
  type: string;
  objective: string;
  angle: string | null;
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
  trust: string;
  sensitive: boolean;
  provenance: string;
  taskId: string | null;
  createdAt: string;
}

export interface OverviewFinding {
  id: string;
  title: string;
  category: string;
  severity: string;
  artifact: string | null;
  status: string;
  confidence: string;
  taskId: string | null;
  createdAt: string;
}

export interface OverviewHint {
  id: string;
  content: string;
  source: string;
  kind: string;
  state: string;
  createdAt: string;
}

export interface OverviewTodo {
  id: number;
  content: string;
  status: string;
  position: number;
}

export interface MissionOverview {
  mission: {
    id: string;
    name: string;
    state: string;
    objective: string;
    target: { type: string; value: string };
    grantVersion: number;
    createdAt: string;
  };
  tasks: { open: OverviewTask[]; recent: OverviewTask[]; counts: { open: number; done: number; failed: number; total: number } };
  facts: { items: OverviewFact[]; counts: { total: number; byKind: Record<string, number>; sensitive: number } };
  frontier: MissionFrontier | null;
  findings: { accepted: OverviewFinding[]; needsReview: OverviewFinding[]; counts: { accepted: number; needsReview: number } };
  hints: { items: OverviewHint[]; pending: number };
  negatives: { blocked: number; exhausted: number; stale: number; needsReview: number; total: number };
  traces: {
    totals: MissionTraceSummary['totals'] | null;
    tasks: Array<{ taskId: string; state: string; steps: number; tokens: number; toolCalls: number; findings: number; finalText: string | null }>;
  };
  todo: { items: OverviewTodo[] };
  assets: { total: number; byType: Record<string, number>; items: Array<{ type: string; value: string; taskId: string | null }> };
  coverage: { total: number; covered: number; ratio: number | null };
  budget: { tokens: number; steps: number };
  version: number;
  generatedAt: string;
  truncated?: boolean;
}

export interface MissionOverviewOptions {
  /** Hard JSON budget for the serialized overview (default 8000 chars). */
  maxChars?: number;
  /** Include the typed blackboard frontier (default true for M5). */
  includeFrontier?: boolean;
}

const DEFAULT_MAX_CHARS = 8_000;

function clip(value: unknown, max = 300): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function rowToTask(row: Record<string, unknown>): OverviewTask {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    state: String(row.state),
    type: String(row.type),
    objective: clip(payload.objective ?? row.type, 300),
    angle: row.angle ? String(row.angle) : null,
    priority: Number(row.priority ?? 0.5),
    dependsOn: ((row.depends_on ?? []) as string[]).map(String),
    attempt: Number(row.attempt ?? 0),
    lastError: row.last_error ? clip(row.last_error, 300) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
  };
}

export async function getMissionOverview(
  pool: Pool | undefined,
  missionId: string,
  options: MissionOverviewOptions = {},
): Promise<MissionOverview | null> {
  const db = pool ?? getPool();
  const mission = await db.query(
    `SELECT id, name, state, objective, target, grant_version, created_at FROM missions WHERE id = $1`,
    [missionId],
  );
  if (mission.rowCount === 0) return null;
  const row = mission.rows[0];
  const target = (row.target ?? {}) as { type?: string; value?: string };
  const [openTasks, recentTasks, counts, facts, factCounts, factKinds, findingsAccepted, findingsReview, findingCounts, hints, todo, assets, assetCounts, negatives, version, traceSummary] = await Promise.all([
    db.query(`SELECT * FROM tasks WHERE mission_id = $1 AND state = ANY($2::text[]) ORDER BY priority DESC, created_at ASC LIMIT 30`, [missionId, OPEN_TASK_STATES]),
    db.query(`SELECT * FROM tasks WHERE mission_id = $1 AND state <> ALL($2::text[]) ORDER BY created_at DESC LIMIT 20`, [missionId, OPEN_TASK_STATES]),
    db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state = ANY($2::text[]))::int AS open,
        count(*) FILTER (WHERE state IN ('done','verified'))::int AS done,
        count(*) FILTER (WHERE state IN ('failed','exhausted'))::int AS failed
      FROM tasks WHERE mission_id = $1`, [missionId, OPEN_TASK_STATES]),
    db.query(`SELECT id, kind, key, value, summary, trust, sensitive, provenance, task_id, created_at
      FROM mission_facts WHERE mission_id = $1
      ORDER BY CASE kind WHEN 'credential' THEN 0 WHEN 'vuln' THEN 1 WHEN 'host' THEN 2 ELSE 3 END, created_at DESC LIMIT 30`, [missionId]),
    db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE sensitive)::int AS sensitive
      FROM mission_facts WHERE mission_id = $1`, [missionId]),
    db.query(`SELECT kind, count(*)::int AS count FROM mission_facts WHERE mission_id = $1 GROUP BY kind`, [missionId]),
    db.query(`SELECT id, title, category, severity, artifact, status, confidence, task_id, created_at
      FROM findings WHERE mission_id = $1 AND status = 'accepted' ORDER BY created_at DESC LIMIT 20`, [missionId]),
    db.query(`SELECT id, title, category, severity, artifact, status, confidence, task_id, created_at
      FROM findings WHERE mission_id = $1 AND status = 'needs_review' ORDER BY created_at DESC LIMIT 20`, [missionId]),
    db.query(`SELECT count(*) FILTER (WHERE status='accepted')::int AS accepted,
        count(*) FILTER (WHERE status='needs_review')::int AS needs_review FROM findings WHERE mission_id = $1`, [missionId]),
    db.query(`SELECT id, content, source, kind, state, created_at FROM task_hints
      WHERE mission_id = $1 ORDER BY created_at DESC LIMIT 10`, [missionId]),
    db.query(`SELECT id, content, status, position FROM mission_todo WHERE mission_id = $1 ORDER BY position ASC, created_at ASC LIMIT 30`, [missionId]),
    db.query(`SELECT type, value, task_id, created_at FROM assets WHERE mission_id = $1 ORDER BY created_at DESC LIMIT 20`, [missionId]),
    db.query(`SELECT type, count(*)::int AS count FROM assets WHERE mission_id = $1 GROUP BY type`, [missionId]),
    db.query(`SELECT
        count(*) FILTER (WHERE state='blocked')::int AS blocked,
        count(*) FILTER (WHERE state='exhausted')::int AS exhausted,
        count(*) FILTER (WHERE state='stale')::int AS stale,
        (SELECT count(*)::int FROM findings f WHERE f.mission_id = $1 AND f.status='needs_review') AS needs_review
      FROM tasks WHERE mission_id = $1`, [missionId]),
    db.query(`SELECT COALESCE(max(seq),0)::int AS version FROM events WHERE mission_id = $1`, [missionId]),
    getMissionTraceSummary(db, missionId).catch(() => null),
  ]);
  const [frontier, assetGraph] = await Promise.all([
    options.includeFrontier === false
      ? Promise.resolve(null)
      : getMissionFrontier(db, missionId, { factLimit: 20, intentLimit: 20 }).catch(() => null),
    getMissionAssetGraph(db, missionId).catch(() => null),
  ]);
  const byType = Object.fromEntries(assetCounts.rows.map(item => [String(item.type), Number(item.count)]));
  const assetTotal = Object.values(byType).reduce((sum, value) => sum + value, 0);
  const overview: MissionOverview = {
    mission: {
      id: String(row.id),
      name: String(row.name),
      state: String(row.state),
      objective: clip(row.objective, 800),
      target: { type: String(target.type ?? 'url'), value: String(target.value ?? '') },
      grantVersion: Number(row.grant_version ?? 1),
      createdAt: new Date(row.created_at as string).toISOString(),
    },
    tasks: {
      open: openTasks.rows.map(rowToTask),
      recent: recentTasks.rows.map(rowToTask),
      counts: {
        open: Number(counts.rows[0]?.open ?? 0),
        done: Number(counts.rows[0]?.done ?? 0),
        failed: Number(counts.rows[0]?.failed ?? 0),
        total: Number(counts.rows[0]?.total ?? 0),
      },
    },
    facts: {
      items: facts.rows.map(item => ({
        id: String(item.id),
        kind: String(item.kind),
        key: clip(item.key, 200),
        value: clip(item.value, 500),
        summary: clip(item.summary, 200),
        trust: String(item.trust),
        sensitive: Boolean(item.sensitive),
        provenance: String(item.provenance),
        taskId: item.task_id ? String(item.task_id) : null,
        createdAt: new Date(item.created_at as string).toISOString(),
      })),
      counts: {
        total: Number(factCounts.rows[0]?.total ?? 0),
        byKind: Object.fromEntries(factKinds.rows.map(item => [String(item.kind), Number(item.count)])),
        sensitive: Number(factCounts.rows[0]?.sensitive ?? 0),
      },
    },
    frontier,
    findings: {
      accepted: findingsAccepted.rows.map(row => ({
        id: String(row.id), title: clip(row.title, 200), category: String(row.category), severity: String(row.severity),
        artifact: row.artifact ? clip(row.artifact, 200) : null, status: String(row.status), confidence: String(row.confidence),
        taskId: row.task_id ? String(row.task_id) : null, createdAt: new Date(row.created_at as string).toISOString(),
      })),
      needsReview: findingsReview.rows.map(row => ({
        id: String(row.id), title: clip(row.title, 200), category: String(row.category), severity: String(row.severity),
        artifact: row.artifact ? clip(row.artifact, 200) : null, status: String(row.status), confidence: String(row.confidence),
        taskId: row.task_id ? String(row.task_id) : null, createdAt: new Date(row.created_at as string).toISOString(),
      })),
      counts: { accepted: Number(findingCounts.rows[0]?.accepted ?? 0), needsReview: Number(findingCounts.rows[0]?.needs_review ?? 0) },
    },
    hints: {
      items: hints.rows.map(item => ({
        id: String(item.id), content: clip(item.content, 300), source: String(item.source), kind: String(item.kind ?? 'guidance'),
        state: String(item.state), createdAt: new Date(item.created_at as string).toISOString(),
      })),
      pending: hints.rows.filter(item => String(item.state) === 'pending').length,
    },
    negatives: {
      blocked: Number(negatives.rows[0]?.blocked ?? 0), exhausted: Number(negatives.rows[0]?.exhausted ?? 0),
      stale: Number(negatives.rows[0]?.stale ?? 0), needsReview: Number(negatives.rows[0]?.needs_review ?? 0),
      total: Number(negatives.rows[0]?.blocked ?? 0) + Number(negatives.rows[0]?.exhausted ?? 0) + Number(negatives.rows[0]?.stale ?? 0) + Number(negatives.rows[0]?.needs_review ?? 0),
    },
    traces: {
      totals: traceSummary?.totals ?? null,
      tasks: (traceSummary?.tasks ?? []).slice(0, 10).map(task => ({
        taskId: task.taskId, state: task.state, steps: task.steps, tokens: task.tokens.total,
        toolCalls: task.toolCalls, findings: task.findings, finalText: task.finalText ? clip(task.finalText, 300) : null,
      })),
    },
    todo: {
      items: todo.rows.map(item => ({ id: Number(item.id), content: clip(item.content, 300), status: String(item.status), position: Number(item.position) })),
    },
    assets: {
      total: assetGraph?.counts.total ?? assetTotal,
      byType: assetGraph?.counts.byType ?? byType,
      items: assets.rows.map(item => ({ type: String(item.type), value: clip(item.value, 400), taskId: item.task_id ? String(item.task_id) : null })),
    },
    coverage: assetGraph
      ? { total: assetGraph.counts.total, covered: assetGraph.counts.covered, ratio: assetGraph.counts.ratio }
      : { total: assetTotal, covered: 0, ratio: null },
    budget: { tokens: Number(traceSummary?.totals.tokens.total ?? 0), steps: Number(traceSummary?.totals.steps ?? 0) },
    version: Number(version.rows[0]?.version ?? 0),
    generatedAt: new Date().toISOString(),
  };
  return fitMissionOverview(overview, options.maxChars ?? DEFAULT_MAX_CHARS);
}

/** Enforces the JSON budget without producing invalid JSON. */
export function fitMissionOverview(overview: MissionOverview, maxChars = DEFAULT_MAX_CHARS): MissionOverview {
  const budget = Math.max(500, Math.floor(maxChars));
  const size = (value: MissionOverview): number => JSON.stringify(value).length;
  const copy = { ...overview };
  if (size(copy) <= budget) return copy;
  copy.truncated = true;
  const reduce = [
    () => { copy.traces = { totals: copy.traces.totals, tasks: [] }; },
    () => { copy.findings.needsReview = copy.findings.needsReview.slice(0, 5); },
    () => { copy.hints.items = copy.hints.items.slice(0, 3); },
    () => { copy.facts.items = copy.facts.items.slice(0, 10); },
    () => { copy.tasks.recent = copy.tasks.recent.slice(0, 5); },
    () => { copy.assets.items = copy.assets.items.slice(0, 5); },
    () => { copy.findings.accepted = copy.findings.accepted.slice(0, 5); },
    () => { copy.todo.items = copy.todo.items.slice(0, 5); },
  ];
  for (const step of reduce) {
    step();
    if (size(copy) <= budget) return copy;
  }
  const clipDeep = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    if (Array.isArray(value)) return value.map(clipDeep);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clipDeep(item)]));
    return value;
  };
  copy.facts.items = (clipDeep(copy.facts.items) as OverviewFact[]).slice(0, 5);
  copy.tasks.open = (clipDeep(copy.tasks.open) as OverviewTask[]).slice(0, 5);
  copy.tasks.recent = [];
  copy.findings.accepted = (clipDeep(copy.findings.accepted) as OverviewFinding[]).slice(0, 3);
  copy.findings.needsReview = [];
  copy.hints.items = [];
  copy.assets.items = [];
  copy.todo.items = [];
  copy.traces.tasks = [];
  if (copy.frontier) {
    copy.frontier = { ...copy.frontier, intents: copy.frontier.intents.slice(0, 3), facts: copy.frontier.facts.slice(0, 3) };
  }
  // Last resort: shrink the remaining arrays/sections until the hard budget is met.
  for (let guard = 0; guard < 80 && size(copy) > budget; guard += 1) {
    if (copy.facts.items.length > 0) copy.facts.items.pop();
    else if (copy.findings.accepted.length > 0) copy.findings.accepted.pop();
    else if (copy.tasks.open.length > 0) copy.tasks.open.pop();
    else if (copy.frontier && copy.frontier.facts.length > 0) copy.frontier = { ...copy.frontier, facts: copy.frontier.facts.slice(0, -1) };
    else if (copy.frontier && copy.frontier.intents.length > 0) copy.frontier = { ...copy.frontier, intents: copy.frontier.intents.slice(0, -1) };
    else if (copy.mission.objective.length > 120) copy.mission.objective = `${copy.mission.objective.slice(0, 120)}…`;
    else if (copy.mission.name.length > 80) copy.mission.name = `${copy.mission.name.slice(0, 80)}…`;
    else break;
  }
  return copy;
}
