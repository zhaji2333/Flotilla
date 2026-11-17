import { describe, expect, it } from 'vitest';
import { buildCoverageRepairObjective, needsCoverageRepair, pendingCoverage } from './coverage.js';

const pending = {
  targetRef: 'target:https://app.example.com',
  attackSurface: 'web',
  status: 'pending' as const,
  evidenceRef: null,
  disposition: null,
};

describe('planner coverage invariant', () => {
  it('repairs a plan that creates nothing while covering nothing', () => {
    expect(needsCoverageRepair([pending], 0)).toBe(true);
    expect(needsCoverageRepair([pending], 1)).toBe(false);
    expect(needsCoverageRepair([{ ...pending, status: 'covered' }], 0)).toBe(false);
  });

  it('keeps the repair objective generic (no benchmark names)', () => {
    const objective = buildCoverageRepairObjective(pending);
    expect(objective).toContain('target:https://app.example.com');
    expect(objective).toContain('web');
    expect(objective).not.toMatch(/challenge|题目|flag/i);
  });

  it('only returns pending requirements', () => {
    expect(pendingCoverage([pending, { ...pending, status: 'covered' }])).toEqual([pending]);
  });
});
