import { type TaskState, TERMINAL_TASK_STATES } from '@src-agent/contracts';

// ── Task state machine (P1) ─────────────────────────────────
// The task lifecycle is a deterministic state machine. Only the scheduler and
// the worker (through the repository) may move a task, and every transition is
// validated here instead of being implicit in SQL.

export const MAX_TASK_ATTEMPTS = 3;

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  proposed: ['ready', 'blocked', 'cancelled'],
  ready: ['leased', 'stale', 'cancelled'],
  leased: ['running', 'retry_wait', 'stale', 'handed_back', 'cancelled'],
  running: ['reported', 'retry_wait', 'stale', 'handed_back', 'cancelled'],
  reported: ['verified', 'retry_wait', 'exhausted'],
  verified: ['done'],
  done: [],
  retry_wait: ['ready', 'exhausted', 'cancelled'],
  exhausted: [],
  blocked: ['ready', 'cancelled'],
  cancelled: [],
  stale: [],
  handed_back: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition ${from} -> ${to}`);
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** State after a lease expires; exhausted once attempts are used up. */
export function stateAfterLeaseExpiry(attempt: number): 'retry_wait' | 'exhausted' {
  return attempt >= MAX_TASK_ATTEMPTS ? 'exhausted' : 'retry_wait';
}

/** State after a worker reports a failed run. */
export function stateAfterFailedReport(attempt: number): 'retry_wait' | 'exhausted' {
  return attempt >= MAX_TASK_ATTEMPTS ? 'exhausted' : 'retry_wait';
}
