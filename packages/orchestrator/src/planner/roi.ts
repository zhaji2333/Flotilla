// ── Planner ROI ordering (v1.0.2, ADR-0054) ─────────────────
// Ordering only uses generic mission features; benchmark/challenge identifiers
// are never inputs. The reserved slot keeps a high-cost/high-value surface from
// being starved by many cheap tasks.

export interface RoiFeatures {
  /** 0..1: how important the authorized target is (operator priority). */
  targetCriticality: number;
  /** Pending coverage requirements for this target (0 = fully covered). */
  coverageGap: number;
  /** Previous attempts on the same fingerprint. */
  priorAttempts: number;
  /** Expected findings from this task (bounded heuristic, 0..1). */
  expectedFindings: number;
  /** Whether the task needs an expensive capability (browser/reverse/IDA). */
  expensiveTools: number;
  /** Remaining mission budget in milliseconds. */
  remainingBudgetMs: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Higher is better. Deterministic and independent of challenge identifiers. */
export function computePlannerPriority(features: RoiFeatures): number {
  const budgetFactor = clamp01(features.remainingBudgetMs / 1_200_000);
  const score =
    0.35 * clamp01(features.targetCriticality) +
    0.30 * (features.coverageGap > 0 ? 1 : 0) +
    0.15 * clamp01(features.expectedFindings) -
    0.10 * clamp01(features.priorAttempts / 3) -
    0.05 * clamp01(features.expensiveTools) +
    0.05 * budgetFactor;
  return Number(clamp01(0.35 + score).toFixed(3));
}

/** True when at least one slot must be kept for a pending coverage surface. */
export function shouldReserveCoverageSlot(pendingCoverage: number, openSlots: number): boolean {
  return pendingCoverage > 0 && openSlots > 0;
}

/** True when the task should get the reserved (high-priority) slot. */
export function isReservedCoverageTask(features: RoiFeatures): boolean {
  return features.coverageGap > 0 && features.targetCriticality >= 0.5;
}
