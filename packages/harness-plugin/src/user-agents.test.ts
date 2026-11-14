import { describe, expect, it } from 'vitest';
import { resolveUserAgent, randomUserAgent, USER_AGENTS } from './user-agents.js';

describe('random user agents', () => {
  it('returns a browser-like UA and never repeats consecutively', () => {
    const sequence = [0, 0, 0.99, 0.5].map(value => randomUserAgent(() => value));
    for (const agent of sequence) expect(USER_AGENTS).toContain(agent);
    expect(sequence[0]).not.toBe(sequence[1]);
  });

  it('honours fixed mode for deterministic tests', () => {
    expect(resolveUserAgent({ SRC_AGENT_UA_MODE: 'fixed', SRC_AGENT_UA_FIXED: 'pinned/1.0' })).toBe('pinned/1.0');
    expect(USER_AGENTS).toContain(resolveUserAgent({}));
  });
});
