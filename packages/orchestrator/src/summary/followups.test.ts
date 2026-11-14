import { describe, expect, it } from 'vitest';
import { MAX_FOLLOW_UPS, resolveFollowUpLimit, selectFollowUpGaps } from './followups.js';
import type { MissionGap } from '@src-agent/contracts';

function gap(confidence: MissionGap['confidence'], area = 'stage'): MissionGap {
  return { area, reason: 'reason', suggestedCheck: `check ${area}`, confidence };
}

describe('summary follow-up policy', () => {
  it('creates nothing by default', () => {
    expect(selectFollowUpGaps({ enabled: false, gaps: [gap('high')] })).toEqual([]);
  });

  it('never creates more than one follow-up task', () => {
    const gaps = [gap('high', 'a'), gap('high', 'b'), gap('high', 'c')];
    expect(selectFollowUpGaps({ enabled: true, maxFollowUps: 3, gaps })).toHaveLength(1);
    expect(selectFollowUpGaps({ enabled: true, maxFollowUps: 1, gaps })).toHaveLength(1);
    expect(MAX_FOLLOW_UPS).toBe(1);
  });

  it('honours an explicit zero cap and clamps bad values', () => {
    expect(resolveFollowUpLimit(0)).toBe(0);
    expect(resolveFollowUpLimit(-5)).toBe(0);
    expect(resolveFollowUpLimit(99)).toBe(1);
    expect(resolveFollowUpLimit(Number.NaN)).toBe(1);
    expect(selectFollowUpGaps({ enabled: true, maxFollowUps: 0, gaps: [gap('high')] })).toEqual([]);
  });

  it('report-only when the objective is already achieved', () => {
    expect(selectFollowUpGaps({ enabled: true, objectiveAchieved: true, gaps: [gap('high')] })).toEqual([]);
  });

  it('skips low-confidence gaps', () => {
    expect(selectFollowUpGaps({ enabled: true, gaps: [gap('low'), gap('medium')] })).toHaveLength(1);
    expect(selectFollowUpGaps({ enabled: true, gaps: [gap('low'), gap('low')] })).toEqual([]);
  });
});
