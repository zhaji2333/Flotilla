import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// The schema and migrations live in @src-agent/contracts (the shared data
// contract). Services apply the idempotent baseline schema and then run the
// ordered, one-time migrations. Destructive cleanup must live in a migration,
// never in the re-runnable baseline.

const schemaPath = fileURLToPath(new URL('../../contracts/src/db/schema.sql', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../contracts/src/db/migrations', import.meta.url));

/** Serializes schema/migration application across API/worker/planner boots. */
const MIGRATION_LOCK_ID = 8_731_421;

export async function loadSchemaSql(): Promise<string> {
  return readFile(schemaPath, 'utf8');
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && /^\d+.*\.sql$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const files = await listMigrationFiles();
  if (files.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map(row => String(row.version)),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[schema] applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

export async function applySchema(pool: pg.Pool): Promise<void> {
  const sql = await loadSchemaSql();
  await pool.query(sql);
  await applyMigrations(pool);
}
