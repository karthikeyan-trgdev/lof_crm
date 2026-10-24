-- Lab of Future CRM – core schema (Cloudflare D1 / SQLite)
--
-- Business records are stored as JSON documents with indexed columns ("document + index" pattern).
-- The JSON shape is exactly what the CRM screens use, so the API, the UI and the integrations share
-- one model. Indexed columns are derived on every write (src/lib/db.ts → indexFor()).
--
--   type      lead | opp | student | enrollment | payment | moodle_sync | refund | approval | task |
--             call | comm | notification | audit | branch | program | fee | discount | staff
--   branch    branch short ID (KRM, SPC, BLR …) used for branch-scope filtering
--   ref1/ref2 per-type lookup keys:
--               lead        ref1 = normalised phone (last 9 digits)   ref2 = lower(email)
--               task/call/comm ref1 = lead id
--               payment     ref1 = enrollment id                      ref2 = student id
--               enrollment  ref1 = student id                         ref2 = opportunity id
--               moodle_sync ref1 = enrollment id                      ref2 = student id
--               refund      ref1 = enrollment id
--               opp         ref1 = lead id                            ref2 = student id
--               approval    ref1 = referenced record id
--               staff       ref1 = lower(email)
--   owner     counsellor / staff id that owns the record (leads, tasks, opps)
--   status    lifecycle status of the record

CREATE TABLE IF NOT EXISTS docs (
  type        TEXT NOT NULL,
  id          TEXT NOT NULL,
  branch      TEXT,
  status      TEXT,
  owner       TEXT,
  ref1        TEXT,
  ref2        TEXT,
  at          TEXT,                     -- primary business timestamp (enquiry, payment date …)
  data        TEXT NOT NULL,            -- JSON document
  is_test     INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS ix_docs_branch ON docs(type, branch);
CREATE INDEX IF NOT EXISTS ix_docs_ref1   ON docs(type, ref1);
CREATE INDEX IF NOT EXISTS ix_docs_ref2   ON docs(type, ref2);
CREATE INDEX IF NOT EXISTS ix_docs_owner  ON docs(type, owner, status);
CREATE INDEX IF NOT EXISTS ix_docs_status ON docs(type, status);
CREATE INDEX IF NOT EXISTS ix_docs_at     ON docs(type, at);
CREATE INDEX IF NOT EXISTS ix_docs_test   ON docs(is_test);

-- Single-document settings: cfg (configuration centre), perms (role matrix), scope (multi-branch
-- access), fx (reporting FX rates), hist (monthly admissions history for targets).
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT
);

-- Gapless business sequences (next value to use). Receipt numbers are per branch: rc_KRM, rc_BLR …
CREATE TABLE IF NOT EXISTS sequences (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

-- Login credentials (kept out of the staff document so they never reach the browser)
CREATE TABLE IF NOT EXISTS staff_auth (
  staff_id       TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  must_change    INTEGER NOT NULL DEFAULT 1,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT
);

-- Every outbound integration call and inbound webhook, with secrets redacted (Testing Console → Logs)
CREATE TABLE IF NOT EXISTS integration_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  integration  TEXT NOT NULL,           -- meta | whatsapp | exotel | moodle | telr | razorpay | erpnext | gcal | email | website
  direction    TEXT NOT NULL,           -- out | in
  operation    TEXT NOT NULL,
  mode         TEXT NOT NULL,           -- live | mock
  method       TEXT,
  url          TEXT,
  status       INTEGER,
  ok           INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  request      TEXT,
  response     TEXT,
  error        TEXT,
  ref          TEXT,                    -- related record id (lead, payment, sync …)
  is_test      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_ilog_at  ON integration_logs(at);
CREATE INDEX IF NOT EXISTS ix_ilog_int ON integration_logs(integration, at);

-- Webhook idempotency: providers retry, so each event is processed once
CREATE TABLE IF NOT EXISTS webhook_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result      TEXT,
  PRIMARY KEY (provider, event_id)
);

-- Hosted payment links (Telr for AED branches, Razorpay for INR branches)
CREATE TABLE IF NOT EXISTS payment_links (
  id            TEXT PRIMARY KEY,        -- PL-…
  provider      TEXT NOT NULL,           -- telr | razorpay | mock
  provider_ref  TEXT,                    -- Telr order ref / Razorpay payment link id
  enrollment_id TEXT NOT NULL,
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL DEFAULT 'created',  -- created | paid | failed | cancelled | expired
  payment_id    TEXT,                    -- CRM payment id once paid
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at       TEXT,
  is_test       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_plink_ref ON payment_links(provider, provider_ref);

-- Telephony screen-pop: incoming calls waiting to be shown to the right counsellor
CREATE TABLE IF NOT EXISTS call_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  call_sid    TEXT,
  from_number TEXT,
  lead_id     TEXT,
  staff_id    TEXT,
  branch      TEXT,
  kind        TEXT NOT NULL DEFAULT 'incoming'
);
CREATE INDEX IF NOT EXISTS ix_call_events_at ON call_events(at);
