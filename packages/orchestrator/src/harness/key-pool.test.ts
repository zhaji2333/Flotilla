import { describe, expect, it } from 'vitest';
import { ModelKeyPool, loadModelKeyPool } from './key-pool.js';

describe('model key pool', () => {
  it('round-robins keys', () => {
    const pool = new ModelKeyPool({ keys: ['a', 'b', 'c'] });
    expect([pool.next(), pool.next(), pool.next(), pool.next()]).toEqual(['a', 'b', 'c', 'a']);
  });

  it('cools down a failed key and skips it', () => {
    let now = 1_000;
    const pool = new ModelKeyPool({ keys: ['a', 'b'], cooldownMs: 5_000, now: () => now });
    expect(pool.next()).toBe('a');
    pool.reportFailure('a');
    expect(pool.next()).toBe('b');
    now += 5_000;
    expect(pool.next()).toBe('a');
  });

  it('falls back to the earliest recovering key when all are cooling', () => {
    let now = 10_000;
    const pool = new ModelKeyPool({ keys: ['a', 'b'], cooldownMs: 5_000, now: () => now });
    pool.reportFailure('a');
    pool.reportFailure('b');
    expect(['a', 'b']).toContain(pool.next());
  });

  it('parses LLM_API_KEYS and falls back to LLM_API_KEY', () => {
    expect(loadModelKeyPool({ LLM_API_KEYS: 'a, b\nc' } as NodeJS.ProcessEnv).size).toBe(3);
    expect(loadModelKeyPool({ LLM_API_KEY: 'legacy' } as NodeJS.ProcessEnv).size).toBe(1);
  });
});
