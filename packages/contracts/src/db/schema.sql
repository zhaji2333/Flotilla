-- SRC-Agent PostgreSQL schema (P0).
--
-- This file is idempotent: it is used both as the docker-entrypoint init script
-- and by the worker on startup (`applySchema`) so an existing development
-- database from an earlier revision converges without a manual reset.
--
-- Design notes (P0):
--   * The mission row is the source of truth for target, objective and success
--     criteria; the worker claims tasks from this table (no env-driven missions).
--   * Evidence bodies are stored on demand when the worker reports a finding
--     (or fetches internet reference material). The proxy only stores audit
--     metadata (method/URL/status/hashes/sizes), not traffic bodies.
--   * MinIO / object storage was intentionally removed; see ADR-0010.

BEGIN;

-- ── Missions ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS missions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',
  grant_id      UUID,
  grant_version INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE missions ADD COLUMN IF NOT EXISTS target JSONB;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS objective TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS failure_class TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);

-- ── Grants ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS grants (
  id          UUID NOT NULL,
  version     INT NOT NULL,
  scope       JSONB NOT NULL,
  constraints JSONB NOT NULL,
  issued_by   TEXT NOT NULL DEFAULT 'user',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

-- ── Tasks ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id      UUID NOT NULL REFERENCES missions(id),
  type            TEXT NOT NULL DEFAULT 'explore',
  state           TEXT NOT NULL DEFAULT 'pending',
  intent_node_id  UUID,
  depends_on      UUID[] DEFAULT '{}',
  grant_id        UUID,
  grant_version   INT,
  budget          JSONB NOT NULL DEFAULT '{"maxSteps":0,"maxWallClockMs":1200000}',
  payload         JSONB NOT NULL DEFAULT '{}',
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result JSONB;
-- P1 scheduler columns (idempotent migration from the P0 `pending` model).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority NUMERIC NOT NULL DEFAULT 0.5;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fencing_token INT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preconditions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS allowed_tools TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS supersedes UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handed_back_reason TEXT;
-- Durable retry (superagent Effects-style backoff): retry_wait becomes ready
-- only after retry_after; last_error feeds the recovery note of the next try.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error TEXT;
-- Set by the human retry-confirmation path after reviewing action_ledger.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS write_actions_confirmed_at TIMESTAMPTZ;
-- P0 used `pending`; the P1 state machine uses proposed → ready → ...
UPDATE tasks SET state = 'proposed' WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_state_mission ON tasks(state, mission_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ready ON tasks(state, priority DESC, created_at ASC) WHERE state = 'ready';
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_task_fingerprint
  ON tasks(mission_id, fingerprint)
  WHERE state IN ('proposed', 'ready', 'leased', 'running') AND fingerprint IS NOT NULL;

-- Task reports are idempotent and carry the fencing token that produced them.
CREATE TABLE IF NOT EXISTS worker_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id),
  mission_id      UUID NOT NULL REFERENCES missions(id),
  worker_id       TEXT NOT NULL,
  fencing_token   INT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL,
  report          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Evidence (body captured on demand by the worker) ────────

CREATE TABLE IF NOT EXISTS evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id     UUID NOT NULL REFERENCES missions(id),
  task_id        UUID REFERENCES tasks(id),
  traffic_ref    TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'target',   -- target | internet
  method         TEXT NOT NULL,
  url            TEXT NOT NULL,
  request_text   TEXT NOT NULL,
  response_text  TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL,
  request_bytes  BIGINT NOT NULL,
  response_bytes BIGINT NOT NULL,
  untrusted      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, traffic_ref)
);
CREATE INDEX IF NOT EXISTS idx_evidence_mission ON evidence(mission_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

-- ── Findings ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS findings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id     UUID NOT NULL REFERENCES missions(id),
  task_id        UUID REFERENCES tasks(id),
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'accepted',  -- accepted | review
  artifact       TEXT,
  report_md      TEXT NOT NULL,
  evidence_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  curator_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_findings_mission ON findings(mission_id);

-- P2 Curator evidence closure: root-cause dedupe, confidence and merge lineage.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS root_cause_key TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'unverified'; -- observed | inferred | unverified
ALTER TABLE findings ADD COLUMN IF NOT EXISTS merged_count INT NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS superseded_by UUID;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE findings SET status = 'needs_review' WHERE status = 'review';
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_root_cause ON findings(mission_id, root_cause_key) WHERE root_cause_key IS NOT NULL;

-- ── Explore graph / assets / events / outbox (kept for P1) ──

CREATE TABLE IF NOT EXISTS explore_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  UUID NOT NULL REFERENCES missions(id),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_explore_nodes_mission_type ON explore_nodes(mission_id, type);

CREATE TABLE IF NOT EXISTS explore_edges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  UUID NOT NULL REFERENCES missions(id),
  source_id   UUID NOT NULL REFERENCES explore_nodes(id),
  target_id   UUID NOT NULL REFERENCES explore_nodes(id),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_explore_edges_source ON explore_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_explore_edges_target ON explore_edges(target_id);

CREATE TABLE IF NOT EXISTS assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    UUID NOT NULL REFERENCES missions(id),
  type          TEXT NOT NULL,
  value         TEXT NOT NULL,
  task_id       UUID REFERENCES tasks(id),
  identity_key  TEXT GENERATED ALWAYS AS (type || '::' || value) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mission_id, identity_key)
);

CREATE TABLE IF NOT EXISTS events (
  seq           BIGSERIAL PRIMARY KEY,
  mission_id    UUID NOT NULL REFERENCES missions(id),
  event_type    TEXT NOT NULL,
  aggregate_id  TEXT NOT NULL DEFAULT '',
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_mission_seq ON events(mission_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS outbox (
  id            BIGSERIAL PRIMARY KEY,
  mission_id    UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  delivered     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_undelivered ON outbox(delivered) WHERE NOT delivered;

CREATE TABLE IF NOT EXISTS steering (
  id          BIGSERIAL PRIMARY KEY,
  mission_id  UUID NOT NULL REFERENCES missions(id),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  processed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_steering_unprocessed ON steering(mission_id) WHERE NOT processed;

CREATE TABLE IF NOT EXISTS approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    UUID NOT NULL REFERENCES missions(id),
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       JSONB NOT NULL DEFAULT '{}',
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mission_todo (
  id          BIGSERIAL PRIMARY KEY,
  mission_id  UUID NOT NULL REFERENCES missions(id),
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reason_lease (
  mission_id    UUID PRIMARY KEY REFERENCES missions(id),
  lease_owner   TEXT NOT NULL,
  fence         INT NOT NULL DEFAULT 0,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;


-- ── P1-γ: control-plane hints (hint 队列 + 下一次注入) ──────
-- Hints are durable steering messages; the worker claims pending hints for a
-- task at each run boundary (initial claim, retry attempt, settlement pass)
-- and injects them into the next Harness prompt. target task_id NULL = mission-wide.
CREATE TABLE IF NOT EXISTS task_hints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id       UUID REFERENCES tasks(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'control_plane',
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_task_hints_pending
  ON task_hints (mission_id, created_at) WHERE state = 'pending';


-- ── P1-β: Planner (双层架构 ① + 批处理 ③ + reason lease) ──
-- Tasks created by a Planner run carry the run id and an explicit depends_on
-- serial chain (readiness already understands both).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planner_run_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID;

-- Buffered signals consumed by a batched Planner reason pass.
CREATE TABLE IF NOT EXISTS planner_signals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id     UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed', 'failed')),
  consumed_by_run UUID,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planner_signals_pending
  ON planner_signals (mission_id, created_at) WHERE state = 'pending';

-- One auditable row per Planner reason pass.
CREATE TABLE IF NOT EXISTS planner_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'completed', 'failed')),
  reason        TEXT,
  signal_count  INT NOT NULL DEFAULT 0,
  action_count  INT NOT NULL DEFAULT 0,
  session_id    TEXT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_planner_runs_mission ON planner_runs(mission_id, started_at DESC);
-- P3-B1: keep the validated plan JSON for A/B evaluation and replay/audit.
ALTER TABLE planner_runs ADD COLUMN IF NOT EXISTS plan JSONB;
ALTER TABLE planner_runs ADD COLUMN IF NOT EXISTS steps INT;
ALTER TABLE planner_runs ADD COLUMN IF NOT EXISTS tokens JSONB;

-- reason_lease becomes a time-bounded single-writer lease.
ALTER TABLE reason_lease ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE reason_lease ADD COLUMN IF NOT EXISTS last_reason_at TIMESTAMPTZ;
ALTER TABLE reason_lease ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Serial Todo chain shown to the Planner and projected later in the Web DAG.
ALTER TABLE mission_todo ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;
ALTER TABLE mission_todo ADD COLUMN IF NOT EXISTS task_id UUID;
ALTER TABLE mission_todo ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_mission_todo_mission ON mission_todo(mission_id, position);


-- ── P1-γ: triggers（事件→路由：planner 判断 vs 直通 worker） ──
CREATE TABLE IF NOT EXISTS triggers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  route         TEXT NOT NULL CHECK (route IN ('planner', 'direct')),
  payload       JSONB NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'processed' CHECK (state IN ('pending', 'processed', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_triggers_mission ON triggers(mission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triggers_route ON triggers(route, state);


-- ── P3-B6: structured hint kind (guidance / help / report) ──
ALTER TABLE task_hints ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'guidance';
CREATE INDEX IF NOT EXISTS idx_task_hints_kind ON task_hints (mission_id, kind);

-- ── P3-A6: eval history (structured JSON index; files remain the report source) ──
CREATE TABLE IF NOT EXISTS eval_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'completed',
  summary     JSONB NOT NULL DEFAULT '{}',
  details     JSONB,
  recorded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_kind_created ON eval_runs (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs (created_at DESC);

-- ── P3-B4: optional task angle for intentional same-mission parallelism ──
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS angle TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_mission_angle ON tasks(mission_id, angle);

-- ── Harness trajectory (worker/planner thinking, tools, skills, context) ──
CREATE TABLE IF NOT EXISTS task_trace (
  id            BIGSERIAL PRIMARY KEY,
  mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id       UUID,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('worker', 'planner')),
  subject_id    TEXT NOT NULL,
  seq           INT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_trace_subject ON task_trace(subject_type, subject_id, id);
CREATE INDEX IF NOT EXISTS idx_task_trace_mission ON task_trace(mission_id, id);

-- M5-4: searchable trace index. search_text contains only tool/URL/method/
-- command/status and a short result excerpt; raw response bodies stay in the
-- trace payload and are never returned by the search API.
ALTER TABLE task_trace ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_task_trace_search_text_trgm
  ON task_trace USING gin (search_text gin_trgm_ops);
UPDATE task_trace
SET search_text = left(concat_ws(' ',
  event_type,
  payload->>'tool',
  payload->'input'->>'url',
  payload->'input'->>'method',
  payload->'input'->>'command',
  payload->'input'->>'name',
  payload->'input'->>'path',
  payload->'result'->>'status',
  payload->>'status',
  left(COALESCE(payload->>'result', payload->>'text', payload->>'output', payload->>'summary', ''), 600)
), 6000)
WHERE search_text = '';


-- ── P3-B1: typed blackboard read models (derived, not a second source) ──
-- mission_facts / mission_intents are VIEWS over authoritative tables
-- (assets/findings/evidence/tasks). They can be dropped and rebuilt at any
-- time; nothing writes them directly. Per ADR-0010 credential fact values are
-- intentionally stored/returned in plaintext (user decision) and marked
-- sensitive=true so the console can mask them by default.
BEGIN;

DROP VIEW IF EXISTS mission_facts;
DROP VIEW IF EXISTS mission_intents;

CREATE VIEW mission_facts AS
  SELECT
    a.mission_id,
    ('asset:' || a.id::text)::text AS id,
    'asset'::text AS source,
    a.id::text AS source_id,
    a.type AS kind,
    (a.type || ':' || a.value) AS key,
    a.value AS value,
    a.value AS summary,
    'worker_asset'::text AS provenance,
    'inferred'::text AS trust,
    (a.type = 'credential') AS sensitive,
    a.task_id,
    a.created_at
  FROM assets a
  UNION ALL
  SELECT
    f.mission_id,
    ('finding:' || f.id::text),
    'finding',
    f.id::text,
    'vuln',
    COALESCE(f.root_cause_key, f.category || ':' || COALESCE(f.artifact, f.title)),
    f.category || ' | ' || f.severity || ' | ' || COALESCE(f.artifact, '-'),
    f.title,
    'accepted_finding',
    'observed',
    false,
    f.task_id,
    f.created_at
  FROM findings f
  WHERE f.status = 'accepted'
  UNION ALL
  SELECT
    f.mission_id,
    ('artifact:' || f.id::text),
    'finding_artifact',
    f.id::text,
    'artifact',
    ('artifact:' || f.artifact),
    f.artifact,
    f.title,
    'accepted_finding',
    'observed',
    false,
    f.task_id,
    f.created_at
  FROM findings f
  WHERE f.status = 'accepted' AND f.artifact IS NOT NULL AND f.artifact <> ''
  UNION ALL
  SELECT
    e.mission_id,
    ('evidence-host:' || md5(host_row.host)),
    'evidence',
    md5(host_row.host),
    'host',
    host_row.host,
    host_row.host,
    host_row.host,
    'proxy_evidence',
    'observed',
    false,
    NULL::uuid,
    min(e.created_at)
  FROM evidence e
  CROSS JOIN LATERAL (
    SELECT split_part(regexp_replace(e.url, '^https?://', ''), '/', 1) AS host
  ) AS host_row
  WHERE e.kind = 'target' AND host_row.host <> ''
  GROUP BY e.mission_id, host_row.host;

CREATE VIEW mission_intents AS
  SELECT
    t.mission_id,
    t.id::text AS id,
    t.type,
    t.state,
    COALESCE(t.payload->>'objective', '') AS objective,
    t.priority,
    t.depends_on,
    t.attempt,
    t.created_at
  FROM tasks t
  WHERE t.state IN ('proposed', 'ready', 'leased', 'running', 'retry_wait', 'blocked');

COMMIT;


-- ── P3-B2: UI-editable model configuration (plaintext keys, ADR-0011) ──
-- Keys are stored in plaintext by explicit user decision. Only the admin token
-- can read them (audited reveal); normal API consumers see masked values.
-- Worker/Planner read the active config directly from PostgreSQL and fall back
-- to the environment when no enabled config exists.
BEGIN;

CREATE TABLE IF NOT EXISTS model_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  base_url          TEXT NOT NULL,
  api_key           TEXT NOT NULL,
  model_name        TEXT NOT NULL,
  api_key_env       TEXT NOT NULL DEFAULT 'SRC_AGENT_MODEL_API_KEY',
  context_window    INT NOT NULL DEFAULT 1000000,
  max_output_tokens INT NOT NULL DEFAULT 393216,
  reasoning_effort  TEXT,
  compat            JSONB NOT NULL DEFAULT '{}'::jsonb,
  role              TEXT,
  tier              TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  is_default        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_configs_single_default
  ON model_configs(is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_model_configs_role ON model_configs(role, enabled);

CREATE TABLE IF NOT EXISTS model_config_audit (
  id          BIGSERIAL PRIMARY KEY,
  config_id   UUID,
  config_name TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete','reveal')),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_config_audit_created ON model_config_audit(created_at DESC);

COMMIT;
