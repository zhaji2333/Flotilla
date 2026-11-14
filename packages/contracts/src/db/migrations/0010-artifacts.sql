-- Mission-scoped input artifacts (APK/ELF/JS). Content-addressed on disk;
-- the database stores only metadata. No execution is implied by ingestion.
CREATE TABLE IF NOT EXISTS artifacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id     UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id        UUID REFERENCES tasks(id) ON DELETE SET NULL,
  sha256         TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size           BIGINT NOT NULL CHECK (size >= 0),
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_path   TEXT NOT NULL,
  created_by     TEXT NOT NULL DEFAULT 'api',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_mission_sha ON artifacts(mission_id, sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_mission_created ON artifacts(mission_id, created_at DESC);
