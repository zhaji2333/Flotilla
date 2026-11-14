import { describe, expect, it } from 'vitest';
import { createRunEventAccumulator } from './events.js';

const sample = [
  '{"type":"session","sessionId":"session-1","cwd":"/tmp/ws"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"tool_call","callId":"c1","tool":"http_request","input":{}}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":100,"outputTokens":10,"totalTokens":110}}',
  '{"type":"status","phase":"step_start","turn":1,"step":2}',
  '{"type":"tool_call","callId":"c2","tool":"report_finding","input":{}}',
  '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":200,"outputTokens":20,"totalTokens":220}}',
  'not json at all',
  '{"type":"final","sessionId":"session-1","reason":{"kind":"completed"},"text":"done"}',
].join('\n');

describe('createRunEventAccumulator', () => {
  it('tracks session, steps, tools, usage and completion', () => {
    const accumulator = createRunEventAccumulator();
    for (const line of sample.split('\n')) accumulator.observe(line);
    const summary = accumulator.summary();
    expect(summary.sessionId).toBe('session-1');
    expect(summary.steps).toBe(2);
    expect(summary.toolCalls).toBe(2);
    expect(summary.tokenUsage).toEqual({ input: 300, output: 30, total: 330 });
    expect(summary.completed).toBe(true);
    expect(summary.finalText).toBe('done');
  });

  it('reports a non-completed reason as an error', () => {
    const accumulator = createRunEventAccumulator();
    accumulator.observe('{"type":"final","sessionId":"s","reason":{"kind":"error","error":{"message":"boom"}},"text":""}');
    const summary = accumulator.summary();
    expect(summary.completed).toBe(false);
    expect(summary.error).toBe('boom');
  });

  it('exposes live step and token counters for the budget watchdog', () => {
    const accumulator = createRunEventAccumulator();
    accumulator.observe('{"type":"status","phase":"step_end","step":3,"usage":{"totalTokens":500}}');
    expect(accumulator.steps()).toBe(3);
    expect(accumulator.tokens()).toBe(500);
  });
});
