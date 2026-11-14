import { describe, expect, it } from 'vitest';
import { leaseRetryBackoffMs } from './worker-repository.js';

describe('lease retry backoff', () => {
  it('grows with the attempt and caps at two minutes', () => {
    expect(leaseRetryBackoffMs(1)).toBe(15_000);
    expect(leaseRetryBackoffMs(2)).toBe(30_000);
    expect(leaseRetryBackoffMs(100)).toBe(120_000);
  });
});
