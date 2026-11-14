-- The proxy creates this table lazily; ensure it exists before the API applies
-- this migration on a fresh database.
CREATE TABLE IF NOT EXISTS proxy_traffic (
    id              BIGSERIAL PRIMARY KEY,
    observed_at     TIMESTAMPTZ NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'target',
    method          TEXT NOT NULL,
    url             TEXT NOT NULL,
    url_host        TEXT NOT NULL,
    status_code     INTEGER NOT NULL,
    request_sha256  TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    request_bytes   BIGINT NOT NULL,
    response_bytes  BIGINT NOT NULL,
    mission_id      UUID
);

-- Associate proxied target/internet traffic with the mission that authorized it.
-- ON DELETE CASCADE makes project deletion remove its traffic audit rows as part
-- of the same transaction (previously proxy_traffic was a global, unscoped table).
ALTER TABLE proxy_traffic ADD COLUMN IF NOT EXISTS mission_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proxy_traffic_mission_id_fkey'
  ) THEN
    ALTER TABLE proxy_traffic
      ADD CONSTRAINT proxy_traffic_mission_id_fkey
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS proxy_traffic_mission_idx ON proxy_traffic (mission_id, observed_at DESC);
