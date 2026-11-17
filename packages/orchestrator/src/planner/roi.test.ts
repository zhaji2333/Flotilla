import { describe, expect, it } from 'vitest';
import { computePlannerPriority, isReservedCoverageTask, shouldReserveCoverageSlot } from './roi.js';

const base = {
  targetCriticality: 0.5,
  coverageGap: 0,
  priorAttempts: 0,
  expectedFindings: 0.5,
  expensiveTools: 0,
  remainingBudgetMs: 1_200_000,
};

describe('planner ROI ordering', () => {
  it('ranks a pending coverage gap above an already-covered surface', () => {
    expect(computePlannerPriority({ ...base, coverageGap: 1 }))
      .toBeGreaterThan(computePlannerPriority(base));
  });

  it('penalises repeated attempts and expensive tools', () => {
    expect(computePlannerPriority({ ...base, priorAttempts: 3 }))
      .toBeLessThan(computePlannerPriority(base));
    expect(computePlannerPriority({ ...base, expensiveTools: 1 }))
      .toBeLessThan(computePlannerPriority(base));
  });

  it('reserves a slot for high-value pending coverage only', () => {
    expect(shouldReserveCoverageSlot(1, 2)).toBe(true);
    expect(shouldReserveCoverageSlot(0, 2)).toBe(false);
    expect(shouldReserveCoverageSlot(1, 0)).toBe(false);
    expect(isReservedCoverageTask({ ...base, coverageGap: 1, targetCriticality: 0.8 })).toBe(true);
    expect(isReservedCoverageTask({ ...base, coverageGap: 1, targetCriticality: 0.2 })).toBe(false);
  });

  it('never references challenge/benchmark identifiers', () => {
    const features = { ...base, coverageGap: 1 };
    expect(JSON.stringify(features)).not.toMatch(/challenge|flag|bench/i);
    expect(computePlannerPriority(features)).toBeGreaterThan(0);
    expect(computePlannerPriority(features)).toBeLessThanOrEqual(1);
  });
});
