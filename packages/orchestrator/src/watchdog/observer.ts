import type { Pool } from 'pg';
import { evaluateWatchdog, type WatchdogObservation } from '../scheduler/watchdog.js';

// ── External watchdog observation collector ─────────────────
// This process is deliberately separate from the dispatcher/worker loops. It
// only reads control-plane projections and emits bounded observations through
// the dispatcher write path; it never touches a target or runs a Worker.

export interface WatchdogCollectorConfig {
  windowMinutes: number;
  duplicateThreshold: number;
  noProgressMinutes: number;
  maxObservations: number;
}

export function watchdogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchdogCollectorConfig {
  return {
    windowMinutes: Math.max(1, Number(env.WATCHDOG_WINDOW_MINUTES || 10)),
    duplicateThreshold: Math.max(1, Number(env.WATCHDOG_DUPLICATE_THRESHOLD || 10)),
    noProgressMinutes: Math.max(1, Number(env.WATCHDOG_NO_PROGRESS_MINUTES || 15)),
    maxObservations: Math.max(1, Math.min(100, Number(env.WATCHDOG_MAX_OBSERVATIONS || 20))),
  };
}

/** Read-only collection of deterministic progress/direction signals. */
export async function collectWatchdogObservations(
  pool: Pool,
  config: WatchdogCollectorConfig = watchdogConfigFromEnv(),
): Promise<WatchdogObservation[]> {
  const duplicateUrls = await pool.query(
    `SELECT m.id AS mission_id, t.id AS task_id, pt.url, count(*)::int AS count
     FROM proxy_traffic pt
     JOIN missions m ON m.state IN ('pending','running','active')
       AND pt.url LIKE COALESCE(m.target->>'value', '') || '%'
     JOIN tasks t ON t.mission_id = m.id AND t.state IN ('leased','running')
     WHERE pt.observed_at > now() - ($1::int * interval '1 minute')
       AND pt.kind = 'target'
     GROUP BY m.id, t.id, pt.url
     HAVING count(*) >= $2
     ORDER BY count DESC
     LIMIT $3`,
    [config.windowMinutes, config.duplicateThreshold, config.maxObservations],
  );

  // A task with no recent finding is only "stalled" if its trace also stopped
  // producing events; a long-running model turn can legitimately have no
  // finding yet, but it still has tool/thinking trace rows.
  const stalledTasks = await pool.query(
    `SELECT t.mission_id, t.id AS task_id,
            EXTRACT(EPOCH FROM (now() - t.started_at)) / 60.0 AS running_minutes,
            EXISTS (
              SELECT 1 FROM findings f
              WHERE f.mission_id = t.mission_id AND f.created_at > now() - ($1::int * interval '1 minute')
            ) AS has_recent_finding,
            EXISTS (
              SELECT 1 FROM task_trace tr
              WHERE tr.task_id = t.id AND tr.created_at > now() - ($1::int * interval '1 minute')
            ) AS has_recent_trace
     FROM tasks t
     JOIN missions m ON m.id = t.mission_id
     WHERE t.state = 'running' AND t.started_at IS NOT NULL
       AND m.state IN ('pending','running','active')
       AND t.started_at < now() - ($2::int * interval '1 minute')
     LIMIT $3`,
    [config.windowMinutes, config.noProgressMinutes, config.maxObservations],
  );

  return evaluateWatchdog({
    duplicateUrls: duplicateUrls.rows.map(row => ({
      missionId: String(row.mission_id),
      taskId: String(row.task_id),
      url: String(row.url),
      count: Number(row.count),
    })),
    stalledTasks: stalledTasks.rows
      .map(row => ({
        missionId: String(row.mission_id),
        taskId: String(row.task_id),
        runningMinutes: Number(row.running_minutes),
        hasRecentFinding: Boolean(row.has_recent_finding),
        hasRecentTrace: Boolean(row.has_recent_trace),
      })),
    thresholds: {
      duplicateUrlCount: config.duplicateThreshold,
      noProgressMinutes: config.noProgressMinutes,
    },
  }).slice(0, config.maxObservations);
}
