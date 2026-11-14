import { Pool } from 'pg';

// ── Web database access ─────────────────────────────────────
// The console is a read-mostly projection consumer: pages and API routes read
// from PostgreSQL; mission creation writes a grant + mission + task atomically.

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const host = process.env.PG_HOST;
    const database = process.env.PG_DB;
    const user = process.env.PG_USER;
    if (!host || !database || !user) {
      throw new Error('PG_HOST, PG_DB and PG_USER are required');
    }
    pool = new Pool({
      host,
      port: Number(process.env.PG_PORT || 5432),
      database,
      user,
      password: process.env.PG_PASSWORD ?? '',
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'src-agent-api',
    });
  }
  return pool;
}
