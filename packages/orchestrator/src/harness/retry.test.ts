import { describe, expect, it } from 'vitest';
import { isTransientFailure, retryBackoffMs, SETTLEMENT_MAX_TURNS, SETTLEMENT_TIMEOUT_MS, TRANSIENT_TRIES } from './retry.js';
import type { HarnessRunOutcome } from './runner.js';

function outcome(partial: Partial<HarnessRunOutcome>): HarnessRunOutcome {
  return {
    completed: false, artifacts: [], evidence: [], findings: [], assets: [], steps: 0,
    tokenUsage: { input: 0, output: 0, total: 0 }, finalText: '', ...partial,
  };
}

describe('transient failure classification', () => {
  it('retries network/rate-limit/provider failures', () => {
    for (const error of [
      'fetch failed',
      'ECONNRESET while calling model',
      'DeepSeek 429 rate limit',
      'HTTP 503 overloaded',
      'socket hang up',
    ]) {
      expect(isTransientFailure(outcome({ error }))).toBe(true);
    }
  });

  it('does not retry timeouts, step limits or completed runs', () => {
    expect(isTransientFailure(outcome({ failureClass: 'run_timeout' }))).toBe(false);
    expect(isTransientFailure(outcome({ failureClass: 'step_limit_exceeded' }))).toBe(false);
    expect(isTransientFailure(outcome({ completed: true }))).toBe(false);
  });

  it('retries an isolated runtime child crash', () => {
    expect(isTransientFailure(outcome({ failureClass: 'runtime_crash' }))).toBe(true);
    expect(isTransientFailure(outcome({ failureClass: 'runtime_timeout' }))).toBe(false);
  });

  it('does not retry a clean non-transient failure', () => {
    expect(isTransientFailure(outcome({ failureClass: 'tool_error', error: 'invalid json in report' }))).toBe(false);
  });

  it('uses a growing backoff', () => {
    expect(retryBackoffMs(1)).toBe(15_000);
    expect(retryBackoffMs(2)).toBe(30_000);
  });

  it('keeps ARTEX-derived settlement bounds', () => {
    expect(SETTLEMENT_MAX_TURNS).toBe(10);
    expect(SETTLEMENT_TIMEOUT_MS).toBe(120_000);
    expect(TRANSIENT_TRIES).toBe(3);
  });
});
