import type { Pool } from 'pg';
import { z } from 'zod';
import { getPool } from '../db';

// ── P3-A6 eval history (structured JSON index) ─────────────
// Eval scripts still write Markdown/JSON reports to evals/reports; this table
// stores a bounded structured summary so the console can list/diff history
// without treating generated files as a database source of truth.

export const EvalRunInputSchema = z.object({
  kind: z.enum(['matrix', 'fixture', 'effect', 'frozen', 'replay', 'other']),
  name: z.string().min(1).max(200),
  status: z.enum(['completed', 'failed', 'partial']).default('completed'),
  summary: z.record(z.string(), z.unknown()).default({}),
  details: z.record(z.string(), z.unknown()).optional(),
  recordedBy: z.string().min(1).max(120).optional(),
}).strict();

export type EvalRunInput = z.infer<typeof EvalRunInputSchema>;

export interface EvalRunRow {
  id: string;
  kind: string;
  name: string;
  status: string;
  summary: Record<string, unknown>;
  details: Record<string, unknown> | null;
  recordedBy: string | null;
  createdAt: string;
}

function rowToEval(row: Record<string, unknown>): EvalRunRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    name: String(row.name),
    status: String(row.status),
    summary: (row.summary ?? {}) as Record<string, unknown>,
    details: row.details ? (row.details as Record<string, unknown>) : null,
    recordedBy: row.recorded_by ? String(row.recorded_by) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function recordEvalRun(
  input: EvalRunInput,
  pool: Pool | undefined = undefined,
): Promise<EvalRunRow> {
  const db = pool ?? getPool();
  const result = await db.query(
    `INSERT INTO eval_runs (kind, name, status, summary, details, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, kind, name, status, summary, details, recorded_by, created_at`,
    [input.kind, input.name, input.status, JSON.stringify(input.summary), input.details ? JSON.stringify(input.details) : null, input.recordedBy ?? null],
  );
  return rowToEval(result.rows[0]);
}

export async function listEvalRuns(options: { kind?: string; limit?: number } = {}, pool: Pool | undefined = undefined): Promise<EvalRunRow[]> {
  const db = pool ?? getPool();
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const result = options.kind
    ? await db.query(
        `SELECT id, kind, name, status, summary, details, recorded_by, created_at FROM eval_runs
         WHERE kind = $1 ORDER BY created_at DESC LIMIT $2`,
        [options.kind, limit],
      )
    : await db.query(
        `SELECT id, kind, name, status, summary, details, recorded_by, created_at FROM eval_runs
         ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
  return result.rows.map(rowToEval);
}

/** Latest run per kind (for the dashboard cards). */
export async function listLatestEvalRuns(pool: Pool | undefined = undefined): Promise<EvalRunRow[]> {
  const db = pool ?? getPool();
  const result = await db.query(
    `SELECT DISTINCT ON (kind) id, kind, name, status, summary, details, recorded_by, created_at
     FROM eval_runs ORDER BY kind, created_at DESC`,
  );
  return result.rows.map(rowToEval);
}

export async function getEvalRun(id: string, pool: Pool | undefined = undefined): Promise<EvalRunRow | null> {
  const db = pool ?? getPool();
  const result = await db.query(
    `SELECT id, kind, name, status, summary, details, recorded_by, created_at FROM eval_runs WHERE id = $1`,
    [id],
  );
  return result.rowCount === 0 ? null : rowToEval(result.rows[0]);
}

/** Recent missions used by the replay check; newest first. */
export async function listRecentMissionIds(limit = 5, pool: Pool | undefined = undefined): Promise<string[]> {
  const db = pool ?? getPool();
  const capped = Math.max(1, Math.min(20, Math.floor(limit)));
  const result = await db.query(`SELECT id FROM missions ORDER BY created_at DESC LIMIT $1`, [capped]);
  return result.rows.map(row => String(row.id));
}
