import type { MissionGap } from '@src-agent/contracts';

// ── Summary follow-up (补漏) policy ─────────────────────────
// A summary task produces a report first; gap-filling tasks are an explicit,
// opt-in side effect. Historically every summary spawned up to three `intent`
// tasks, which kept a finished mission running long after the objective was
// met. The policy is deliberately small and pure so the rules are testable and
// cannot drift between call sites.

export const MAX_FOLLOW_UPS = 1;

export interface FollowUpPolicyInput {
  /** Operator opt-in (`worker.summaryFollowUpEnabled`). Default off. */
  enabled: boolean;
  /** Configured cap; clamped to [0, MAX_FOLLOW_UPS]. */
  maxFollowUps?: number;
  /**
   * The summary reviewer reported that the mission objective is already met
   * (for example all expected flags are accepted). Report only.
   */
  objectiveAchieved?: boolean;
  gaps: readonly MissionGap[];
}

/** Number of gap-filling tasks the configured cap allows (0 or 1). */
export function resolveFollowUpLimit(maxFollowUps?: number): number {
  const value = Number.isFinite(maxFollowUps) ? Math.trunc(maxFollowUps as number) : MAX_FOLLOW_UPS;
  return Math.max(0, Math.min(MAX_FOLLOW_UPS, value));
}

/**
 * Chooses the gaps that become follow-up tasks. Low-confidence gaps never
 * spawn work, an achieved objective suppresses all follow-ups, and the list is
 * capped so one summary can add at most one task.
 */
export function selectFollowUpGaps(input: FollowUpPolicyInput): MissionGap[] {
  if (!input.enabled || input.objectiveAchieved === true) return [];
  const limit = resolveFollowUpLimit(input.maxFollowUps);
  if (limit === 0) return [];
  return input.gaps
    .filter(gap => gap.confidence !== 'low')
    .slice(0, limit);
}
