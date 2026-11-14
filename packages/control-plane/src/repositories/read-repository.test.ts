import { describe, expect, it } from 'vitest';
import { buildMetricsSummary, type MetricsAggregates } from './read-repository';

function aggregates(overrides: Partial<MetricsAggregates> = {}): MetricsAggregates {
  return {
    generatedAt: '2026-11-07T00:00:00.000Z',
    missions: { total: 4, active: 1, completed: 2, failed: 1, avgSeconds: 600 },
    findings: {
      total: 10,
      accepted: 6,
      needsReview: 2,
      rejected: 2,
      merged: 1,
      validated: 5,
      artifacts: 4,
      acceptedEvidenceRefs: 15,
    },
    tasks: {
      total: 20,
      running: 1,
      stale: 1,
      stuck: 1,
      done: 12,
      failed: 3,
      exhausted: 1,
      handedBack: 2,
      attempted: 18,
      retried: 3,
    },
    evidence: { total: 40, target: 30, internet: 10 },
    timing: { avgTimeToFirstFactSeconds: 90 },
    cost: { totalTokens: 2_000_000 },
    ...overrides,
  };
}

const indicatorIds = [
  'validated_findings',
  'validation_rate',
  'review_rate',
  'false_positive_rate',
  'duplicate_intent_rate',
  'evidence_depth',
  'time_to_first_fact_seconds',
  'stuck_rate',
  'task_success_rate',
  'task_retry_rate',
  'handback_rate',
  'tokens_per_validated_finding',
];

describe('P3-A2 metric catalog', () => {
  it('always exposes the same 12 indicators', () => {
    const summary = buildMetricsSummary(aggregates());
    expect(summary.indicators).toHaveLength(12);
    expect(summary.indicators.map(item => item.id)).toEqual(indicatorIds);
    for (const indicator of summary.indicators) {
      expect(indicator.label.length).toBeGreaterThan(0);
      expect(indicator.definition.length).toBeGreaterThan(0);
    }
  });

  it('computes rates and counts from the aggregates', () => {
    const summary = buildMetricsSummary(aggregates());
    const byId = Object.fromEntries(summary.indicators.map(item => [item.id, item]));
    expect(byId.validated_findings?.value).toBe(5);
    expect(byId.validation_rate?.value).toBe(0.5);
    expect(byId.review_rate?.value).toBe(0.2);
    expect(byId.false_positive_rate?.value).toBe(0.25);
    expect(byId.duplicate_intent_rate?.value).toBe(1 / 7);
    expect(byId.evidence_depth?.value).toBe(2.5);
    expect(byId.stuck_rate?.value).toBe(0.05);
    expect(byId.task_success_rate?.value).toBe(12 / 16);
    expect(byId.task_retry_rate?.value).toBe(3 / 18);
    expect(byId.handback_rate?.value).toBe(2 / 18);
    expect(byId.tokens_per_validated_finding?.value).toBe(400_000);
    expect(byId.time_to_first_fact_seconds?.value).toBe(90);
    expect(summary.timing.avgMissionSeconds).toBe(600);
    expect(summary.cost.totalTokens).toBe(2_000_000);
  });

  it('returns N/A (null) when a denominator is empty instead of a fake zero', () => {
    const summary = buildMetricsSummary(aggregates({
      findings: { total: 0, accepted: 0, needsReview: 0, rejected: 0, merged: 0, validated: 0, artifacts: 0, acceptedEvidenceRefs: 0 },
      tasks: { total: 0, running: 0, stale: 0, stuck: 0, done: 0, failed: 0, exhausted: 0, handedBack: 0, attempted: 0, retried: 0 },
      evidence: { total: 0, target: 0, internet: 0 },
      timing: { avgTimeToFirstFactSeconds: null },
      cost: { totalTokens: 0 },
    }));
    for (const id of [
      'validation_rate',
      'review_rate',
      'false_positive_rate',
      'duplicate_intent_rate',
      'evidence_depth',
      'stuck_rate',
          'task_success_rate',
      'task_retry_rate',
      'handback_rate',
      'tokens_per_validated_finding',
    ]) {
      const indicator = summary.indicators.find(item => item.id === id);
      expect(indicator?.value, id).toBeNull();
    }
    expect(summary.indicators.find(item => item.id === 'time_to_first_fact_seconds')?.value).toBeNull();
    // Legacy v1 fields stay numeric so the existing console does not break.
    expect(summary.rates.validationRate).toBe(0);
    expect(summary.rates.stuckRate).toBe(0);
    expect(summary.timing.avgTimeToFirstFactSeconds).toBeNull();
  });

  it('keeps cancelled tasks out of the success-rate denominator', () => {
    const summary = buildMetricsSummary(aggregates({
      tasks: { total: 5, running: 0, stale: 0, stuck: 0, done: 2, failed: 1, exhausted: 1, handedBack: 0, attempted: 4, retried: 0 },
    }));
    expect(summary.indicators.find(item => item.id === 'task_success_rate')?.value).toBe(0.5);
  });
});
