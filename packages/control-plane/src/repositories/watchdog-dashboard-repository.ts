import { getPool } from '../db';

// ── Watchdog dashboard (ADR-0039) ───────────────────────────
// Read-only aggregation over watchdog_observations / watchdog_task_state so the
// console can answer "what did the watchdog actually do, and did it help?".

export interface WatchdogObservationRow {
  id: string;
  missionId: string;
  missionName: string | null;
  taskId: string | null;
  rule: string;
  source: string;
  action: string;
  stalledStreak: number;
  detail: string;
  outcome: 'pending' | 'progress' | 'no_progress';
  outcomeDetail: Record<string, unknown>;
  approvalId: string | null;
  createdAt: string;
  outcomeCheckedAt: string | null;
}

export interface WatchdogDashboard {
  windowDays: number;
  summary: {
    observations: number;
    hints: number;
    deduped: number;
    escalations: number;
    pendingOutcomes: number;
    checkedOutcomes: number;
    progressOutcomes: number;
    noProgressOutcomes: number;
    /** progress / checked, null while nothing has been swept yet. */
    hitRate: number | null;
    byRule: Array<{ rule: string; count: number; escalations: number }>;
    byDay: Array<{ date: string; observations: number; escalations: number; progress: number; noProgress: number }>;
  };
  recent: WatchdogObservationRow[];
  escalations: WatchdogObservationRow[];
  streaks: Array<{
    taskId: string;
    missionId: string;
    missionName: string | null;
    stalledStreak: number;
    escalatedStreak: number;
    lastRule: string | null;
    lastDetail: string | null;
    lastObservedAt: string;
  }>;
}

function mapRow(row: Record<string, unknown>): WatchdogObservationRow {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    missionName: row.mission_name ? String(row.mission_name) : null,
    taskId: row.task_id ? String(row.task_id) : null,
    rule: String(row.rule),
    source: String(row.source),
    action: String(row.action),
    stalledStreak: Number(row.stalled_streak ?? 0),
    detail: String(row.detail),
    outcome: String(row.outcome) as WatchdogObservationRow['outcome'],
    outcomeDetail: (row.outcome_detail ?? {}) as Record<string, unknown>,
    approvalId: row.approval_id ? String(row.approval_id) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    outcomeCheckedAt: row.outcome_checked_at ? new Date(row.outcome_checked_at as string).toISOString() : null,
  };
}

export async function getWatchdogDashboard(days = 7, limit = 50): Promise<WatchdogDashboard> {
  const pool = getPool();
  const windowDays = Math.max(1, Math.min(90, Math.trunc(days)));
  const rowLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const since = `${windowDays} days`;

  const totals = await pool.query(
    `SELECT count(*)::int AS observations,
            count(*) FILTER (WHERE action IN ('hint','escalated'))::int AS hints,
            count(*) FILTER (WHERE action = 'deduped')::int AS deduped,
            count(*) FILTER (WHERE action = 'escalated')::int AS escalations,
            count(*) FILTER (WHERE outcome = 'pending')::int AS pending_outcomes,
            count(*) FILTER (WHERE outcome <> 'pending')::int AS checked_outcomes,
            count(*) FILTER (WHERE outcome = 'progress')::int AS progress_outcomes,
            count(*) FILTER (WHERE outcome = 'no_progress')::int AS no_progress_outcomes
       FROM watchdog_observations
      WHERE created_at > now() - ($1::text)::interval`,
    [since],
  );
  const t = totals.rows[0] ?? {};
  const checked = Number(t.checked_outcomes ?? 0);
  const progressOutcomes = Number(t.progress_outcomes ?? 0);

  const byRule = await pool.query(
    `SELECT rule, count(*)::int AS count,
            count(*) FILTER (WHERE action = 'escalated')::int AS escalations
       FROM watchdog_observations
      WHERE created_at > now() - ($1::text)::interval
      GROUP BY rule ORDER BY count DESC`,
    [since],
  );

  const byDay = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            count(*)::int AS observations,
            count(*) FILTER (WHERE action = 'escalated')::int AS escalations,
            count(*) FILTER (WHERE outcome = 'progress')::int AS progress,
            count(*) FILTER (WHERE outcome = 'no_progress')::int AS no_progress
       FROM watchdog_observations
      WHERE created_at > now() - ($1::text)::interval
      GROUP BY 1 ORDER BY 1`,
    [since],
  );

  const selectRows = `
    SELECT w.id, w.mission_id, m.name AS mission_name, w.task_id, w.rule, w.source, w.action,
           w.stalled_streak, w.detail, w.outcome, w.outcome_detail, w.approval_id,
           w.created_at, w.outcome_checked_at
      FROM watchdog_observations w
      LEFT JOIN missions m ON m.id = w.mission_id
     WHERE w.created_at > now() - ($1::text)::interval
       AND ($2::text IS NULL OR w.action = $2::text)
     ORDER BY w.created_at DESC
     LIMIT $3`;

  const recent = await pool.query(selectRows, [since, null, rowLimit]);
  const escalations = await pool.query(selectRows, [since, 'escalated', rowLimit]);

  const streaks = await pool.query(
    `SELECT s.task_id, s.mission_id, m.name AS mission_name, s.stalled_streak, s.escalated_streak,
            s.last_rule, s.last_detail, s.last_observed_at
       FROM watchdog_task_state s
       LEFT JOIN missions m ON m.id = s.mission_id
       JOIN tasks t ON t.id = s.task_id
      WHERE s.stalled_streak > 0
        AND t.state IN ('proposed','ready','leased','running','retry_wait','blocked')
      ORDER BY s.stalled_streak DESC, s.last_observed_at DESC
      LIMIT 20`,
  );

  return {
    windowDays,
    summary: {
      observations: Number(t.observations ?? 0),
      hints: Number(t.hints ?? 0),
      deduped: Number(t.deduped ?? 0),
      escalations: Number(t.escalations ?? 0),
      pendingOutcomes: Number(t.pending_outcomes ?? 0),
      checkedOutcomes: checked,
      progressOutcomes,
      noProgressOutcomes: Number(t.no_progress_outcomes ?? 0),
      hitRate: checked > 0 ? progressOutcomes / checked : null,
      byRule: byRule.rows.map(row => ({ rule: String(row.rule), count: Number(row.count), escalations: Number(row.escalations) })),
      byDay: byDay.rows.map(row => ({
        date: String(row.date),
        observations: Number(row.observations),
        escalations: Number(row.escalations),
        progress: Number(row.progress),
        noProgress: Number(row.no_progress),
      })),
    },
    recent: recent.rows.map(mapRow),
    escalations: escalations.rows.map(mapRow),
    streaks: streaks.rows.map(row => ({
      taskId: String(row.task_id),
      missionId: String(row.mission_id),
      missionName: row.mission_name ? String(row.mission_name) : null,
      stalledStreak: Number(row.stalled_streak ?? 0),
      escalatedStreak: Number(row.escalated_streak ?? 0),
      lastRule: row.last_rule ? String(row.last_rule) : null,
      lastDetail: row.last_detail ? String(row.last_detail) : null,
      lastObservedAt: new Date(row.last_observed_at as string).toISOString(),
    })),
  };
}
