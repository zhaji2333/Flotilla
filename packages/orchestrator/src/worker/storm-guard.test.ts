import { describe, expect, it } from 'vitest';
import { StormGuard } from './storm-guard.js';

describe('worker storm guard', () => {
  it('does not delay below the threshold and resets on success', () => {
    const guard = new StormGuard({ threshold: 3, baseMs: 1000, maxMs: 10_000 });
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.tripped).toBe(false);
    expect(guard.delayMs()).toBe(0);
    guard.recordFailure();
    expect(guard.tripped).toBe(true);
    expect(guard.delayMs()).toBe(1000);
    guard.recordSuccess();
    expect(guard.consecutiveFailures).toBe(0);
    expect(guard.delayMs()).toBe(0);
  });

  it('grows exponentially and stays bounded', () => {
    const guard = new StormGuard({ threshold: 2, baseMs: 1000, maxMs: 8_000 });
    for (let index = 0; index < 10; index += 1) guard.recordFailure();
    expect(guard.delayMs()).toBe(8_000);
  });
});
