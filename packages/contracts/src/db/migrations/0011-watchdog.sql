-- ADR-0039: watchdog escalation, trace-aware progress and hint effect capture.
-- Every observation is auditable; escalation state is per task so a repeated
-- stall can trigger exactly one planner signal + human approval per streak.

CREATE TABLE IF NOT EXISTS watchdog_observations (
  id                 BIGSERIAL PRIMARY KEY,
  mission_id         UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id            UUID REFERENCES tasks(id) ON DELETE SET NULL,
  rule               TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'rules',
  detail             TEXT NOT NULL,
  action             TEXT NOT NULL DEFAULT 'hint',
  stalled_streak     INT NOT NULL DEFAULT 0,
  hint_id            UUID,
  escalation_signal  BOOLEAN NOT NULL DEFAULT false,
  approval_id        UUID,
  -- Effect capture: filled by the sweep after WATCHDOG_OUTCOME_DELAY_MS.
  outcome            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (outcome IN ('pending', 'progress', 'no_progress')),
  outcome_detail     JSONB NOT NULL DEFAULT '{}',
  outcome_checked_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS watchdog_observations_mission_idx
  ON watchdog_observations (mission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS watchdog_observations_recent_idx
  ON watchdog_observations (created_at DESC);
CREATE INDEX IF NOT EXISTS watchdog_observations_pending_idx
  ON watchdog_observations (created_at) WHERE outcome = 'pending';

CREATE TABLE IF NOT EXISTS watchdog_task_state (
  task_id            UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  mission_id         UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  stalled_streak     INT NOT NULL DEFAULT 0,
  escalated_streak   INT NOT NULL DEFAULT 0,
  last_rule          TEXT,
  last_detail        TEXT,
  last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
