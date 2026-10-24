# Hosting LOF CRM – step by step

The CRM runs on **Cloudflare** (Workers + D1 database). A free Cloudflare account is enough to start; the paid
Workers plan (USD 5/month) is recommended for production because it raises the limits on database reads and
background jobs.

You need: a Cloudflare account, and **either** a computer with Node.js 22 **or** a GitHub account.

---

## 1. Get two values from Cloudflare (5 minutes)

1. Sign in at <https://dash.cloudflare.com>.
2. **Account ID** – on the account home page, right-hand column ("Account ID"). Copy it.
3. **API token** – My Profile → API Tokens → *Create Token* → *Create Custom Token*, with these permissions:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Queues · Edit
   - Account · Account Settings · Read

   Create it and copy the token (it is shown once).

---

## 2a. Deploy from your computer (one command)

Unzip the code, open a terminal in the folder, then:

**macOS / Linux**

```bash
./deploy.sh
```

**Windows (PowerShell)**

```powershell
.\deploy.ps1
```

The script asks for the account ID, the API token, the administrator e-mail and a password (typed hidden – it is
never saved to disk; only a hash goes into the database). It then:

1. installs dependencies and runs the automated tests,
2. creates the database and job queues (only if missing),
3. applies the database migrations (only new ones),
4. generates the server secret (only if missing),
5. deploys the CRM and creates the administrator (only if that e-mail has no login yet),
6. checks `/health` and prints the address, e.g. `https://lof-crm.<your-subdomain>.workers.dev`.

It is safe to run again for every update – existing data, logins and secrets are kept.

> Prefer to run the steps yourself? `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/cf-deploy.mjs`
> Add `--data demo` for a trial with sample data, `--env staging` for a separate test copy.

## 2b. Or deploy from GitHub (no software on your computer)

1. Create a **private** repository and upload the unzipped folder.
2. Repository → Settings → Secrets and variables → Actions → *New repository secret*:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
3. Actions → **Deploy to Cloudflare** → *Run workflow* (choose production or staging, and masters or demo data).
4. The log ends with `✔ LOF CRM is live at https://…`.
5. After the first run, delete the `ADMIN_PASSWORD` secret – it is no longer needed.

---

## 3. First sign-in

1. Open the address, sign in with the administrator e-mail and password.
2. You are asked to **choose a new password** and **set up two-step verification** (Google Authenticator,
   Microsoft Authenticator or similar). Do both – the password used for setup should not stay in use.
3. Settings → Staff & user management: create logins for the team (each gets a temporary password and must
   change it at first sign-in).
4. Settings → Integrations: enter each provider's details, then Settings → Testing console → *Test* each one.
   An integration runs live only when it is enabled **and** its secret is set; otherwise it stays in safe mock mode.
   Secrets are set with `npx wrangler secret put NAME` (list in `wrangler.toml`), e.g. `npx wrangler secret put LMS_TOKEN`.

Custom domain: Cloudflare dashboard → Workers & Pages → lof-crm → Settings → Domains & Routes → *Add custom domain*,
then redeploy with `APP_BASE_URL=https://crm.yourdomain.com` (payment return and webhook links use it).

---

## 4. Checking the data

### In the CRM (easiest)

**Settings → Database** (System Administrator only):

- Every table with its row count: leads, opportunities, students, enrolments, **instalments** (one row per
  instalment), payments, refunds, LMS calls, approvals, tasks, calls, staff (with sign-in state), targets,
  audit log, integration log, payment links, webhook events, sessions, number sequences.
- Search across all columns, filter by branch, include or hide test records, page through results.
- Click a row to see the complete stored record.
- **Export CSV** – the current table and filter, opens in Excel (formulas are neutralised for safety).
- **Full backup (JSON)** – every business record, all settings and number sequences.

It is read-only. Passwords, two-step secrets and session tokens are never shown or exported, and every export
and backup is written to the audit log.

### With SQL (for IT / reporting tools)

The database has ready-made views. Run any query with wrangler (from the code folder, signed in with
`npx wrangler login` or with the API token set):

```bash
npx wrangler d1 execute lof_crm --remote --command "SELECT * FROM v_enrollments ORDER BY enrolled_on DESC LIMIT 20"
npx wrangler d1 execute lof_crm --remote --command "SELECT * FROM v_instalments WHERE due_date < date('now')"
npx wrangler d1 execute lof_crm --remote --command "SELECT branch, COUNT(*), SUM(total), SUM(outstanding) FROM v_enrollments GROUP BY branch"
npx wrangler d1 execute lof_crm --remote --command "SELECT * FROM v_lms_calls WHERE status <> 'Success'"
```

| View | One row per |
|---|---|
| `v_leads`, `v_opportunities` | lead / opportunity |
| `v_students`, `v_enrollments` | student / enrolment (with counsellor, payment term, outstanding) |
| `v_instalments` | instalment of an enrolment (due date, amount) |
| `v_payments`, `v_refunds` | payment / refund request (rule, suggestion, exception, decision) |
| `v_lms_calls` | LMS enrol or cancel call (status, attempts, error) |
| `v_approvals`, `v_tasks`, `v_calls` | approval / follow-up task / phone call |
| `v_staff` | staff member and sign-in state (never the password) |
| `v_targets` | counsellor monthly target |
| `v_audit` | audit log entry |

Use `--local` instead of `--remote` against the local development database.
Cloudflare also has a browser console: dashboard → Storage & Databases → D1 → `lof_crm` → *Console*.

---

## 5. Backups and restore

- **Automatic:** Cloudflare D1 keeps a 30-day point-in-time history (Time Travel):
  `npx wrangler d1 time-travel info lof_crm` and `npx wrangler d1 time-travel restore lof_crm --timestamp <time>`.
- **Your own copy:** Settings → Database → *Full backup (JSON)*. Keep it somewhere safe – it contains personal data.
- **Restore a JSON backup** into a database with no business records yet – a new account, a new staging copy,
  or a fresh database deployed with the default *masters* data. The restore stops without writing anything if
  leads, enrolments or payments already exist, so a backup is never mixed into live data:

  ```bash
  node scripts/restore-backup.mjs lof-crm-backup-2026-10-23.json > restore.sql
  npx wrangler d1 execute lof_crm --remote --file restore.sql
  rm restore.sql
  ```

  Records keep their original version and dates; number sequences never move backwards. The backup is taken as
  one consistent snapshot, and integration credentials are never included (they live in server secrets). Logins are not in
  backups – recreate the administrator with `scripts/create-admin.mjs` and reissue staff passwords from the CRM.

---

## 6. Updating

Replace the code with the new version and run `./deploy.sh` (or the GitHub workflow) again. New migrations are
applied automatically; data, logins and secrets are kept. Tests run first and the deployment stops if any fail.

## 7. If something goes wrong

| Symptom | Fix |
|---|---|
| `Authentication error` during deploy | Token is missing one of the four permissions, or the account ID is wrong. |
| `/health` shows `"db": "unavailable"` | Re-run the deploy – the migrations step did not finish. |
| Cannot sign in as administrator | Create the login again: `ADMIN_PASSWORD='…' node scripts/create-admin.mjs --email you@company.com --must-change > admin.sql` then `npx wrangler d1 execute lof_crm --remote --file admin.sql` and delete `admin.sql`. |
| An integration stays in "mock" | Enable it in Settings → Integrations and set its secret with `npx wrangler secret put …`. |
| Live logs | `npx wrangler tail lof-crm` |
