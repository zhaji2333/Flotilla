import type { Pool } from 'pg';
import { getPool } from '../db';
import type { RequestFingerprintInput, RequestIndexEntry } from '@src-agent/contracts';

// ── Request dedupe index ────────────────────────────────────
// The controller records only hashes for requests observed in task traces. The
// plugin reads a bounded snapshot at claim time and warns the agent when it is
// about to repeat the same request. Responses are never cached here.

export async function listRecentRequestIndex(
  pool: Pool | undefined,
  missionId: string,
  limit = 100,
  ttlMinutes?: number,
): Promise<RequestIndexEntry[]> {
  const db = pool ?? getPool();
  const ttl = Math.max(1, Math.min(1_440, Math.floor(ttlMinutes ?? Number(process.env.REQUEST_DEDUPE_TTL_MINUTES || 30))));
  const result = await db.query(
    `SELECT method, normalized_url, url_hash, body_hash, auth_hash, status_code, task_id, traffic_ref, last_seen_at
     FROM mission_request_index
     WHERE mission_id = $1 AND last_seen_at > now() - ($2::int * interval '1 minute')
     ORDER BY last_seen_at DESC LIMIT $3`,
    [missionId, ttl, Math.max(1, Math.min(200, limit))],
  );
  return result.rows.map(row => ({
    method: String(row.method),
    normalizedUrl: String(row.normalized_url),
    urlHash: String(row.url_hash),
    bodyHash: String(row.body_hash),
    authHash: String(row.auth_hash),
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    taskId: String(row.task_id),
    trafficRef: row.traffic_ref ? String(row.traffic_ref) : null,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  }));
}

export async function upsertRequestIndex(
  pool: Pool | undefined,
  missionId: string,
  taskId: string,
  entries: readonly RequestFingerprintInput[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const db = pool ?? getPool();
  let changed = 0;
  for (const entry of entries.slice(0, 200)) {
    await db.query(
      `INSERT INTO mission_request_index
         (mission_id, task_id, method, normalized_url, url_hash, body_hash, auth_hash, status_code, traffic_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (mission_id, method, url_hash, body_hash, auth_hash)
       DO UPDATE SET
         last_seen_at = now(),
         hits = mission_request_index.hits + 1,
         status_code = COALESCE(EXCLUDED.status_code, mission_request_index.status_code),
         traffic_ref = COALESCE(EXCLUDED.traffic_ref, mission_request_index.traffic_ref)`,
      [
        missionId, taskId, entry.method, entry.normalizedUrl, entry.urlHash, entry.bodyHash,
        entry.authHash, entry.statusCode ?? null, entry.trafficRef ?? null,
      ],
    );
    changed += 1;
  }
  // Bounded retention: keep the newest 500 rows per mission.
  await db.query(
    `DELETE FROM mission_request_index WHERE mission_id = $1
       AND id NOT IN (SELECT id FROM mission_request_index WHERE mission_id = $1 ORDER BY last_seen_at DESC LIMIT 500)`,
    [missionId],
  );
  return changed;
}
