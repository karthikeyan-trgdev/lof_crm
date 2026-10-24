# LOF CRM API reference (v1)

Base URL: `https://<host>/api/v1` · JSON in and out (`content-type: application/json`).

**Authentication – two ways**
- **Browser (the CRM screens):** `POST /auth/login` with header `x-lof-csrf: 1` sets an HttpOnly, `SameSite=Strict`, `Secure` session cookie (`__Host-lof_session`). Every write (`POST/PUT/PATCH/DELETE`) made with the cookie must also send `x-lof-csrf: 1`; the token is never exposed to page scripts.
- **API clients / integrations:** `POST /auth/login` *without* that header returns `{ token }` in the body; send it as `Authorization: Bearer <token>`.

Sessions are stored server-side (only a SHA-256 hash of the token), end after **60 minutes idle** (`SESSION_IDLE_MINUTES`) or **12 hours** in total, and are revoked on logout, password change, MFA change and administrator reset.

**Errors:** `{ "error": "message", "details"?: {…} }` with 400 (invalid), 401 (not signed in / session ended), 403 (permission, branch scope, or a pending sign-in step – `details.code` = `password_change` or `mfa_setup`), 404, 409 (conflict, rejected sync, duplicate, unissued record number), 413 (too large), 415 (not JSON), 422 (business rule), 429 (rate limited), 5xx.
**Lists** accept `limit` (1–200, default 50) and `offset` and return `{ total, limit, offset, items }`. All data is limited to the caller's branches and role permissions.

## Authentication & account security

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password, code? }` | → `{ user, stage, mustChangePassword, mfaSetupRequired, token? }`. If two-step verification is on and `code` is missing → `{ mfaRequired: true }` (send again with the 6-digit `code`). JSON only (415 otherwise); a foreign `Origin` is refused (403). One generic error for every failure. 5 failures lock the account 15 min; 10 attempts per e-mail and 30 per IP per 15 min (429) |
| POST | `/auth/logout` | | Ends this session, clears the cookie |
| GET | `/auth/me` | | `{ user, stage, mfaEnabled, mfaRequired }` |
| POST | `/auth/change-password` | `{ current, next }` | ≥ 10 characters, 3 of: lower/upper/digit/symbol, not containing the e-mail name or common words. Signs out all other sessions. 10 attempts / 15 min |
| POST | `/auth/mfa/setup` | | → `{ secret, otpauth }` (show as QR in an authenticator app). Secret stored AES-GCM encrypted |
| POST | `/auth/mfa/enable` | `{ code }` | Turns two-step verification on; signs out other sessions. 10 attempts / 10 min |
| POST | `/auth/mfa/disable` | `{ password, code }` | Not allowed for roles in `MFA_REQUIRED_ROLES`. 10 attempts / 10 min |
| POST | `/auth/reset-password` | `{ staffId, resetMfa? }` | System Administrator → `{ temporaryPassword }` (must be changed at next sign-in); signs the user out everywhere |
| POST | `/auth/revoke-sessions` | `{ staffId }` | System Administrator: sign a user out of every device |
| POST | `/auth/impersonate` | `{ staffId }` | Role preview for System Administrators – **only** when `ALLOW_IMPERSONATION=true` and `APP_ENV` ≠ production |

**Sign-in stages.** A session that still needs a password change (`password_change`) or two-step enrolment (`mfa_setup`, for roles listed in `MFA_REQUIRED_ROLES`, default *System Administrator, Management*) can call only `/auth/*`; every other endpoint answers 403 with `details.code` set to the stage.

**Rate limits (per user unless noted):** all API calls 600/min · `/seq/claim` 120/min · `/seq/block` 60/min · website form 10 per 10 min per IP.

## Screens (state & sync)

| Method | Path | Notes |
|---|---|---|
| GET | `/bootstrap` | Branch-scoped state for the screens: `{ me, server, data:{leads, opps, students, enr, pay, …, cfg, perms}, seq }` |
| PUT | `/sync` | `{ changes:[{ coll, id, op:'upsert' \| 'delete', doc, base? }], settings:[{ key, doc }] }` → `{ ok, docs, notices, settings, jobs }` or 409 `{ error, rejected }`. All-or-nothing, ≤ 500 changes and 2 MB per call, 64 KB per record. `base` = the version the user started from; the server applies only the fields that user changed (field-level merge) and reports `notices` when a colleague changed the same field. New records must use numbers issued by `/seq/*`. History lists (events, assignments, approvals history, messages) are append-only and stamped by the server |
| POST | `/seq/claim` | `{ name, expect }` → `{ ok, value }` – gapless numbers (lead, opp, enr, pay, student, ap, rf, pd) |
| POST | `/seq/block` | `{ name, size }` → `{ start, size }` – internal numbers (task, call, cm, notif, audit, ms) |

## Leads & sales

| Method | Path | Notes |
|---|---|---|
| GET | `/leads` | Filters: `status, branch, counsellor, category, source, from, to, q` |
| GET | `/leads/:id` | `{ lead, tasks, calls, comms, opportunities }` |
| POST | `/leads` | `{ student, parent, phone, email?, branch, prog, src, camp?, cat?, age?, dob?, school?, grade?, curr?, wa?, em?, notes?, cslr?, allowDuplicate? }` – only these fields are used; `cslr` must be an active counsellor of that branch → 201 `{ lead, assignedTo, duplicates }`. Applies routing rules, queues the automated WhatsApp/e-mail, creates the first-call task. 409 with `duplicates` if phone/e-mail already exists |
| POST | `/leads/duplicates` | `{ phone, email }` → `{ duplicates }` |
| POST | `/leads/:id/click-to-call` | Exotel: rings the signed-in user's mobile, then the parent. → `{ ok, mode, callSid }` |
| GET | `/calls/incoming?since=ISO` | Screen-pop events for the user (from the Exotel passthru) |
| GET | `/tasks` | `status`, `overdue=1`; counsellors get their own |
| GET | `/opportunities` | `stage` |
| GET | `/approvals` | `status`, `type` |

## Students, enrolments, payments

| Method | Path | Notes |
|---|---|---|
| GET | `/students` | `q` (ID, name, parent, phone, e-mail) |
| GET | `/students/:id` | `{ student, enrollments, payments, moodle }` (`moodle` = the student's LMS calls) – enrolments/LMS calls only with Enrolments → View, payments only with Payments → View, limited to your branches |
| GET | `/enrollments` | `status` |
| GET | `/payments` | `from`, `to` |
| GET | `/payments/:id/receipt` | Printable HTML receipt |
| POST | `/payments/links` | `{ enrollmentId, amount? }` → `{ id, provider:'telr' \| 'razorpay', mode, url, amount, currency }`. Defaults to the outstanding balance |
| GET | `/payments/links?enrollmentId=` | Links and their status (`created`, `paid`, `expired`, `cancelled`, `failed`) |
| POST | `/payments/links/:id/send` | `{ channel:'WhatsApp' \| 'Email' }` – sends the link to the parent (consent applies) |

## LMS calls, instalments, refunds, targets, notifications, audit

| Method | Path | Notes |
|---|---|---|
| GET | `/lms/calls` | LMS call log (`status`, `op` = enrol \| cancel). Enrolments → View. `/moodle/syncs` is kept as an alias |
| GET | `/lms/calls/:id` | One call with its history |
| POST | `/lms/calls/:id/retry` | Re-sends a failed call now → the updated call. A successful call cannot be re-run; an enrol call for a withdrawn enrolment is closed without sending |
| GET | `/lms/preview/:enrollmentId` | `{ enrol, cancel, missing, mode }` – exactly what the enrol and cancel calls would send, and any required field still missing |
| GET | `/enrollments/:id/instalments` | `{ term, currency, total, paid, instalments:[{ n, due, pct, amt, paid, bal, st }] }`; `st` = Paid, Due, Partly paid, Upcoming, Overdue, Overdue (part paid), Closed. Payments → View |
| GET | `/refunds/suggest?enrollmentId=&sessions=` | Suggested refund from the refund rules: `{ days, sessions, rule, pct, net, base, tax, reg, admin, gross, suggested, approver, confirmed }` |
| GET | `/targets?month=YYYY-MM` | Target and achievement per counsellor in your branches (a counsellor gets their own row) |
| GET | `/notifications` | Filtered for the role → `{ items, unread }` |
| POST | `/notifications/read` | `{ ids }` |
| GET | `/audit` | `ref` (Audit logs → View) |

**Rules applied in `PUT /sync`.**
- *Enrolments*: `term` must be an active payment term (default when omitted); the instalment schedule (`sched`) and the counsellor credited (`cslr`, from the linked opportunity) are set by the server and cannot be edited; a withdrawn enrolment cannot be reactivated.
- *Refunds*: `sessions` (attended) is required; the server stores `days`, `suggested` (what is left of the rule-based suggestion after earlier requests), `rule`, `exception` and `approverRole`. An exception can be processed or rejected only by the approver role and not by the person who requested it.
- *LMS calls* (`coll: 'ms'`): one `op: 'enrol'` record with a new enrolment; `op: 'cancel'` with a withdrawal (created by the server if the client does not send it). Track and Credit codes always come from Settings → LMS Integration.
- *Settings (`cfg`)*: payment terms (split adds up to 100, first instalment ≥ minimum, active default), refund rules, counsellor targets and LMS codes are validated; LMS credentials are never stored in settings.

### LMS call bodies (sent to `LMS_URL`, `Authorization: Bearer <LMS_TOKEN>`)

```json
{ "call": "enrol", "reference": "EN-26-0123", "student_id": "LOF-26-000041", "student_first_name": "Aarav", "student_last_name": "Sharma",
  "student_email": "aarav.sharma@example.com", "student_phone": "+91 98765 43210", "student_dob": "2014-07-15",
  "parent_id": "FAM-26-0019", "parent_name": "Rohit Sharma", "parent_email": "rohit.sharma@example.com", "parent_phone": "+91 98765 11111",
  "branch": "BLR01", "valid_until": "2027-09-18",
  "products": [ { "product_name": "Robotics – Term (24 sessions)", "track": "ROB-TRK-10021", "credits": ["ROB-TRK-10021-C3", "ROB-TRK-10021-C4", "ROB-TRK-10021-C5"] } ] }
{ "call": "cancel", "reference": "EN-26-0123" }
```
The number of credits is the number of Credit codes. No amount, price, invoice, payment method or refund value is ever sent. The connection test sends `{ "call": "ping" }`.

## Testing console (`/testing`, System Administrator only)

| Method | Path | Notes |
|---|---|---|
| GET | `/testing/status` | Readiness of each integration |
| POST | `/testing/integrations/:key/test` | `website, meta, whatsapp, exotel, lms, telr, razorpay, erpnext, gcal, email` |
| POST | `/testing/webhooks/:kind/simulate` | `website, meta, meta-verify, whatsapp-verify, whatsapp-status, whatsapp-inbound, exotel-incoming, exotel-status, telr-paid, razorpay-paid, bad-signature` |
| POST | `/testing/scenarios/:name/run` | `uae-lead-to-enrolment, india-lead-to-enrolment, meta-lead, lms-failure-retry` → `{ ok, steps:[{ step, ok, detail, ms }] }` |
| GET | `/testing/logs`, `/testing/logs/:id` | `integration`, `ok=0`, `mode`, `limit` |
| POST | `/testing/flags` | `{ moodleFail: true }` – mock LMS outage (failure injection) |
| POST | `/testing/cron` | Run the scheduler now |
| POST | `/testing/cleanup` | Delete all test data |

## Database (`/admin/db`, System Administrator only – read-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/db/tables` | `{ datasets:[{ name, label, group, rows, columns, branch, hasTest, detail, note }] }` |
| GET | `/admin/db/rows` | `name` (dataset), `q` (search across all columns; `%` and `_` match literally), `branch`, `test=1` (include test records), `limit` ≤ 500, `offset` → `{ name, columns, rows:[[…]], total, offset }`. 600 pages per hour |
| GET | `/admin/db/rows.csv` | Same filters, up to 50,000 rows (header `x-lof-truncated: 1` and a final note line when cut); UTF-8 with BOM; text cells starting `= + - @` are prefixed with `'` (numbers are left as numbers). 30 per hour; audited |
| GET | `/admin/db/record` | `name`, `id` → `{ record, meta:{ type, version, updated_at, updated_by, is_test } }` (integration log: the full row, secrets already redacted) |
| GET | `/admin/db/backup` | `{ format:"lof-crm-backup/1", exportedAt, exportedBy, docs:[…], settings:[…], sequences:[…] }`. Read in one transaction (consistent snapshot); integration credentials removed from settings. 5 per hour; audited. Restore with `scripts/restore-backup.mjs` |

Datasets: `leads, opportunities, students, enrollments, instalments, payments, refunds, lms_calls, approvals, tasks, calls, staff, targets, audit, integration_logs, payment_links, webhook_events, sessions, sequences`. Any other name is `404`. Dataset names map to fixed SQL (no user input reaches table or column names); `staff` comes from `v_staff`, which never selects the password hash or two-step secret; `sessions` never selects the token hash.

## Webhooks (public, authenticated by signature or token)

| Path | Provider | Authentication |
|---|---|---|
| `POST /webhooks/website` | Website form | `X-LOF-Signature` (HMAC-SHA256 hex) or allowed `Origin` |
| `GET/POST /webhooks/meta` | Meta Lead Ads | `hub.verify_token`; `X-Hub-Signature-256` |
| `GET/POST /webhooks/whatsapp` | WhatsApp Cloud API | `hub.verify_token`; `X-Hub-Signature-256` |
| `GET/POST /webhooks/exotel/incoming` | Exotel passthru | `?token=` |
| `POST /webhooks/exotel/status` | Exotel status callback | `?token=` |
| `POST /webhooks/razorpay` | Razorpay | `X-Razorpay-Signature` |
| `POST /webhooks/telr` | Telr transaction advice | Confirmed server-to-server with Telr's check API |
| `GET /webhooks/pay/return` | Customer return page | Status re-checked with the gateway |

All webhooks are idempotent (provider event IDs are recorded) and logged with secrets redacted. Signatures are compared in constant time. Optional: `EXOTEL_ALLOWED_IPS` (comma-separated) restricts the Exotel endpoints; `TURNSTILE_SECRET` adds Cloudflare Turnstile to the website form.

## Other

`GET /health` → `{ ok, db, env, time }` (for uptime monitoring).
