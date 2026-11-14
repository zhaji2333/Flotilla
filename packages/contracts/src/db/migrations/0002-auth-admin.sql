-- Local human accounts, server-side sessions, admin audit and runtime settings.
-- Passwords use Node scrypt hashes written by the API; this schema stores only
-- the encoded hash and never logs plaintext.
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip inet
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  actor_user_id uuid,
  actor_name text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id_hash text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
