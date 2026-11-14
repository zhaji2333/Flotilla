-- A mission has one bounded summary review. Retries used to insert duplicates
-- before the task result was marked done; keep the newest and enforce one row.
BEGIN;

DELETE FROM mission_summaries
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY mission_id ORDER BY created_at DESC, id DESC) AS rn
    FROM mission_summaries
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mission_summaries_mission ON mission_summaries(mission_id);

COMMIT;
