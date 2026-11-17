import type { MissionPhase } from '@src-agent/contracts';

// ── Mission phase gate (v1.0.2, ADR-0054) ──────────────────
// Once a mission enters reporting (deadline - lead) it stops accepting new
// attack/validation work; after the deadline it is hard-stopped (closed).
// Existing report/evidence tasks and the automatic summary remain allowed.

const ATTACK_TASK_TYPES = new Set(['bootstrap', 'explore', 'reason', 'intent']);

export function isAttackTaskType(type: string): boolean {
  return ATTACK_TASK_TYPES.has(type);
}

/** True when the scheduler must not promote this task in the mission phase. */
export function isTaskBlockedByPhase(phase: MissionPhase | string | null | undefined, type: string): boolean {
  const effective = (phase ?? 'active') as MissionPhase;
  if (effective === 'active') return false;
  // summary/report tasks stay allowed in reporting so the mission can close
  // with an auditable report, but every attack task is frozen.
  return isAttackTaskType(type);
}

/** True when a planner plan may not create any new task in this phase. */
export function isPlanCreateBlockedByPhase(
  phase: MissionPhase | string | null | undefined,
  actions: ReadonlyArray<{ type: string }>,
): boolean {
  const effective = (phase ?? 'active') as MissionPhase;
  if (effective === 'active') return false;
  return actions.some(action => action.type === 'create_task');
}

/** Disposition to apply when a frozen task is cancelled by the phase gate. */
export function phaseCancelDisposition(phase: MissionPhase | string | null | undefined): 'cancelled' | 'timeout' {
  return (phase ?? 'active') === 'closed' ? 'timeout' : 'cancelled';
}
