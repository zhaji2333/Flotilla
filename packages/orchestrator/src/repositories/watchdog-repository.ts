import type { Pool } from 'pg';
import { evaluateWatchdog } from '../scheduler/watchdog.js';
import { applyWatchdogObservation } from './watchdog-store.js';

// ── Watchdog tick (P1-γ, deterministic layer) ──────────────
// Runs every N worker ticks: duplicate target requests and stalled tasks produce trigger + hint rows. LLM judgement is a later layer.

export interface WatchdogTickResult {
  observations: number;
  hints: number;
}

export async function watchdogTick(pool: Pool): Promise<WatchdogTickResult> {
  const windowMinutes = Number(process.env.WATCHDOG_WINDOW_MINUTES || 10);
  const thresholds = {
    duplicateUrlCount: Number(process.env.WATCHDOG_DUPLICATE_THRESHOLD || 10),
    noProgressMinutes: Number(process.env.WATCHDOG_NO_PROGRESS_MINUTES || 15),
  };

  const duplicateUrls = await pool.query(
    `SELECT m.id AS mission_id, t.id AS task_id, pt.url, count(*)::int AS count
     FROM proxy_traffic pt
     JOIN missions m ON pt.url LIKE COALESCE(m.target->>'value', '') || '%' AND m.state IN ('pending','running','active')
     JOIN tasks t ON t.mission_id = m.id AND t.state IN ('leased','running')
     WHERE pt.observed_at > now() - ($1::int * interval '1 minute')
       AND pt.kind = 'target'
     GROUP BY m.id, t.id, pt.url
     HAVING count(*) >= $2
     LIMIT 10`,
    [windowMinutes, thresholds.duplicateUrlCount],
  );

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
     LIMIT 10`,
    [windowMinutes, thresholds.noProgressMinutes],
  );

  const observations = evaluateWatchdog({
    duplicateUrls: duplicateUrls.rows.map(row => ({
      missionId: String(row.mission_id),
      taskId: String(row.task_id),
      url: String(row.url),
      count: Number(row.count),
    })),
    stalledTasks: stalledTasks.rows.map(row => ({
      missionId: String(row.mission_id),
      taskId: String(row.task_id),
      runningMinutes: Number(row.running_minutes),
      hasRecentFinding: Boolean(row.has_recent_finding),
      hasRecentTrace: Boolean(row.has_recent_trace),
    })),
    thresholds,
  });

  let hints = 0;
  for (const observation of observations) {
    const result = await applyWatchdogObservation(pool, { ...observation, source: 'rules' });
    if (result.recorded) hints += 1;
  }
  return { observations: observations.length, hints };
}
