import type { Pool } from 'pg';
import { getPool } from '../db';

// ── M5-4 cross-worker trace search ────────────────────────
// Reuses the existing task_trace records (same mission only). Results are
// summaries, never raw request/response bodies, and are explicitly marked
// untrusted. Current task and planner traces are excluded.

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

export interface WorkerTraceSearchResult {
  missionId: string;
  q: string;
  excludeTaskId: string | null;
  hits: WorkerTraceHit[];
  total: number;
  truncated: boolean;
  untrusted: true;
}

export interface WorkerTraceSearchOptions {
  q?: string;
  excludeTaskId?: string;
  limit?: number;
}

function clip(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarize(payload: Record<string, unknown>): {
  tool: string | null;
  url: string | null;
  method: string | null;
  command: string | null;
  status: string | null;
  summary: string;
} {
  const input = (payload.input ?? {}) as Record<string, unknown>;
  const tool = typeof payload.tool === 'string' ? payload.tool : null;
  const url = typeof input.url === 'string' ? input.url : null;
  const method = typeof input.method === 'string' ? input.method : null;
  const command = typeof input.command === 'string' ? input.command : null;
  const rawStatus = payload.status ?? payload.exitCode;
  const status = typeof rawStatus === 'string' || typeof rawStatus === 'number' ? String(rawStatus) : null;
  const result = payload.result ?? payload.text ?? payload.output ?? payload.summary;
  const summary = clip(result ?? (url ? `${method ?? 'GET'} ${url}` : command ?? payload), 500);
  return { tool, url, method, command, status, summary };
}

export async function searchMissionWorkerTraces(
  pool: Pool | undefined,
  missionId: string,
  options: WorkerTraceSearchOptions = {},
): Promise<WorkerTraceSearchResult | null> {
  const db = pool ?? getPool();
  const mission = await db.query(`SELECT id FROM missions WHERE id = $1`, [missionId]);
  if (mission.rowCount === 0) return null;
  const q = (options.q ?? '').trim().slice(0, 200);
  const excludeTaskId = options.excludeTaskId && /^[0-9a-f-]{36}$/i.test(options.excludeTaskId) ? options.excludeTaskId : null;
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 20)));
  const rows = await db.query(
    `SELECT id, task_id, seq, event_type, payload, created_at
     FROM task_trace
     WHERE mission_id = $1 AND subject_type = 'worker'
       AND ($2 = '' OR search_text ILIKE '%' || $2 || '%' OR payload::text ILIKE '%' || $2 || '%')
       AND ($3::uuid IS NULL OR task_id IS DISTINCT FROM $3::uuid)
       AND event_type IN ('tool_call', 'tool_result', 'final', 'context', 'status')
     ORDER BY id DESC LIMIT 200`,
    [missionId, q, excludeTaskId],
  );
  // A tool_result usually has no URL/tool in its own payload; join its sibling
  // tool_call (same callId) so a result search still tells the worker what was
  // probed. This is a bounded, mission-local lookup and never returns bodies.
  const callRows = await db.query(
    `SELECT payload FROM task_trace
     WHERE mission_id = $1 AND subject_type = 'worker' AND event_type = 'tool_call'
       AND ($2::uuid IS NULL OR task_id IS DISTINCT FROM $2::uuid)
     ORDER BY id DESC LIMIT 1000`,
    [missionId, excludeTaskId],
  );
  const callFields = new Map<string, { tool: string | null; url: string | null; method: string | null; command: string | null }>();
  for (const row of callRows.rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.callId === 'string' ? payload.callId : null;
    if (!callId) continue;
    const input = (payload.input ?? {}) as Record<string, unknown>;
    callFields.set(callId, {
      tool: typeof payload.tool === 'string' ? payload.tool : null,
      url: typeof input.url === 'string' ? input.url : null,
      method: typeof input.method === 'string' ? input.method : null,
      command: typeof input.command === 'string' ? input.command : null,
    });
  }
  const priority: Record<string, number> = { tool_call: 0, tool_result: 1, final: 2, context: 3, status: 4 };
  const hits: WorkerTraceHit[] = rows.rows.map(row => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.callId === 'string' ? payload.callId : null;
    const fields = summarize(payload);
    const sibling = callId ? callFields.get(callId) : undefined;
    return {
      traceId: String(row.id),
      taskId: row.task_id ? String(row.task_id) : null,
      callId,
      seq: Number(row.seq),
      eventType: String(row.event_type),
      tool: fields.tool ?? sibling?.tool ?? null,
      url: fields.url ?? sibling?.url ?? null,
      method: fields.method ?? sibling?.method ?? null,
      command: fields.command ?? sibling?.command ?? null,
      status: fields.status,
      summary: fields.summary,
      createdAt: new Date(row.created_at as string).toISOString(),
      untrusted: true as const,
    };
  }).sort((left, right) => {
    const byType = (priority[left.eventType] ?? 9) - (priority[right.eventType] ?? 9);
    return byType !== 0 ? byType : right.createdAt.localeCompare(left.createdAt);
  }).slice(0, limit);
  return { missionId, q, excludeTaskId, hits, total: hits.length, truncated: rows.rows.length > limit, untrusted: true };
}
