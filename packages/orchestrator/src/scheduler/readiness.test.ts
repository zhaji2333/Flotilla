import { describe, expect, it } from 'vitest';
import { evaluateReadiness } from './readiness.js';
import { MAX_TASK_ATTEMPTS } from './state-machine.js';

const base = {
  missionState: 'running',
  dependsOn: [] as string[],
  dependencyStates: {} as Record<string, 'done' | 'exhausted' | 'running'>,
  fingerprintConflict: false,
  attempt: 1,
  budgetExhausted: false,
} as const;

describe('task readiness', () => {
  it('promotes a dependency-free task to ready', () => {
    expect(evaluateReadiness({ ...base, dependencyStates: {} }).state).toBe('ready');
  });

  it('keeps waiting while dependencies are incomplete', () => {
    const verdict = evaluateReadiness({
      ...base,
      dependsOn: ['a'],
      dependencyStates: { a: 'running' },
    });
    expect(verdict.state).toBe('proposed');
    expect(verdict.reason).toContain('waiting');
  });

  it('promotes once every dependency is done', () => {
    const verdict = evaluateReadiness({
      ...base,
      dependsOn: ['a', 'b'],
      dependencyStates: { a: 'done', b: 'done' },
    });
    expect(verdict.state).toBe('ready');
  });

  it('blocks on a failed dependency', () => {
    const verdict = evaluateReadiness({
      ...base,
      dependsOn: ['a'],
      dependencyStates: { a: 'exhausted' },
    });
    expect(verdict.state).toBe('blocked');
    expect(verdict.reason).toContain('failed dependency');
  });

  it('blocks when a declared dependency row is missing', () => {
    const verdict = evaluateReadiness({ ...base, dependsOn: ['ghost'], dependencyStates: {} });
    expect(verdict.state).toBe('blocked');
  });

  it('marks duplicate fingerprint tasks stale', () => {
    expect(evaluateReadiness({ ...base, fingerprintConflict: true }).state).toBe('stale');
  });

  it('does not dispatch when the mission is paused or cancelled', () => {
    expect(evaluateReadiness({ ...base, missionState: 'paused' }).state).toBe('proposed');
    expect(evaluateReadiness({ ...base, missionState: 'cancelled' }).state).toBe('cancelled');
    expect(evaluateReadiness({ ...base, missionState: 'completed' }).state).toBe('proposed');
  });

  it('exhausts attempts and exhausted budgets', () => {
    expect(evaluateReadiness({ ...base, attempt: MAX_TASK_ATTEMPTS }).state).toBe('exhausted');
    expect(evaluateReadiness({ ...base, budgetExhausted: true }).state).toBe('exhausted');
  });
});
