-- Cross-task request fingerprints for the current mission. Only hashes and a
-- normalized URL are stored; original request/response bodies and auth headers
-- never enter this index.
BEGIN;

CREATE TABLE IF NOT EXISTS mission_request_index (
  id bigserial PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  method text NOT NULL,
  normalized_url text NOT NULL,
  url_hash text NOT NULL,
  body_hash text NOT NULL,
  auth_hash text NOT NULL,
  status_code int,
  traffic_ref text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  hits int NOT NULL DEFAULT 1,
  UNIQUE (mission_id, method, url_hash, body_hash, auth_hash)
);
CREATE INDEX IF NOT EXISTS idx_mission_request_index_recent
  ON mission_request_index (mission_id, last_seen_at DESC);

COMMIT;
