import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_ATTEMPTS,
  canTransition,
  isTerminalTaskState,
  stateAfterFailedReport,
  stateAfterLeaseExpiry,
} from './state-machine.js';

describe('task state machine', () => {
  it('walks the happy path proposed -> done', () => {
    expect(canTransition('proposed', 'ready')).toBe(true);
    expect(canTransition('ready', 'leased')).toBe(true);
    expect(canTransition('leased', 'running')).toBe(true);
    expect(canTransition('running', 'reported')).toBe(true);
    expect(canTransition('reported', 'verified')).toBe(true);
    expect(canTransition('verified', 'done')).toBe(true);
  });

  it('rejects skipping lifecycle steps', () => {
    expect(canTransition('proposed', 'running')).toBe(false);
    expect(canTransition('ready', 'reported')).toBe(false);
    expect(canTransition('done', 'ready')).toBe(false);
  });

  it('allows failure/lease/steering exits', () => {
    expect(canTransition('leased', 'handed_back')).toBe(true);
    expect(canTransition('running', 'retry_wait')).toBe(true);
    expect(canTransition('ready', 'stale')).toBe(true);
    expect(canTransition('blocked', 'ready')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
  });

  it('treats exhausted/cancelled/stale/handed_back as terminal', () => {
    for (const state of ['done', 'exhausted', 'cancelled', 'stale', 'handed_back', 'blocked'] as const) {
      if (state === 'blocked') continue;
      expect(isTerminalTaskState(state)).toBe(true);
    }
    expect(isTerminalTaskState('ready')).toBe(false);
    expect(isTerminalTaskState('reported')).toBe(false);
  });

  it('exhausts after the configured number of attempts', () => {
    expect(stateAfterLeaseExpiry(1)).toBe('retry_wait');
    expect(stateAfterLeaseExpiry(MAX_TASK_ATTEMPTS - 1)).toBe('retry_wait');
    expect(stateAfterLeaseExpiry(MAX_TASK_ATTEMPTS)).toBe('exhausted');
    expect(stateAfterFailedReport(1)).toBe('retry_wait');
    expect(stateAfterFailedReport(MAX_TASK_ATTEMPTS)).toBe('exhausted');
  });
});
