import {
  DEFAULT_WATCHDOG_THRESHOLDS,
  shouldWarnDuplicateUrl,
  shouldWarnNoProgress,
  watchdogHint,
  type WatchdogThresholds,
} from './triggers.js';

// ── Rule watchdog (P1-γ) ────────────────────────────────────
// Deterministic checks only: duplicate requests and running tasks without new
// findings. Each hit becomes a trigger + direct hint. An LLM
// watchdog (summaries/quality judgement) is P2 and will consume the same rows.

export interface WatchdogObservation {
  rule: 'duplicate_url' | 'no_progress' | 'direction_drift';
  missionId: string;
  taskId?: string;
  detail: string;
}

export function evaluateWatchdog(input: {
  duplicateUrls: Array<{ missionId: string; taskId?: string; url: string; count: number }>;
  stalledTasks: Array<{ missionId: string; taskId: string; runningMinutes: number; hasRecentFinding: boolean; hasRecentTrace?: boolean }>;
  thresholds?: Partial<WatchdogThresholds>;
}): WatchdogObservation[] {
  const thresholds: WatchdogThresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...input.thresholds };
  const observations: WatchdogObservation[] = [];
  for (const row of input.duplicateUrls) {
    if (!shouldWarnDuplicateUrl(row.count, thresholds)) continue;
    observations.push({
      rule: 'duplicate_url',
      missionId: row.missionId,
      taskId: row.taskId,
      detail: `Repeated ${row.count} requests to ${row.url.slice(0, 120)} in the last window.`,
    });
  }
  for (const row of input.stalledTasks) {
    if (!shouldWarnNoProgress(row.runningMinutes, row.hasRecentFinding, thresholds, row.hasRecentTrace === true)) continue;
    observations.push({
      rule: 'no_progress',
      missionId: row.missionId,
      taskId: row.taskId,
      detail: `Task has been running for ${Math.round(row.runningMinutes)} minutes without new findings.`,
    });
  }
  return observations;
}

export function observationHint(observation: WatchdogObservation): string {
  return watchdogHint(observation.rule, observation.detail);
}
