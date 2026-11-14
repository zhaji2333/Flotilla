import type { Pool } from 'pg';
import { getPool } from '../db';
import { getMissionOverview } from './mission-overview-repository';
import { getMissionAssetGraph } from './asset-graph-repository';
import { searchMissionWorkerTraces, type WorkerTraceHit } from './worker-trace-repository';
import { listRecentRequestIndex } from './request-index-repository';
import type { RequestIndexEntry } from '@src-agent/contracts';

// ── M5-3 mission context for Workers ───────────────────────
// Written once per claim into a run-local JSON file. The brief is prompt-sized;
// the file carries bounded details for read-only mission tools. It is
// mission-scoped, never contains raw request/response bodies, and is deleted
// with the run directory. Sensitive fact values are included for the authorized
// worker only; the prompt brief masks them.

export interface MissionContext {
  mission: { id: string; name: string; state: string; objective: string; target: { type: string; value: string }; grantVersion: number };
  brief: string;
  facts: Array<{ id: string; kind: string; key: string; value: string; summary: string; trust: string; sensitive: boolean; provenance: string; taskId: string | null }>;
  findings: Array<{ id: string; title: string; category: string; severity: string; artifact: string | null; status: string; confidence: string; taskId: string | null }>;
  tasks: { open: Array<Record<string, unknown>>; recent: Array<Record<string, unknown>> };
  frontier: unknown;
  hints: Array<{ id: string; content: string; source: string; kind: string; state: string }>;
  workerTraces: WorkerTraceHit[];
  /** Cross-task request fingerprints for advisory dedupe. */
  requestIndex: RequestIndexEntry[];
  assets: { total: number; byType: Record<string, number>; items: Array<{ type: string; value: string; taskId: string | null }> };
  coverage: { total: number; covered: number; ratio: number | null };
  traces: Array<{ taskId: string; state: string; steps: number; tokens: number; toolCalls: number; findings: number; finalText: string | null }>;
  version: number;
  generatedAt: string;
  truncated?: boolean;
}

export interface MissionContextOptions {
  maxBytes?: number;
  briefMaxChars?: number;
  /** Request-dedupe window from runtime settings (minutes). */
  requestIndexTtlMinutes?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_BRIEF_CHARS = 2_500;

function clip(value: unknown, max = 300): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function briefFromOverview(overview: Awaited<ReturnType<typeof getMissionOverview>>, maxChars: number): string {
  if (!overview) return '';
  const lines: string[] = [
    `PROJECT BRIEF: ${overview.mission.name} [${overview.mission.state}]`,
    `objective: ${overview.mission.objective}`,
    `target: ${overview.mission.target.type} ${overview.mission.target.value}`,
    `tasks: open=${overview.tasks.counts.open} done=${overview.tasks.counts.done} failed=${overview.tasks.counts.failed} total=${overview.tasks.counts.total}`,
    `findings: accepted=${overview.findings.counts.accepted} needs_review=${overview.findings.counts.needsReview}`,
    `facts: total=${overview.facts.counts.total} sensitive=${overview.facts.counts.sensitive} kinds=${Object.entries(overview.facts.counts.byKind).map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`,
    `coverage: ${overview.coverage.covered}/${overview.coverage.total} assets (${overview.coverage.ratio === null ? 'n/a' : Math.round(overview.coverage.ratio * 100) + '%'})`,
    `budget: tokens=${overview.budget.tokens} steps=${overview.budget.steps} version=${overview.version}`,
  ];
  if (overview.negatives.total > 0) lines.push(`negatives: blocked=${overview.negatives.blocked} exhausted=${overview.negatives.exhausted} stale=${overview.negatives.stale} needs_review=${overview.negatives.needsReview}`);
  if (overview.tasks.open.length > 0) {
    lines.push('open tasks:');
    for (const task of overview.tasks.open.slice(0, 8)) lines.push(`- ${task.id} [${task.state}] ${task.objective}${task.angle ? ` (angle=${task.angle})` : ''}`);
  }
  const facts = overview.facts.items.filter(fact => !fact.sensitive).slice(0, 10);
  if (facts.length > 0) {
    lines.push('high-signal facts:');
    for (const fact of facts) lines.push(`- [${fact.kind}|${fact.trust}] ${fact.key}: ${fact.value}`);
  }
  const sensitive = overview.facts.items.filter(fact => fact.sensitive).slice(0, 5);
  if (sensitive.length > 0) {
    lines.push('sensitive facts (use mission_fact/mission_recall for details):');
    for (const fact of sensitive) lines.push(`- [${fact.kind}] sensitive fact ${fact.id} (use mission_fact/mission_recall; value masked)`);
  }
  if (overview.findings.accepted.length > 0) {
    lines.push('accepted findings:');
    for (const finding of overview.findings.accepted.slice(0, 8)) lines.push(`- ${finding.severity}/${finding.category}: ${finding.title}`);
  }
  if (overview.hints.items.length > 0) {
    lines.push('recent hints:');
    for (const hint of overview.hints.items.slice(0, 5)) lines.push(`- [${hint.kind}] ${hint.content}`);
  }
  if (overview.traces.tasks.length > 0) {
    lines.push('recent worker traces (statistics only):');
    for (const task of overview.traces.tasks.slice(0, 5)) lines.push(`- ${task.taskId} [${task.state}] steps=${task.steps} tools=${task.toolCalls} findings=${task.findings}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export async function buildMissionContext(
  pool: Pool | undefined,
  missionId: string,
  taskId?: string,
  options: MissionContextOptions = {},
): Promise<MissionContext | null> {
  const db = pool ?? getPool();
  const overview = await getMissionOverview(db, missionId, { maxChars: 12_000 });
  if (!overview) return null;
  const [facts, findings, assets, traces] = await Promise.all([
    db.query(`SELECT id, kind, key, value, summary, trust, sensitive, provenance, task_id FROM mission_facts WHERE mission_id = $1 ORDER BY created_at DESC LIMIT 200`, [missionId]),
    db.query(`SELECT id, title, category, severity, artifact, status, confidence, task_id FROM findings WHERE mission_id = $1 AND status IN ('accepted','needs_review') ORDER BY created_at DESC LIMIT 50`, [missionId]),
    getMissionAssetGraph(db, missionId),
    Promise.resolve(overview.traces),
  ]);
  const requestIndex = await listRecentRequestIndex(db, missionId, 100, options.requestIndexTtlMinutes).catch(() => []);
  const workerTraces = (await searchMissionWorkerTraces(db, missionId, {
    ...(taskId ? { excludeTaskId: taskId } : {}),
    limit: 20,
  }).catch(() => null))?.hits ?? [];
  let context: MissionContext = {
    mission: overview.mission,
    brief: briefFromOverview(overview, Math.max(500, Math.min(6_000, options.briefMaxChars ?? DEFAULT_BRIEF_CHARS))),
    facts: facts.rows.map(row => ({
      id: String(row.id), kind: String(row.kind), key: clip(row.key, 300), value: clip(row.value, 2_000),
      summary: clip(row.summary, 500), trust: String(row.trust), sensitive: Boolean(row.sensitive),
      provenance: String(row.provenance), taskId: row.task_id ? String(row.task_id) : null,
    })),
    findings: findings.rows.map(row => ({
      id: String(row.id), title: clip(row.title, 300), category: String(row.category), severity: String(row.severity),
      artifact: row.artifact ? clip(row.artifact, 300) : null, status: String(row.status), confidence: String(row.confidence),
      taskId: row.task_id ? String(row.task_id) : null,
    })),
    tasks: {
      open: overview.tasks.open as unknown as Array<Record<string, unknown>>,
      recent: overview.tasks.recent as unknown as Array<Record<string, unknown>>,
    },
    frontier: overview.frontier,
    hints: overview.hints.items,
    workerTraces,
    requestIndex,
    assets: {
      total: assets?.counts.total ?? overview.assets.total,
      byType: assets?.counts.byType ?? overview.assets.byType,
      items: overview.assets.items,
    },
    coverage: assets?.counts ? { total: assets.counts.total, covered: assets.counts.covered, ratio: assets.counts.ratio } : overview.coverage,
    traces: traces.tasks,
    version: overview.version,
    generatedAt: new Date().toISOString(),
  };
  const maxBytes = Math.max(16_000, options.maxBytes ?? Number(process.env.MISSION_CONTEXT_MAX_BYTES || DEFAULT_MAX_BYTES));
  if (Buffer.byteLength(JSON.stringify(context), 'utf8') <= maxBytes) return context;
  context.truncated = true;
  const shrink = [
    () => { context.workerTraces = context.workerTraces.slice(0, 10); },
    () => { context.facts = context.facts.slice(0, 80); },
    () => { context.tasks.recent = context.tasks.recent.slice(0, 20); },
    () => { context.findings = context.findings.slice(0, 20); },
    () => { context.workerTraces = context.workerTraces.slice(0, 5); },
    () => { context.facts = context.facts.slice(0, 30); },
    () => { context.assets.items = context.assets.items.slice(0, 10); },
    () => { context.traces = context.traces.slice(0, 5); },
    () => { context.facts = context.facts.slice(0, 10); },
    () => { context.tasks.open = context.tasks.open.slice(0, 5); },
  ];
  for (const step of shrink) {
    step();
    if (Buffer.byteLength(JSON.stringify(context), 'utf8') <= maxBytes) return context;
  }
  context.workerTraces = [];
  context.findings = [];
  context.assets.items = [];
  context.traces = [];
  context.brief = clip(context.brief, 1_500);
  return context;
}
