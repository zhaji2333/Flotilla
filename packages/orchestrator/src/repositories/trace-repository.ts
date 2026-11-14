import type { Pool } from 'pg';
import type { TraceEntry } from '../harness/trace.js';

// ── Task/planner trajectory persistence ────────────────────
// Trace rows are append-only, ordered by id, and keyed by (subject_type,
// subject_id). One insert batch per Harness run keeps the write overhead low.

export interface TraceRecordInput {
  missionId: string;
  taskId?: string | null;
  subjectType: 'worker' | 'planner';
  subjectId: string;
  entries: readonly TraceEntry[];
}

/** PostgreSQL JSONB rejects \u0000; tool output can contain NUL bytes. */
export function sanitizeTracePayload(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(item => sanitizeTracePayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeTracePayload(item)]));
  }
  return value;
}

/**
 * Build a bounded searchable projection of one trace event. It intentionally
 * excludes full request/response bodies: the search index is for "have we
 * already probed this URL/command/status?" not a second evidence store.
 */
export function buildTraceSearchText(entry: TraceEntry): string {
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const input = (payload.input ?? {}) as Record<string, unknown>;
  const result = payload.result;
  const resultText = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
      ? JSON.stringify(result)
      : '';
  const status = typeof payload.status === 'string' || typeof payload.status === 'number'
    ? String(payload.status)
    : typeof payload.exitCode === 'number'
      ? `exit:${payload.exitCode}`
      : '';
  return [entry.type, payload.tool, input.url, input.method, input.command, input.name, input.path, status, resultText.slice(0, 600)]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => String(value).replaceAll('\u0000', '').replace(/\s+/g, ' ').trim())
    .join(' ')
    .slice(0, 6_000);
}

export async function recordTaskTrace(pool: Pool, input: TraceRecordInput): Promise<number> {
  if (input.entries.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchSize = 100;
    for (let offset = 0; offset < input.entries.length; offset += batchSize) {
      const batch = input.entries.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const tuples: string[] = [];
      batch.forEach((entry, index) => {
        const base = index * 9;
        tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8}::timestamptz,$${base + 9})`);
        values.push(
          input.missionId,
          input.taskId ?? null,
          input.subjectType,
          input.subjectId,
          entry.seq,
          entry.type,
          JSON.stringify(sanitizeTracePayload(entry.payload)),
          entry.ts ?? new Date().toISOString(),
          buildTraceSearchText(entry),
        );
      });
      await client.query(
        `INSERT INTO task_trace (mission_id, task_id, subject_type, subject_id, seq, event_type, payload, created_at, search_text)
         VALUES ${tuples.join(',')}`,
        values,
      );
    }
    await client.query('COMMIT');
    return input.entries.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
