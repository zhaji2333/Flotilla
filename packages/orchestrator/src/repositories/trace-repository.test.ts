import { describe, expect, it } from 'vitest';
import { buildTraceSearchText, sanitizeTracePayload } from './trace-repository';

describe('trace payload sanitization', () => {
  it('builds a bounded search text with URL/command/status but only a short result excerpt', () => {
    const text = buildTraceSearchText({
      seq: 1,
      type: 'tool_call',
      payload: { tool: 'http_request', type: 'tool_call', input: { url: 'http://target.test:64280/api', method: 'POST' } },
      ts: new Date().toISOString(),
    });
    expect(text).toContain('http_request');
    expect(text).toContain('target.test:64280');
    expect(text).toContain('POST');

    const longResult = 'x'.repeat(2_000);
    const resultText = buildTraceSearchText({
      seq: 2,
      type: 'tool_result',
      payload: { type: 'tool_result', result: longResult, status: 'completed' },
      ts: new Date().toISOString(),
    });
    expect(resultText.length).toBeLessThan(2_000);
    expect(resultText).toContain('completed');
  });

  it('removes NUL bytes that PostgreSQL JSONB rejects', () => {
    const payload = { text: 'ok\u0000bad', nested: { list: ['a\u0000b', 1, null] } };
    const clean = sanitizeTracePayload(payload);
    expect(JSON.stringify(clean)).not.toContain('\\u0000');
    expect(clean).toEqual({ text: 'okbad', nested: { list: ['ab', 1, null] } });
  });
});
