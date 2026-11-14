import type { TraceEntry } from '../harness/trace.js';
import { fingerprintRequest, type RequestFingerprintInput } from '@src-agent/contracts';

// Extracts only target HTTP requests from a task's compact trace. The index is
// written by the trusted controller after a run; the plugin only reads it.
export function requestFingerprintsFromTrace(trace: readonly TraceEntry[] | undefined): RequestFingerprintInput[] {
  if (!trace || trace.length === 0) return [];
  const out: RequestFingerprintInput[] = [];
  for (const entry of trace) {
    if (entry.type !== 'tool_call') continue;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (payload.tool !== 'http_request') continue;
    const input = (payload.input ?? {}) as Record<string, unknown>;
    if (typeof input.url !== 'string') continue;
    out.push(fingerprintRequest({
      method: typeof input.method === 'string' ? input.method : 'GET',
      url: input.url,
      body: input.body,
      headers: input.headers,
    }));
  }
  return out;
}
