// ── Harness trajectory capture ──────────────────────────────
// Turns raw Harness events (CLI NDJSON or session events) into compact trace
// rows for the console: thinking, text, tool calls/results, skill loads,
// context injections and step/status markers. Payload text is truncated so a
// runaway tool output cannot bloat PostgreSQL.

export interface TraceEntry {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  /** Capture time (ISO); persisted as task_trace.created_at. */
  ts?: string;
}

const MAX_ENTRY_CHARS = 6_000;
const MAX_TRACE_ENTRIES = 3_000;

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_ENTRY_CHARS ? `${value.slice(0, MAX_ENTRY_CHARS)}…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 40).map(clip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) out[key] = clip(item);
    return out;
  }
  return value;
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) payload[key] = clip(value);
  return payload;
}

/** Parses one headless `--json` NDJSON line into a trace entry. */
export function traceFromCliLine(line: string, seq: number): TraceEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(event.type ?? 'event');
    return { seq, type, payload: payloadOf(event), ts: new Date().toISOString() };
  } catch {
    return null;
  }
}

/** Maps one in-process session event into a trace entry. */
export function traceFromSessionEvent(event: {
  type: string;
  data?: Record<string, unknown>;
}, seq: number): TraceEntry | null {
  const data = event.data ?? {};
  if (event.type === 'assistant/message') {
    const message = (data as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
    const blocks = message?.content ?? [];
    const thinking = blocks.filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('');
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    if (thinking) return { seq, type: 'thinking', payload: { text: clip(thinking) }, ts: new Date().toISOString() };
    if (text) return { seq, type: 'text', payload: { text: clip(text) }, ts: new Date().toISOString() };
    return { seq, type: 'assistant_message', payload: { blocks: clip(blocks) }, ts: new Date().toISOString() };
  }
  if (event.type === 'tool/call') {
    const rawArguments = (data as { arguments?: unknown }).arguments;
    let input: unknown = rawArguments;
    if (typeof rawArguments === 'string') {
      try {
        input = JSON.parse(rawArguments);
      } catch {
        input = rawArguments;
      }
    }
    return {
      seq,
      type: 'tool_call',
      payload: {
        callId: clip((data as { callId?: unknown }).callId),
        tool: clip((data as { name?: unknown }).name),
        input: clip(input),
      },
    };
  }
  if (event.type === 'tool/result') {
    const message = (data as { message?: { content?: Array<{ type: string; text?: string }>; isError?: boolean; toolCallId?: unknown } }).message;
    const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    return {
      seq,
      type: 'tool_result',
      payload: { callId: clip(message?.toolCallId), status: message?.isError ? 'error' : 'completed', result: clip(text) },
    };
  }
  if (event.type === 'user/message' || event.type === 'developer/message' || event.type === 'system/message') {
    const message = (data as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
    const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    return { seq, type: event.type === 'user/message' ? 'context' : event.type, payload: { text: clip(text) } };
  }
  if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
    return {
      seq,
      type: 'status',
      payload: {
        phase: event.type,
        step: clip((data as { step?: unknown }).step),
        turn: clip((data as { turn?: unknown }).turn),
        reason: clip((data as { reason?: unknown }).reason),
      },
    };
  }
  return { seq, type: event.type, payload: payloadOf(data) };
}

export function appendTrace(trace: TraceEntry[], entry: TraceEntry | null): void {
  if (!entry || trace.length >= MAX_TRACE_ENTRIES) return;
  if (!entry.ts) entry.ts = new Date().toISOString();
  trace.push(entry);
}
