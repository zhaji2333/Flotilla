import type { TaskState } from '@src-agent/contracts';
import { MAX_TASK_ATTEMPTS } from './state-machine.js';

// ── Task readiness ──────────────────────────────────────────
// proposed → ready only when the mission accepts work, all dependencies are
// done, no open duplicate fingerprint exists and budget remains. Everything
// else stays proposed or becomes blocked/stale with a machine-readable reason.

export interface ReadinessInput {
  missionState: string;
  dependsOn: string[];
  dependencyStates: Record<string, TaskState>;
  fingerprintConflict: boolean;
  attempt: number;
  budgetExhausted?: boolean;
}

export interface ReadinessVerdict {
  state: TaskState;
  reason: string;
}

const ACTIVE_MISSION_STATES = new Set(['pending', 'running', 'active']);
const FAILED_DEPENDENCY_STATES = new Set<TaskState>(['exhausted', 'cancelled', 'stale', 'handed_back', 'blocked']);

export function evaluateReadiness(input: ReadinessInput): ReadinessVerdict {
  if (!ACTIVE_MISSION_STATES.has(input.missionState)) {
    if (input.missionState === 'cancelled') return { state: 'cancelled', reason: 'mission cancelled' };
    return { state: 'proposed', reason: `mission ${input.missionState}` };
  }
  if (input.budgetExhausted) {
    return { state: 'exhausted', reason: 'budget exhausted' };
  }
  if (input.fingerprintConflict) {
    return { state: 'stale', reason: 'duplicate open task with same fingerprint' };
  }

  const missing = input.dependsOn.filter(dependency => !input.dependencyStates[dependency]);
  if (missing.length > 0) {
    return { state: 'blocked', reason: `missing dependency rows: ${missing.join(', ')}` };
  }
  const failed = input.dependsOn.filter(dependency =>
    FAILED_DEPENDENCY_STATES.has(input.dependencyStates[dependency]),
  );
  if (failed.length > 0) {
    return { state: 'blocked', reason: `failed dependency: ${failed.join(', ')}` };
  }
  const pending = input.dependsOn.filter(dependency => input.dependencyStates[dependency] !== 'done');
  if (pending.length > 0) {
    return { state: 'proposed', reason: `waiting on dependencies: ${pending.join(', ')}` };
  }
  if (input.attempt >= MAX_TASK_ATTEMPTS) {
    return { state: 'exhausted', reason: 'attempt limit reached' };
  }
  return { state: 'ready', reason: 'all dependencies satisfied' };
}
