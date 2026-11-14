-- Summary/补漏 pass. Summary tasks are ordinary tasks; this table stores the
-- bounded review output for the console and APIs.
BEGIN;

CREATE TABLE IF NOT EXISTS mission_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  markdown text NOT NULL,
  coverage_assessment text,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mission_summaries_mission ON mission_summaries(mission_id, created_at DESC);

COMMIT;
