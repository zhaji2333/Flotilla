import { describe, expect, it } from 'vitest';
import { buildDirectFindingHint, routeTrigger, shouldWarnDuplicateUrl, shouldWarnNoProgress, watchdogHint } from './triggers.js';
import { evaluateWatchdog, observationHint } from './watchdog.js';

describe('trigger routing policy', () => {
  it('routes judgement calls to the planner and observations directly', () => {
    expect(routeTrigger('worker_report')).toBe('planner');
    expect(routeTrigger('manual')).toBe('planner');
    expect(routeTrigger('finding')).toBe('direct');
    expect(routeTrigger('asset')).toBe('direct');
    expect(routeTrigger('watchdog')).toBe('direct');
  });

  it('builds scoped finding hints without new authorization', () => {
    const hint = buildDirectFindingHint({
      sourceTaskId: '11111111-1111-4111-8111-111111111111',
      findings: [{ title: 'IDOR on /api/users', artifact: 'FLAG{x}' }],
    });
    expect(hint).toContain('[trigger:finding]');
    expect(hint).toContain('IDOR on /api/users');
    expect(hint).toContain('never expand scope');
  });
});

describe('deterministic watchdog rules', () => {
  const thresholds = { duplicateUrlCount: 10, noProgressMinutes: 15 };

  it('fires only above thresholds', () => {
    expect(shouldWarnDuplicateUrl(9, thresholds)).toBe(false);
    expect(shouldWarnDuplicateUrl(10, thresholds)).toBe(true);
    expect(shouldWarnNoProgress(20, true, thresholds)).toBe(false);
    expect(shouldWarnNoProgress(20, false, thresholds)).toBe(true);
  });

  it('treats recent task trace activity as progress (long recon is not a stall)', () => {
    // ADR-0039: a task that keeps emitting tool/command traces is working even
    // before its first finding shows up.
    expect(shouldWarnNoProgress(20, false, thresholds, true)).toBe(false);
    expect(shouldWarnNoProgress(20, false, thresholds, false)).toBe(true);
    const observations = evaluateWatchdog({
      duplicateUrls: [],
      stalledTasks: [
        { missionId: 'm', taskId: 'quiet', runningMinutes: 30, hasRecentFinding: false, hasRecentTrace: false },
        { missionId: 'm', taskId: 'busy', runningMinutes: 30, hasRecentFinding: false, hasRecentTrace: true },
      ],
    });
    expect(observations.map(item => item.taskId)).toEqual(['quiet']);
  });

  it('evaluates observations with details and hint text', () => {
    const observations = evaluateWatchdog({
      duplicateUrls: [{ missionId: 'm', taskId: 't', url: 'http://target/api', count: 12 }],
      stalledTasks: [{ missionId: 'm', taskId: 't2', runningMinutes: 30, hasRecentFinding: false }],
    });
    expect(observations.map(item => item.rule)).toEqual(['duplicate_url', 'no_progress']);
    expect(observationHint(observations[0])).toContain('Do not bypass platform blocks');
    expect(watchdogHint('no_progress', 'stalled')).toContain('pivot');
  });
});
