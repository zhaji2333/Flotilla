import { describe, expect, it } from 'vitest';
import { appendTrace, traceFromCliLine, traceFromSessionEvent, type TraceEntry } from './trace.js';

describe('harness trace capture', () => {
  it('maps headless NDJSON thinking/text/tool events', () => {
    const thinking = traceFromCliLine(JSON.stringify({ type: 'thinking', text: 'we should recon' }), 1);
    expect(thinking?.seq).toBe(1);
    expect(thinking?.type).toBe('thinking');
    expect(thinking?.payload).toEqual({ type: 'thinking', text: 'we should recon' });
    expect(typeof thinking?.ts).toBe('string');
    const tool = traceFromCliLine(JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'http_request', input: { url: 'http://t/' } }), 2);
    expect(tool?.type).toBe('tool_call');
    expect(tool?.payload.tool).toBe('http_request');
    expect(traceFromCliLine('not json', 3)).toBeNull();
  });

  it('truncates oversized payload text', () => {
    const entry = traceFromCliLine(JSON.stringify({ type: 'tool_result', result: 'x'.repeat(20_000) }), 1);
    expect(String(entry?.payload.result).length).toBeLessThan(7_000);
    expect(String(entry?.payload.result)).toContain('[truncated]');
  });

  it('maps in-process session events including tool calls and context injections', () => {
    const call = traceFromSessionEvent({ type: 'tool/call', data: { callId: 'c1', name: 'skill', arguments: '{"name":"ck-router"}' } }, 1);
    expect(call?.type).toBe('tool_call');
    expect(call?.payload.input).toEqual({ name: 'ck-router' });
    const context = traceFromSessionEvent({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'CONTROL-PLANE HINTS' }] } } }, 2);
    expect(context?.type).toBe('context');
    const thinking = traceFromSessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }] } } }, 3);
    expect(thinking?.type).toBe('thinking');
  });

  it('caps the number of trace entries', () => {
    const trace: TraceEntry[] = [];
    for (let index = 0; index < 4_000; index += 1) appendTrace(trace, { seq: index, type: 'text', payload: {} });
    expect(trace.length).toBe(3_000);
  });
});
