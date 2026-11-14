import { describe, expect, it } from 'vitest';
import { evaluateCoverageGate } from './coverage-gate.js';

describe('coverage completion gate', () => {
  it('is absent when not configured', () => {
    expect(evaluateCoverageGate(undefined, 3, 3, 1)).toBeNull();
    expect(evaluateCoverageGate({ enabled: false }, 0, 0, 0)).toBeNull();
  });

  it('requires every observed asset by default', () => {
    expect(evaluateCoverageGate({}, 3, 2, 1)?.passed).toBe(false);
    expect(evaluateCoverageGate({}, 3, 3, 0)?.passed).toBe(true);
  });

  it('fails a mission with no assets instead of silently completing', () => {
    const result = evaluateCoverageGate({}, 0, 0, 1);
    expect(result?.passed).toBe(false);
    expect(result?.failure).toBe('coverage_no_assets');
  });

  it('supports a partial ratio and an accepted-finding requirement', () => {
    expect(evaluateCoverageGate({ minRatio: 0.5 }, 4, 2, 0)?.passed).toBe(true);
    expect(evaluateCoverageGate({ minRatio: 0.5, requireAcceptedFinding: true }, 4, 4, 0)?.passed).toBe(false);
    expect(evaluateCoverageGate({ minRatio: 0.5, requireAcceptedFinding: true }, 4, 4, 1)?.passed).toBe(true);
  });
});
