import type { CoverageRequirement } from '@src-agent/contracts';

// ── Planner coverage invariant (v1.0.2, ADR-0054) ──────────
// Every authorized target/attack surface must end with a task, finding,
// negative result or explicit disposition. These helpers are pure so the
// invariant can be unit-tested without a database.

export function pendingCoverage(requirements: readonly CoverageRequirement[]): CoverageRequirement[] {
  return requirements.filter(requirement => requirement.status === 'pending');
}

export function buildCoverageRepairObjective(requirement: CoverageRequirement): string {
  return `Coverage repair: assess the authorized ${requirement.attackSurface} surface for ${requirement.targetRef}. ` +
    'Record at least one negative result or evidence-backed finding; if the surface is unreachable or out of scope, report that explicitly.';
}

/** A plan with no creates cannot close a mission that still has uncovered surfaces. */
export function needsCoverageRepair(
  requirements: readonly CoverageRequirement[],
  plannedCreates: number,
): boolean {
  return plannedCreates === 0 && pendingCoverage(requirements).length > 0;
}
