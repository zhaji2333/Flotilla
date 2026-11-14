import type { Pool } from 'pg';
import { getPool } from '../db';

export interface ArtifactRow {
  id: string;
  missionId: string;
  taskId: string | null;
  sha256: string;
  size: number;
  filename: string;
  contentType: string;
  storagePath: string;
  createdBy: string;
  createdAt: string;
}

function mapRow(row: Record<string, unknown>): ArtifactRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    taskId: row.task_id ? String(row.task_id) : null,
    sha256: String(row.sha256),
    size: Number(row.size),
    filename: String(row.filename),
    contentType: String(row.content_type),
    storagePath: String(row.storage_path),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function createArtifact(pool: Pool | undefined, input: {
  missionId: string;
  taskId?: string | null;
  sha256: string;
  size: number;
  filename: string;
  contentType: string;
  storagePath: string;
  createdBy: string;
}): Promise<ArtifactRow> {
  const db = pool ?? getPool();
  const inserted = await db.query(
    `INSERT INTO artifacts (mission_id, task_id, sha256, size, filename, content_type, storage_path, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (mission_id, sha256) DO NOTHING
     RETURNING *`,
    [input.missionId, input.taskId ?? null, input.sha256, input.size, input.filename, input.contentType, input.storagePath, input.createdBy],
  );
  if ((inserted.rowCount ?? 0) > 0) return mapRow(inserted.rows[0]!);
  const existing = await db.query(`SELECT * FROM artifacts WHERE mission_id=$1 AND sha256=$2`, [input.missionId, input.sha256]);
  if ((existing.rowCount ?? 0) === 0) throw new Error('artifact insert conflicted but no row found');
  return mapRow(existing.rows[0]!);
}

export async function listArtifacts(pool: Pool | undefined, missionId: string): Promise<ArtifactRow[]> {
  const db = pool ?? getPool();
  const result = await db.query(
    `SELECT * FROM artifacts WHERE mission_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [missionId],
  );
  return result.rows.map(mapRow);
}

export async function getArtifact(pool: Pool | undefined, artifactId: string): Promise<ArtifactRow | null> {
  const db = pool ?? getPool();
  const result = await db.query(`SELECT * FROM artifacts WHERE id=$1`, [artifactId]);
  return (result.rowCount ?? 0) > 0 ? mapRow(result.rows[0]!) : null;
}
