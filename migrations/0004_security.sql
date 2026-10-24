-- Security hardening: server-side sessions, rate limiting, MFA, and database-level integrity rules.

-- Sessions: the browser holds only a random token in an HttpOnly cookie; the database stores its SHA-256.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,            -- sha256(token)
  staff_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,               -- absolute expiry
  revoked_at   TEXT,
  stage        TEXT NOT NULL DEFAULT 'full', -- full | password_change | mfa_setup
  acting_as    TEXT,                        -- role preview: original staff id
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_staff ON sessions(staff_id);

-- Fixed-window rate limits (login, MFA, website form, sync)
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- MFA (TOTP) – the secret is AES-GCM encrypted with a key derived from the server secret
ALTER TABLE staff_auth ADD COLUMN mfa_secret TEXT;
ALTER TABLE staff_auth ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_auth ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_auth ADD COLUMN password_changed_at TEXT;

-- Integrity rules enforced by the database itself, whatever the application code does:
-- 1. A payment can never take an enrolment above its total (also under concurrent requests).
CREATE TRIGGER IF NOT EXISTS trg_payment_no_overpay
BEFORE INSERT ON docs
WHEN NEW.type = 'payment' AND NOT EXISTS (SELECT 1 FROM docs WHERE type = 'payment' AND id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'overpayment')
  WHERE (SELECT COALESCE(SUM(json_extract(data, '$.amt')), 0) FROM docs WHERE type = 'payment' AND ref1 = NEW.ref1)
        + json_extract(NEW.data, '$.amt')
        > COALESCE((SELECT json_extract(data, '$.total') FROM docs WHERE type = 'enrollment' AND id = NEW.ref1), 0) + 0.005;
END;

-- 2. Payment amount, enrolment, currency and receipt number are immutable once recorded.
CREATE TRIGGER IF NOT EXISTS trg_payment_immutable
BEFORE UPDATE ON docs
WHEN OLD.type = 'payment' AND (
  json_extract(NEW.data, '$.amt') IS NOT json_extract(OLD.data, '$.amt') OR
  json_extract(NEW.data, '$.enr') IS NOT json_extract(OLD.data, '$.enr') OR
  json_extract(NEW.data, '$.cur') IS NOT json_extract(OLD.data, '$.cur') OR
  json_extract(NEW.data, '$.rc')  IS NOT json_extract(OLD.data, '$.rc'))
BEGIN
  SELECT RAISE(ABORT, 'immutable payment');
END;

-- 3. The audit log is append-only (test records may be cleaned up).
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON docs WHEN OLD.type = 'audit'
BEGIN
  SELECT RAISE(ABORT, 'immutable audit');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON docs WHEN OLD.type = 'audit' AND OLD.is_test = 0
BEGIN
  SELECT RAISE(ABORT, 'immutable audit');
END;
CREATE TRIGGER IF NOT EXISTS trg_payment_no_delete
BEFORE DELETE ON docs WHEN OLD.type = 'payment' AND OLD.is_test = 0
BEGIN
  SELECT RAISE(ABORT, 'immutable payment');
END;
