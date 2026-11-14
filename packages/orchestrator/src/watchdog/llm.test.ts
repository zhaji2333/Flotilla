import { describe, expect, it } from 'vitest';
import { parseWatchdogReview } from './llm.js';

describe('watchdog LLM verdict parser', () => {
  it('parses plain and fenced JSON verdicts', () => {
    expect(parseWatchdogReview('{"verdict":"drift","reason":"off target"}')).toEqual({ verdict: 'drift', reason: 'off target' });
    expect(parseWatchdogReview('```json\n{"verdict":"ok","reason":"progress"}\n```')).toEqual({ verdict: 'ok', reason: 'progress' });
  });

  it('rejects unknown verdicts and malformed output', () => {
    expect(parseWatchdogReview('{"verdict":"maybe","reason":"?"}')).toBeNull();
    expect(parseWatchdogReview('not json')).toBeNull();
  });
});
