import type { HarnessRunOutcome } from './runner.js';

// ── Transient failure classification ───────────────────────
// Ported from dsh-superagent's `transient()`: only network/rate-limit/provider
// failures are retried; anything else is a real task failure.

/** Total attempts for a transient failure (initial try + retries). */
export const TRANSIENT_TRIES = 3;
/** Base backoff before the next attempt; multiplied by the attempt number. */
export const TRANSIENT_BACKOFF_MS = 15_000;
/** Grace period after SIGTERM before SIGKILL (superagent KILL_WAIT_MS). */
export const KILL_WAIT_MS = 10_000;
/** Extra turns allowed for the settlement pass after hitting a limit. */
export const SETTLEMENT_MAX_TURNS = 10;
/** Wall clock for the settlement pass. */
export const SETTLEMENT_TIMEOUT_MS = 120_000;

const TRANSIENT_PATTERN = new RegExp(
  [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
    'UND_ERR', 'socket hang up', 'fetch failed', 'network error', 'overloaded',
    'rate limit', '\\b(?:408|429|50[0-4])\\b',
  ].join('|'),
  'i',
);

export function isTransientFailure(outcome: HarnessRunOutcome): boolean {
  if (outcome.completed) return false;
  // Timeouts and step limits are not provider failures; retrying blindly would
  // burn the same wall clock again without new information.
  if (outcome.failureClass === 'run_timeout' || outcome.failureClass === 'step_limit_exceeded') {
    return false;
  }
  // An isolated runtime child crash is an infrastructure failure: retry the
  // attempt instead of failing the task (bounded by TRANSIENT_TRIES).
  if (outcome.failureClass === 'runtime_crash') return true;
  const text = `${outcome.failureClass ?? ''} ${outcome.error ?? ''}`;
  return outcome.failureClass === 'model_error' || TRANSIENT_PATTERN.test(text) || outcome.failureClass === undefined;
}

export function retryBackoffMs(attempt: number): number {
  return TRANSIENT_BACKOFF_MS * Math.max(1, attempt);
}
