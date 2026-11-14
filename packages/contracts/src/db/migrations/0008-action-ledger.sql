-- Write-action ledger: target-side POST/PUT/PATCH/DELETE observed by the proxy.
-- Retry guard uses this table to require a human confirmation before re-running
-- a task that may already have mutated the target.
CREATE TABLE IF NOT EXISTS action_ledger (
  id             BIGSERIAL PRIMARY KEY,
  mission_id     UUID NOT NULL,
  task_id        UUID,
  method         TEXT NOT NULL,
  url            TEXT NOT NULL,
  status_code    INTEGER,
  request_sha256 TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'proxy',
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_ledger_mission_id_fkey') THEN
    ALTER TABLE action_ledger
      ADD CONSTRAINT action_ledger_mission_id_fkey
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE;
  END IF;
END $$;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS write_actions_confirmed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS action_ledger_task_idx ON action_ledger (task_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS action_ledger_mission_idx ON action_ledger (mission_id, observed_at DESC);
