-- ADR-0039 backfill: the dashboard and effect sweep should also show watchdog
-- activity recorded before watchdog_observations existed. Each historical
-- watchdog hint becomes one observation; the sweep evaluates it later (the
-- hint is older than the 10-minute window, so it resolves on the next tick).
INSERT INTO watchdog_observations (mission_id, task_id, rule, source, detail, action, stalled_streak, created_at)
SELECT h.mission_id,
       h.task_id,
       CASE WHEN h.source = 'watchdog:escalation' THEN 'no_progress'
            ELSE replace(h.source, 'watchdog:', '') END,
       'legacy',
       left(h.content, 1_000),
       CASE WHEN h.source = 'watchdog:escalation' THEN 'escalated' ELSE 'hint' END,
       0,
       h.created_at
  FROM task_hints h
 WHERE h.source LIKE 'watchdog:%'
   AND NOT EXISTS (
     SELECT 1 FROM watchdog_observations w
      WHERE w.mission_id = h.mission_id
        AND w.detail = left(h.content, 1_000)
   );
