# LOF CRM – Test, Security & API Handover

Lab of Future CRM · Cloudflare Workers + D1 · release prepared 12 October 2026

This one document covers everything needed to proceed:

1. Status at a glance
2. Test report
3. Issues found and fixed
4. Security controls
5. Residual risks and recommendations
6. Deployment runbook
7. Integration go-live checklist
8. Decisions to confirm
9. API reference

---

## 1. Status at a glance

| Area | Result |
|---|---|
| Automated tests (API, sync, integrations, security, units) | **120 / 120 passed** |
| Browser tests (real screens against the Worker) | **10 / 10 passed** |
| TypeScript type check | Clean |
| Production build (`wrangler deploy --dry-run`) | OK – 290 KiB, 75 KiB gzipped |
| Independent security reviews | 3 rounds. Every high or critical finding is fixed and has a regression test |
| Integrations | All 10 adapters tested in mock mode and against stubbed provider APIs. Live mode turns on per integration once its credentials are set |
| Hosted pilot (Claude artifact) | **Paused.** It cannot meet the security level above (no server-side checks). Use Cloudflare staging instead |

**Ready to proceed** to Cloudflare staging, then production once the integration credentials and the business decisions in section 8 are confirmed.

---

## 2. Test report

### 2.1 How the tests run

- **Vitest** runs the real Worker code: the same Hono app, sync rules and adapters. It uses an in-memory SQLite database built from the same four migrations as production, so no network or Cloudflare account is needed.
- **Playwright** drives the real CRM screens in Chromium against `wrangler dev`, using a local D1 database freshly migrated from the seed.

```bash
npm test             # 120 tests, ~20 s
npm run test:e2e     # 10 browser tests, ~40 s
npm run typecheck
```

### 2.2 Results by suite

| Suite | Tests | Covers |
|---|---|---|
| `test/unit` | 17 | HMAC, JWT, PBKDF2, TOTP, fee maths, templates, LMS encoding, Exotel/Meta/WhatsApp parsing, log redaction, live/mock switching |
| `test/api/smoke` | 1 | App boots, health check, migrations apply |
| `test/api/auth-and-sync` | 23 | Sign-in, lockout, password rules, role preview, branch-scoped bootstrap, every sync guard, approvals, sequences |
| `test/api/rest` | 6 | Lead API with routing and duplicates, scoping, student 360, receipts, payment links |
| `test/api/create-admin` | 1 | Admin script stores a hash only and forces a password change |
| `test/integrations/webhooks` | 12 | Website (signed, origin, honeypot), Meta, WhatsApp, Exotel, Razorpay, Telr – verification and idempotency |
| `test/integrations/live-adapters` | 8 | Exact requests to LMS, WhatsApp, Exotel, ERPNext and Telr against stubbed APIs, including provider error formats |
| `test/integrations/testing-console` | 11 | Readiness, connection tests, 4 end-to-end scenarios, webhook simulations, cleanup, scheduler |
| `test/security/security` | 29 | Round-1 review findings, plus sessions, CSRF, two-step verification, headers |
| `test/security/round2` | 12 | Round-2 and round-3 findings: issued IDs, append-only history, refund cap, permissions, sign-in hardening, log redaction |
| **Total** | **120** | **All passed** |

### 2.3 Browser tests (end-to-end)

| # | Flow | Result |
|---|---|---|
| 1 | Counsellor creates a lead; it is saved on the server with routing | ✓ |
| 2 | Counsellor cannot open Configuration | ✓ |
| 3 | Administrator runs the UAE scenario from the Testing console | ✓ |
| 4 | Sign-out clears all data from the page; screen keeps working | ✓ |
| 5 | Reception records a counter payment and gets a server receipt number | ✓ |
| 6 | Centre Administrator registers a new student; LMS sync completes | ✓ |
| 7 | Management approves a pending exceptional discount | ✓ |
| 8 | System Administrator saves SLA configuration | ✓ |
| 9 | Counsellor cannot see another branch's leads | ✓ |
| 10 | System Administrator issues a temporary password; the user must change it at sign-in | ✓ |

### 2.4 Testing console scenarios (in the app)

Under **Settings → Testing console** (System Administrator only), each scenario passes every step:

- UAE enquiry → routing → opportunity → enrolment → Telr payment link → paid → receipt → LMS → ERPNext
- India enquiry → the same flow with INR and Razorpay
- Meta Lead Ads import, including retry de-duplication
- LMS outage → failure recorded → automatic retry succeeds

Test records use `TST-` numbers. They never consume business numbering, are hidden from other users and are removed with *Delete test data*.

---

## 3. Issues found and fixed

### 3.1 Functional issues (testing and QA)

| Issue | Fix |
|---|---|
| Long pop-up forms (e.g. *New lead*) pushed the Save button off-screen | Pop-ups scroll inside; the footer stays visible |
| Centre Administrator's first payment in the enrolment form was rejected | Allowed when it is part of a new enrolment |
| Routing found no counsellor when one branch was full; test leads counted toward workload | Capacity check in scenarios; test leads excluded from workload |
| Two people editing the same lead could overwrite each other | Field-level merge: each person's changed fields are kept, and the user is told when a colleague changed the same field |
| Bulk assign showed the wrong count; Lost leads could not be reopened | Fixed in the screens |
| Leftover "simulated" wording on screens and in sample data (Refunds, Notification settings, messages) | Replaced with accurate wording; sample data cleaned |
| After sign-out the previous user's data stayed in browser memory; clicks or Escape could error | Sign-out clears all data and timers; global handlers guard against a signed-out state |
| No way for an administrator to issue staff passwords | *Staff & user management → Edit* now offers *Issue temporary password*, *+ reset two-step* and *Sign out everywhere* |
| The production seed gave every staff login the public demo password | A masters-only seed now sets random, unknown passwords; the administrator issues temporary ones |
| The staging environment had no database or queue bindings (deploy would fail) | Separate staging D1 database and queue added to `wrangler.toml` |

### 3.2 Security findings

Three independent review rounds were run. Each round tried to break the system from the outside: forged requests, other roles, other branches. Every high and critical finding below is fixed and covered by a test.

| Severity | Finding | Fix |
|---|---|---|
| Critical | Sync accepted unknown operations, which skipped the guards | Only `upsert` and `delete` are accepted; record IDs are validated and must match |
| High | Records could be moved into your branch, or a lead moved without an approved transfer | Branch scope is checked on both the old and the new version; transfers must match the approval exactly |
| High | Client could set fees, discounts and totals | Fee recomputed from the fee master. Discounts must be predefined or an approved exceptional discount for the same opportunity, programme and fee, and an approval can be used once only |
| High | Payments: overpayment, backdating, client-chosen receipt numbers, editing | Amount ≤ balance; date clamped; receipt numbers issued by the server; database triggers block overpayment and any change to payments or audit |
| High | Client-built approvals, messages, LMS records and notifications | Rebuilt on the server: approver role from configuration, summary, recipients and payload are validated, and client text is never sent as-is |
| High | Session token readable by page scripts (stored in localStorage) | HttpOnly `__Host-` cookie with SameSite=Strict, a CSRF header on every write, server-side sessions, 60-minute idle timeout |
| High | Forged record numbers (IDs never issued by the server) | New records must use numbers issued by the server's sequence |
| High | History (events, assignments, approval history) could be rewritten | History lists are append-only; the server stamps who and when on new entries |
| High | A refund total could exceed what was paid | Cumulative refund cap |
| High | An unchecked edit in the same save could unlock another rule (e.g. raise `paid` to lift the refund cap) | Rules read related records as stored, and records are checked in dependency order |
| High | The Testing console was open to all configuration roles | System Administrator only |
| High | Payment links had guessable IDs; mock links could be marked paid in production | Random 10-character link IDs; mock "paid" works only on test links or outside production; a link is claimed atomically when settled |
| Medium | No two-step verification | TOTP authenticator apps; required for System Administrator and Management |
| Medium | Sign-in enumeration and brute force | One generic error message; per-IP and per-e-mail limits; lockout; constant-time dummy hash for unknown e-mails |
| Medium | Sign-in could be posted from another site | Login accepts JSON only, and a browser Origin must be this app |
| Medium | Student 360 showed payments to roles without Payments access | Payments, enrolments and LMS data are returned only with the matching permission and branch |
| Medium | REST lead creation accepted any field | Field allow-list; the chosen counsellor must be an active counsellor of that branch |
| Medium | Secrets could appear in integration logs | Every configured secret value is redacted from logs |
| Medium | Test records could reach live providers in production | Test records always run in mock mode in production |
| Low | Missing rate limits on two-step disable and sequence blocks | Added |
| Low | Unescaped values in receipts; weak headers | HTML escaping; CSP with script hashes, HSTS, frame denial, and the other headers in 4.4 |

---

## 4. Security controls

### 4.1 Identity and sessions

- **Passwords:** PBKDF2-SHA256 (100,000 iterations, random salt).
  - At least 10 characters, using 3 of 4 character classes.
  - Must not contain the e-mail name or common words.
  - Forced change at first sign-in and after an administrator reset.
- **Two-step verification (TOTP):**
  - Works with any authenticator app.
  - Secrets are encrypted with AES-GCM; a code cannot be reused.
  - Required for the roles in `MFA_REQUIRED_ROLES` (default: System Administrator and Management).
  - Until a required user enrols, they can only reach the set-up screens.
- **Sessions:**
  - The random token lives in an HttpOnly, Secure, SameSite=Strict `__Host-` cookie; the server stores only its SHA-256 hash.
  - Sessions end after 60 minutes idle or 12 hours in total.
  - All of a user's sessions end on a password change, a two-step change or an administrator reset, and an administrator can sign anyone out everywhere.
- **CSRF:** every cookie-authenticated write must carry `x-lof-csrf: 1`; CORS is limited to the app's own origin.
- **Brute force:**
  - Sign-in: 10 per e-mail and 30 per IP per 15 minutes; 5 failures lock the account for 15 minutes.
  - Two-step attempts and password changes are limited.
  - Every API user is capped at 600 requests a minute.
- **Role preview** (impersonation) is impossible in production.

### 4.2 Authorization – every write is re-checked on the server

The screens keep their workflow logic, but the server is the authority. Each save (`PUT /sync`) is all-or-nothing and checks:

| Check | Example |
|---|---|
| Role permission (Roles & Permissions matrix) | Reception cannot edit leads; only configuration roles change settings |
| Branch scope, on the old and new version | A Karama counsellor cannot read, move or edit Sports City records |
| Approvals | Branch change only through a matching approved transfer. The approver must be the configured role and cannot be the requester. A decided request cannot be changed |
| Server-issued numbers | A new LD/OP/EN/PY/LOF/AP/RF… number must have been issued by the server |
| Append-only history | Timeline, assignment and approval history can only grow; the server stamps who and when |
| Fee integrity | Enrolment fee recomputed from the fee master; discounts validated; an exceptional approval can be used only once |
| Money | Payment ≤ balance, recorded methods only, reference required for non-cash payments, server receipt numbers; refunds capped at the amount paid |
| Consent | WhatsApp or e-mail without consent is stored as *Blocked* and never sent |
| Size limits | 64 KB per record, 500 changes and 2 MB per save |

### 4.3 Data protection

- **Database triggers (last line of defence):**
  - No overpayment.
  - Payment amount, enrolment, currency and receipt number cannot change.
  - Payments and audit entries cannot be deleted.
  - Audit entries cannot be edited.
- **Least data:**
  - Staff e-mail and mobile are hidden from roles without configuration access.
  - Payments are hidden without Payments → View.
  - Integration credentials are never sent to the browser.
- **Logs:** every request and response to a provider is logged with all secret values, tokens and authorisation headers redacted.
- **Retention (automatic):**
  - Integration logs: 30 days.
  - Webhook IDs: 90 days.
  - Ended sessions, rate counters and call screen-pop events: shortly after they expire.

### 4.4 Web and transport

- **Content-Security-Policy:**
  - Inline scripts are allowed only by exact SHA-256 hash.
  - `connect-src 'self'` and `frame-ancestors 'none'`.
  - The API answers with `default-src 'none'`.
- **Other headers:** HSTS (1 year), `X-Frame-Options: DENY`, `nosniff`, a strict Referrer-Policy, a Permissions-Policy, COOP, and `Cache-Control: no-store` on API responses.
- **Server secret:** the Worker refuses to run if `JWT_SECRET` is shorter than 32 characters.

### 4.5 Webhooks

| Provider | Verification |
|---|---|
| Website form | HMAC-SHA256 signature or allowed Origin, plus a rate limit, a honeypot, field caps and optional Cloudflare Turnstile |
| Meta, WhatsApp | `X-Hub-Signature-256` (constant-time compare); verify token |
| Exotel | Secret token; optional IP allow-list (`EXOTEL_ALLOWED_IPS`) |
| Razorpay | `X-Razorpay-Signature`; event ID de-duplication |
| Telr | Every payment confirmed server-to-server with Telr's *check* API; the scheduler reconciles open orders |

All webhooks are idempotent.

### 4.6 Administrator account

The administrator `mustaq@toprockinteriors.com` is created with `scripts/create-admin.mjs` (section 6, step 5):

- The password is read from an environment variable and stored only as a PBKDF2 hash. It is not in the code, the seed or the package.
- **Change it at first sign-in.** The password was shared in chat, so treat it as exposed. The account must also set up two-step verification at first sign-in.

---

## 5. Residual risks and recommendations

| # | Item | Recommendation |
|---|---|---|
| 1 | `JWT_SECRET` also encrypts the two-step secrets; rotating it disables everyone's two-step | Rotate only with a plan: reset two-step for all users after rotation |
| 2 | Staff accounts in the masters-only seed use the example e-mails from the prototype | Replace them with real staff (Configuration → Staff) before go-live, then issue temporary passwords |
| 3 | The screens still contain the prototype's workflow code; the server re-checks every write, but a business rule added to the screens only is not enforced | Add each new business rule to `src/sync/sync.ts` as well, with a test |
| 4 | Rate limits are per Worker database (fixed window) | Optionally add Cloudflare WAF rate-limiting rules on `/api/v1/auth/*` and `/webhooks/*` |
| 5 | Inline `style` attributes require `style-src 'unsafe-inline'` | Low risk: scripts are hash-locked |
| 6 | No automated backup policy is configured yet | Turn on D1 Time Travel (default 30 days) and schedule `wrangler d1 export` weekly |
| 7 | Refund rules (eligibility, pro-rata) are not automated | Confirm the policy (section 8) |
| 8 | Penetration test | Before go-live, have an external tester run a short test against staging |

---

## 6. Deployment runbook (Cloudflare)

**Prerequisites:**
- a Cloudflare account (Workers Paid plan recommended for queue volume and CPU limits);
- Node 20 or later;
- `npm install` in the project folder;
- `npx wrangler login`.

### Step 1 – Staging first

```bash
npx wrangler d1 create lof_crm_staging            # put the id into [env.staging] in wrangler.toml
npx wrangler queues create lof-crm-jobs-staging
npm run build                                      # demo data is fine for staging
npx wrangler d1 migrations apply lof_crm_staging --remote --env staging
openssl rand -base64 48 | npx wrangler secret put JWT_SECRET --env staging
npx wrangler deploy --env staging
```

Staging runs every integration in mock mode and allows role preview. Sign in with the demo users (`Welcome@LOF2026`, which must be changed), then run every scenario in the Testing console.

### Step 2 – Production database and queues

```bash
npx wrangler d1 create lof_crm                      # put database_id into wrangler.toml
npx wrangler queues create lof-crm-jobs
npx wrangler queues create lof-crm-jobs-dlq
```

### Step 3 – Production data (masters only – no demo records, no known passwords)

```bash
node scripts/patch-frontend.mjs
node scripts/build-seed.mjs --masters-only          # branches, programmes, fees, discounts, staff, settings
npm run db:migrate:remote
```

### Step 4 – Settings and secrets

- In `wrangler.toml`, set `APP_BASE_URL` to the real URL (for example `https://crm.labofuture.ae`). Webhook and payment return URLs are built from it.
- Set the server secret:
  ```bash
  openssl rand -base64 48 | npx wrangler secret put JWT_SECRET
  ```
- Add each integration's secrets as you go live (section 7).

### Step 5 – Administrator account

```bash
ADMIN_PASSWORD='<your temporary password>' node scripts/create-admin.mjs \
  --email mustaq@toprockinteriors.com --name "Mushtaq" > admin.sql
npx wrangler d1 execute lof_crm --remote --file admin.sql
rm admin.sql
```

### Step 6 – Deploy and add a custom domain

```bash
npm run deploy
```

Then, in the Cloudflare dashboard, go to Workers → lof-crm → Settings → Domains & Routes and add the custom domain.

### Step 7 – First sign-in

1. Sign in as the administrator.
2. Change the password.
3. Scan the QR code with an authenticator app.
4. Configuration → Staff: replace the example staff with real people.
5. For each person, choose **Edit → Issue temporary password** and give it to them in person or by phone.

### Step 8 – Verify

- `GET /health` returns `{ ok: true }`.
- Settings → Testing console shows every integration's readiness.
- Run the scenarios, then **Delete test data**.

**Rollback:** run `npx wrangler rollback` to return to the previous Worker version. The database can be restored with D1 Time Travel (`npx wrangler d1 time-travel restore lof_crm --timestamp=…`).

---

## 7. Integration go-live checklist

For each integration:

1. Set its secrets with `npx wrangler secret put NAME`.
2. Set its variables in `wrangler.toml`.
3. Enable it under **Configuration → Integrations**.
4. In the Testing console, use **Test connection** and run the scenarios.

An integration stays in **mock** mode until it is enabled and all its secrets are set.

| Integration | Secrets / variables | Register with the provider |
|---|---|---|
| Website form | `WEBSITE_FORM_SECRET`, optional `TURNSTILE_SECRET`; allowed origins in Configuration | Embed `public/embed/lead-form.js`, or POST JSON to `/webhooks/website` with `X-LOF-Signature` |
| Meta Lead Ads | `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PAGE_ACCESS_TOKEN` | Webhook (Page → leadgen) → `/webhooks/meta`; map form IDs to branch/programme |
| WhatsApp | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | Webhook → `/webhooks/whatsapp` (messages); approved template names on each CRM template |
| Exotel | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_CALLER_ID`, `EXOTEL_WEBHOOK_TOKEN`, `EXOTEL_SUBDOMAIN`, optional `EXOTEL_ALLOWED_IPS` | Passthru → `/webhooks/exotel/incoming?token=…`; status callback → `/webhooks/exotel/status?token=…`; a mobile number on each counsellor |
| LMS (LOF booking platform) | `LMS_URL`, `LMS_TOKEN` | REST web service with the 5 functions in the README; manual enrolment on courses; idnumber = LOF Student ID |
| Telr (AED) | `TELR_STORE_ID`, `TELR_AUTH_KEY`, `TELR_TEST_MODE` | Optional transaction advice → `/webhooks/telr` |
| Razorpay (INR) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Webhook → `/webhooks/razorpay` (`payment_link.paid`, `.cancelled`, `.expired`) |
| ERPNext | `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_COMPANY`, `ERPNEXT_PAID_TO_AED`, `ERPNEXT_PAID_TO_INR` | API user with Accounts User role; entries are created as drafts unless `submit` is on |
| Google Calendar | `GCAL_SERVICE_ACCOUNT_JSON`, `GCAL_CALENDAR_ID` | Share the calendar with the service account |
| E-mail (Resend) | `RESEND_API_KEY`, `EMAIL_FROM` | Verify the sending domain |

---

## 8. Decisions to confirm with the business

| # | Decision | Current default |
|---|---|---|
| 1 | First payment inside the enrolment form | Allowed for roles that can enrol, even with view-only Payments access |
| 2 | Refund policy (eligibility, pro-rata, fees retained) | Refunds are requests, capped at the amount paid; *Mark processed* records that the refund was paid outside the CRM |
| 3 | SLA business hours | Not applied; the SLA clock runs continuously |
| 4 | INR → AED rate for reports | Manual setting |
| 5 | Receipts vs tax invoices | The CRM issues receipts; tax invoices come from ERPNext |
| 6 | Counsellor-initiated reassignment | Goes to the Admissions Head for approval |
| 7 | Roles that must use two-step verification | System Administrator and Management (`MFA_REQUIRED_ROLES`) |
| 8 | Session idle timeout | 60 minutes (`SESSION_IDLE_MINUTES`) |

---

## 9. API reference

Base URL: `https://<host>/api/v1` · JSON in and out (`content-type: application/json`).

**Authentication – two ways**
- **Browser (the CRM screens):** `POST /auth/login` with header `x-lof-csrf: 1` sets an HttpOnly, `SameSite=Strict`, `Secure` session cookie (`__Host-lof_session`). Every write (`POST/PUT/PATCH/DELETE`) made with the cookie must also send `x-lof-csrf: 1`; the token is never exposed to page scripts.
- **API clients / integrations:** `POST /auth/login` *without* that header returns `{ token }` in the body; send it as `Authorization: Bearer <token>`.

Sessions are stored server-side (only a SHA-256 hash of the token), end after **60 minutes idle** (`SESSION_IDLE_MINUTES`) or **12 hours** in total, and are revoked on logout, password change, MFA change and administrator reset.

**Errors:** `{ "error": "message", "details"?: {…} }` with 400 (invalid), 401 (not signed in / session ended), 403 (permission, branch scope, or a pending sign-in step – `details.code` = `password_change` or `mfa_setup`), 404, 409 (conflict, rejected sync, duplicate, unissued record number), 413 (too large), 415 (not JSON), 422 (business rule), 429 (rate limited), 5xx.
**Lists** accept `limit` (1–200, default 50) and `offset` and return `{ total, limit, offset, items }`. All data is limited to the caller's branches and role permissions.

### Authentication & account security

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

### Screens (state & sync)

| Method | Path | Notes |
|---|---|---|
| GET | `/bootstrap` | Branch-scoped state for the screens: `{ me, server, data:{leads, opps, students, enr, pay, …, cfg, perms}, seq }` |
| PUT | `/sync` | `{ changes:[{ coll, id, op:'upsert' \| 'delete', doc, base? }], settings:[{ key, doc }] }` → `{ ok, docs, notices, settings, jobs }` or 409 `{ error, rejected }`. All-or-nothing, ≤ 500 changes and 2 MB per call, 64 KB per record. `base` = the version the user started from; the server applies only the fields that user changed (field-level merge) and reports `notices` when a colleague changed the same field. New records must use numbers issued by `/seq/*`. History lists (events, assignments, approvals history, messages) are append-only and stamped by the server |
| POST | `/seq/claim` | `{ name, expect }` → `{ ok, value }` – gapless numbers (lead, opp, enr, pay, student, ap, rf, pd) |
| POST | `/seq/block` | `{ name, size }` → `{ start, size }` – internal numbers (task, call, cm, notif, audit, ms) |

### Leads & sales

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

### Students, enrolments, payments

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

### LMS calls, instalments, refunds, targets, notifications, audit

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

### Testing console (`/testing`, System Administrator only)

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

### Webhooks (public, authenticated by signature or token)

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

### Other

`GET /health` → `{ ok, db, env, time }` (for uptime monitoring).
