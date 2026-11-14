import type { Pool, PoolClient } from 'pg';

// ── Dispatcher leader election ──────────────────────────────
// Every dispatcher replica can serve idempotent per-task writes (claim,
// heartbeat, finish, events) because the DB row locks/fencing token arbitrate
// them. Only the leader may run periodic scheduler/watchdog ticks; otherwise
// two replicas would promote/expire/watchdog the same rows concurrently.
//
// PostgreSQL advisory locks are connection-scoped: when the leader connection
// drops or the process exits, the lock is released and a standby acquires it
// on its next poll. No separate consensus service is needed for this deployment.

const LEADER_LOCK_KEY = 0x5a17_1e42; // stable int4 for src-agent dispatcher leader
const RETRY_MS = 2_000;

export class DispatcherLeader {
  private readonly pool: Pool;
  private client: PoolClient | null = null;
  private leader = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.retry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.release();
  }

  private retry(): void {
    if (this.stopped || this.leader) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tryAcquire();
    }, RETRY_MS);
    this.timer.unref?.();
  }

  private async tryAcquire(): Promise<void> {
    if (this.stopped || this.leader) return;
    try {
      const client = await this.pool.connect();
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LEADER_LOCK_KEY]);
      if (result.rows[0]?.locked === true) {
        this.client = client;
        this.leader = true;
        console.log('[dispatcher] acquired leader lock');
        client.on('error', error => {
          console.error(`[dispatcher] leader connection lost: ${String(error)}`);
          this.leader = false;
          this.client = null;
          try { client.release(); } catch { /* already released */ }
          this.retry();
        });
        return;
      }
      client.release();
    } catch (error) {
      console.error(`[dispatcher] leader election failed: ${String(error)}`);
    }
    this.retry();
  }

  private async release(): Promise<void> {
    this.leader = false;
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
    } catch {
      // session close releases the advisory lock anyway
    } finally {
      try { client.release(); } catch { /* already released */ }
    }
    console.log('[dispatcher] released leader lock');
  }
}
