-- v1.0.2 reliability hardening (additive only, ADR-0054).
-- Deadline/reporting phase, no-silent-abandonment dispositions, structured
-- task handoff, preflight checks, retry state and coverage requirements.
-- Legacy missions/tasks are unaffected: every new column is nullable or has a
-- backwards-compatible default.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'active';
ALTER TABLE missions ADD COLUMN IF NOT EXISTS reporting_lead_ms INT NOT NULL DEFAULT 900000;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS search_policy TEXT NOT NULL DEFAULT 'limited';
CREATE INDEX IF NOT EXISTS idx_missions_phase_deadline ON missions(phase, deadline_at);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_version INT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preflight_status TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_disposition ON tasks(disposition);

CREATE TABLE IF NOT EXISTS task_handoffs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id        UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt           INT NOT NULL,
  handoff           JSONB NOT NULL,
  redaction_version INT NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_task
  ON task_handoffs(task_id, attempt DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_mission
  ON task_handoffs(mission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_preflight_checks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id          UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  checked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase_ok            BOOLEAN NOT NULL,
  deadline_ok         BOOLEAN NOT NULL,
  scope_ok            BOOLEAN NOT NULL,
  auth_ok             BOOLEAN NOT NULL,
  target_version      TEXT,
  credential_version  TEXT,
  pending_destructive BOOLEAN NOT NULL DEFAULT false,
  decision            TEXT NOT NULL CHECK (decision IN ('proceed','blocked','out_of_scope','retry_wait')),
  reason              TEXT,
  evidence_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_preflight_task
  ON task_preflight_checks(task_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS task_retry_state (
  mission_id   UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  attempt      INT NOT NULL DEFAULT 0,
  next_at      TIMESTAMPTZ,
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS coverage_requirements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id     UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  target_ref     TEXT NOT NULL,
  attack_surface TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','covered','negative','dispositioned')),
  evidence_ref   TEXT,
  disposition    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mission_id, target_ref, attack_surface)
);
CREATE INDEX IF NOT EXISTS idx_coverage_requirements_mission
  ON coverage_requirements(mission_id, status);
