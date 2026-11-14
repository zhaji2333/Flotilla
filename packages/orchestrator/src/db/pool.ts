import { readFileSync, unlinkSync } from 'node:fs';
import { Pool } from 'pg';

// ── PostgreSQL pool ─────────────────────────────────────────
// All database access in the orchestrator goes through this module; the worker
// never talks to PostgreSQL through ad-hoc clients.

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const host = env.PG_HOST?.trim();
  const database = env.PG_DB?.trim();
  const user = env.PG_USER?.trim();
  let password = env.PG_PASSWORD ?? '';
  if (!password && env.PG_PASSWORD_FILE) {
    // The entrypoint keeps the password out of /proc/1/environ; the controller
    // reads it once, then unlinks the file before spawning any agent.
    try {
      password = readFileSync(env.PG_PASSWORD_FILE, 'utf8').trim();
      unlinkSync(env.PG_PASSWORD_FILE);
    } catch {
      // Preserve the original connectivity error path.
    }
  }
  if (!host || !database || !user) {
    throw new Error('PG_HOST, PG_DB and PG_USER are required');
  }
  return {
    host,
    port: Number(env.PG_PORT || 5432),
    database,
    user,
    password,
  };
}

export function createPool(config?: DatabaseConfig): Pool {
  const resolved = config ?? databaseConfigFromEnv();
  return new Pool({
    ...resolved,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'src-agent-worker',
  });
}

export async function waitForDatabase(pool: Pool, attempts = 40, delayMs = 1_000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`database not reachable: ${String(lastError)}`);
}
