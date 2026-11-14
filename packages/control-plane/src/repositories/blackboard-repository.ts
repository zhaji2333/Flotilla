import type { Pool } from 'pg';
import { getPool } from '../db';

// ── P3-B1 typed blackboard read model ──────────────────────
// mission_facts / mission_intents are DATABASE VIEWS over the authoritative
// tables (assets/findings/evidence/tasks) created in schema.sql. This module is
// read-only: nothing writes the blackboard directly, so it can be dropped and
// rebuilt at any time and never becomes a second source of truth.
//
// Credential values are stored/returned in plaintext per explicit user decision
// (ADR-0010); `sensitive` lets the console mask them by default without a
// second storage path.

export interface MissionFact {
  id: string;
  missionId: string;
  source: string;
  sourceId: string;
  kind: string;
  key: string;
  value: string;
  summary: string;
  provenance: string;
  trust: string;
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

export interface MissionFactsResult {
  missionId: string;
  facts: MissionFact[];
  total: number;
}

export interface ListFactsOptions {
  kind?: string;
  trust?: string;
  limit?: number;
}

export interface RecallFactsOptions extends ListFactsOptions {
  /** Maximum facts returned; the recall query itself is capped at 100. */
  limit?: number;
}

export interface FrontierOptions {
  factLimit?: number;
  intentLimit?: number;
}

/** Kinds that are interesting for "what can I do next" (resolved artifacts excluded). */
const FRONTIER_FACT_KINDS = [
  'credential',
  'vuln',
  'host',
  'endpoint',
  'parameter',
  'technology',
  'identity',
  'file',
];

function toIso(value: unknown): string {
  return new Date(value as string).toISOString();
}

function rowToFact(row: Record<string, unknown>): MissionFact {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    source: String(row.source),
    sourceId: String(row.source_id),
    kind: String(row.kind),
    key: String(row.key),
    value: String(row.value),
    summary: String(row.summary),
    provenance: String(row.provenance),
    trust: String(row.trust),
    sensitive: Boolean(row.sensitive),
    taskId: row.task_id ? String(row.task_id) : null,
    createdAt: toIso(row.created_at),
  };
}

function rowToIntent(row: Record<string, unknown>): MissionIntent {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    type: String(row.type),
    state: String(row.state),
    objective: String(row.objective),
    priority: Number(row.priority ?? 0),
    dependsOn: (row.depends_on ?? []) as string[],
    attempt: Number(row.attempt ?? 0),
    createdAt: toIso(row.created_at),
  };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(max, parsed));
}

async function missionName(db: Pool, missionId: string): Promise<string | null> {
  const result = await db.query(`SELECT name FROM missions WHERE id = $1`, [missionId]);
  return result.rowCount === 0 ? null : String(result.rows[0].name);
}

const FACT_COLUMNS = `id, mission_id, source, source_id, kind, key, value, summary, provenance, trust, sensitive, task_id, created_at`;

/** Typed facts for one mission (read-only projection). Returns null if missing. */
export async function listMissionFacts(
  pool: Pool | undefined,
  missionId: string,
  options: ListFactsOptions = {},
): Promise<MissionFactsResult | null> {
  const db = pool ?? getPool();
  if ((await missionName(db, missionId)) === null) return null;
  const limit = clamp(options.limit, 200, 500);
  const filters: string[] = ['mission_id = $1'];
  const params: unknown[] = [missionId];
  if (options.kind) {
    params.push(options.kind);
    filters.push(`kind = $${params.length}`);
  }
  if (options.trust) {
    params.push(options.trust);
    filters.push(`trust = $${params.length}`);
  }
  params.push(limit);
  const result = await db.query(
    `SELECT ${FACT_COLUMNS} FROM mission_facts
     WHERE ${filters.join(' AND ')}
     ORDER BY CASE kind
       WHEN 'credential' THEN 0 WHEN 'vuln' THEN 1 WHEN 'artifact' THEN 2
       WHEN 'host' THEN 3 WHEN 'endpoint' THEN 4 ELSE 5 END, created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  const countParams: unknown[] = [missionId];
  const countFilters: string[] = ['mission_id = $1'];
  if (options.kind) {
    countParams.push(options.kind);
    countFilters.push(`kind = $${countParams.length}`);
  }
  if (options.trust) {
    countParams.push(options.trust);
    countFilters.push(`trust = $${countParams.length}`);
  }
  const count = await db.query(`SELECT count(*)::int AS total FROM mission_facts WHERE ${countFilters.join(' AND ')}`, countParams);
  return {
    missionId,
    facts: result.rows.map(rowToFact),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

/**
 * Substring recall over fact key/value/summary (case-insensitive). Intended for
 * the console search box and Planner "doc on demand"; not a protocol tool.
 */
export async function recallMissionFacts(
  pool: Pool | undefined,
  missionId: string,
  query: string,
  options: RecallFactsOptions = {},
): Promise<MissionFactsResult | null> {
  const db = pool ?? getPool();
  if ((await missionName(db, missionId)) === null) return null;
  const needle = query.trim();
  if (!needle) return { missionId, facts: [], total: 0 };
  const limit = clamp(options.limit, 50, 100);
  const params: unknown[] = [missionId, `%${needle}%`];
  const filters: string[] = ['mission_id = $1', '(key ILIKE $2 OR value ILIKE $2 OR summary ILIKE $2)'];
  if (options.kind) {
    params.push(options.kind);
    filters.push(`kind = $${params.length}`);
  }
  params.push(limit);
  const result = await db.query(
    `SELECT ${FACT_COLUMNS} FROM mission_facts
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return { missionId, facts: result.rows.map(rowToFact), total: result.rows.length };
}

/**
 * Frontier = open intents + high-signal unresolved facts, with event-seq version
 * so the console can correlate it with replay. This is the Planner snapshot
 * input for P3-B1.
 */
export async function getMissionFrontier(
  pool: Pool | undefined,
  missionId: string,
  options: FrontierOptions = {},
): Promise<MissionFrontier | null> {
  const db = pool ?? getPool();
  if ((await missionName(db, missionId)) === null) return null;
  const factLimit = clamp(options.factLimit, 30, 100);
  const intentLimit = clamp(options.intentLimit, 30, 100);
  const [version, facts, intents, counts] = await Promise.all([
    db.query(`SELECT COALESCE(max(seq), 0)::int AS version FROM events WHERE mission_id = $1`, [missionId]),
    db.query(
      `SELECT ${FACT_COLUMNS} FROM mission_facts
       WHERE mission_id = $1 AND kind = ANY($2::text[])
       ORDER BY CASE kind
         WHEN 'credential' THEN 0 WHEN 'vuln' THEN 1 WHEN 'host' THEN 2
         WHEN 'endpoint' THEN 3 WHEN 'parameter' THEN 4 ELSE 5 END, created_at DESC
       LIMIT $3`,
      [missionId, FRONTIER_FACT_KINDS, factLimit],
    ),
    db.query(
      `SELECT id, mission_id, type, state, objective, priority, depends_on, attempt, created_at
       FROM mission_intents WHERE mission_id = $1
       ORDER BY priority DESC, created_at ASC LIMIT $2`,
      [missionId, intentLimit],
    ),
    db.query(
      `SELECT kind, count(*)::int AS total,
              count(*) FILTER (WHERE sensitive)::int AS sensitive_total
       FROM mission_facts WHERE mission_id = $1 GROUP BY kind`,
      [missionId],
    ),
  ]);
  const byKind: Record<string, number> = {};
  let factsTotal = 0;
  let sensitiveFacts = 0;
  for (const row of counts.rows) {
    byKind[String(row.kind)] = Number(row.total);
    factsTotal += Number(row.total);
    sensitiveFacts += Number(row.sensitive_total);
  }
  const intentCount = await db.query(`SELECT count(*)::int AS total FROM mission_intents WHERE mission_id = $1`, [missionId]);
  return {
    missionId,
    version: Number(version.rows[0]?.version ?? 0),
    generatedAt: new Date().toISOString(),
    intents: intents.rows.map(rowToIntent),
    facts: facts.rows.map(rowToFact),
    counts: {
      facts: factsTotal,
      intents: Number(intentCount.rows[0]?.total ?? 0),
      sensitiveFacts,
      byKind,
    },
  };
}
