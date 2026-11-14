// ── P3-B6 worker storm guard ────────────────────────────────
// A single-key deployment has no key pool to rotate to. When the provider
// keeps failing (429/5xx) or the process keeps crashing, a tight claim->fail
// loop only burns quota and floods logs. This guard counts consecutive task
// failures and inserts a bounded exponential pause before the worker claims
// again; a success resets it. It never blocks forever and never kills tasks.

export interface StormGuardOptions {
  /** Consecutive failed task runs before the guard trips. */
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
}

export class StormGuard {
  private failures = 0;
  private readonly threshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(options: StormGuardOptions = {}) {
    this.threshold = Math.max(1, options.threshold ?? 4);
    this.baseMs = Math.max(1_000, options.baseMs ?? 5_000);
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? 60_000);
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  get tripped(): boolean {
    return this.failures >= this.threshold;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): number {
    this.failures += 1;
    return this.failures;
  }

  /** 0 while below the trip point, then bounded exponential backoff. */
  delayMs(): number {
    if (!this.tripped) return 0;
    const exponent = Math.min(this.failures - this.threshold, 5);
    return Math.min(this.maxMs, this.baseMs * 2 ** exponent);
  }
}
