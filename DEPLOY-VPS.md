# Hosting LOF CRM on your own server (SSH + GitHub)

Use this to run the CRM on a Linux VPS instead of Cloudflare ([DEPLOY.md](DEPLOY.md)). Every push to `main` on
GitHub is tested, then GitHub Actions connects to the server over SSH and updates it.

**How it runs.** The CRM is a Cloudflare Worker. On the VPS it runs in Cloudflare's open-source runtime
(`workerd`, started by `wrangler`) under **pm2**, with the database (D1), the job queue and the static screens
emulated locally. The database is a SQLite file in `/var/lib/lof-crm/state`. **nginx** in front gives HTTPS
(Let's Encrypt). A cron job runs the 5-minute background jobs (SLA escalation, overdue items, LMS retries).

```
Internet ─▶ nginx :443 (HTTPS) ─▶ 127.0.0.1:8787 wrangler/workerd (pm2) ─▶ SQLite  /var/lib/lof-crm/state
                                         ▲ cron every 5 min
GitHub push ─▶ Actions: tests ─▶ ssh lofcrm@server  deploy/vps/remote-deploy.sh <commit>
```

| Where | What |
|---|---|
| `/opt/lof-crm` | the code (a git checkout of the repository) |
| `/etc/lof-crm/env` | settings and secrets (owner `root`, readable by `lofcrm`) |
| `/var/lib/lof-crm/state` | the database – **back this up** |
| `lofcrm` | the Linux user the CRM runs as and that GitHub Actions logs in as |

You need: an Ubuntu 22.04/24.04 or Debian 12 server with root access, at least 1 GB RAM, and a domain name whose
DNS **A record** points at the server (for example `crm.yourdomain.com`).

---

## 1. Set up the server (once)

SSH into the server as root (or a sudo user) and run:

```bash
curl -fsSL https://raw.githubusercontent.com/karthikeyan-trgdev/lof_crm/main/deploy/vps/server-setup.sh -o setup.sh
sudo DOMAIN=crm.yourdomain.com LETSENCRYPT_EMAIL=you@yourdomain.com ADMIN_EMAIL=you@yourdomain.com bash setup.sh
```

It asks for the administrator password (typed hidden, only a hash is stored), then:

1. installs Node.js 22, pm2, nginx, git and sqlite3,
2. creates the `lofcrm` user and an SSH key pair for GitHub Actions,
3. clones the repository into `/opt/lof-crm`,
4. writes `/etc/lof-crm/env` with fresh random secrets (only if missing),
5. builds, creates the database with master data only (no demo records or known passwords), and starts the CRM,
6. creates the administrator, installs the 5-minute cron job and the nginx site, and gets the HTTPS certificate.

Options: `DATA=demo` loads the prototype's sample data on first setup (a random demo password is printed once).
For a **private** repository use `REPO_URL=git@github.com:karthikeyan-trgdev/lof_crm.git`. The script prints a
public key: add it under the repo's *Settings → Deploy keys* (read-only), then run the script again.

The script is safe to run again. Existing data, secrets and logins are kept.

### Servers with CyberPanel (OpenLiteSpeed)

CyberPanel's OpenLiteSpeed already uses ports 80/443, so the script detects it (`/usr/local/lsws`) and does **not**
install nginx or certbot. OpenLiteSpeed proxies to the CRM instead:

1. CyberPanel → *Websites → Create Website* for the CRM domain, then *SSL → Manage SSL* to issue its certificate.
2. *Websites → List Websites → Manage* → **vHost Conf**: add the `extprocessor lofcrm { … }` block, and
   **Rewrite Rules**: paste the rules. Both are in [deploy/vps/openlitespeed-proxy.conf](deploy/vps/openlitespeed-proxy.conf)
   and are printed by the setup script.
3. Open `https://crm.yourdomain.com`. A 503 error means the CRM isn't running. Check with `sudo -u lofcrm pm2 status`.

**HTTPS with certbot** (instead of CyberPanel's *Issue SSL*): `DOMAIN=crm.yourdomain.com LETSENCRYPT_EMAIL=you@yourdomain.com bash /opt/lof-crm/deploy/vps/ssl-certbot.sh`
gets a free Let's Encrypt certificate, installs it in OpenLiteSpeed, redirects http to https, switches `APP_BASE_URL`
to https and sets up automatic renewal. certbot's timer renews it 30 days before expiry, and a hook restarts LiteSpeed
afterwards. Check renewal any time with `certbot renew --dry-run`.

The CRM takes the visitor's address from the rightmost `X-Forwarded-For` entry when the request comes from the
local proxy. Rate limits and the session log are then per visitor, not per proxy.

## 2. Connect GitHub (once)

At the end, the setup script prints what to add under the repository's *Settings → Secrets and variables →
Actions → New repository secret*:

| Secret | Value |
|---|---|
| `SSH_HOST` | your domain or the server IP |
| `SSH_USER` | `lofcrm` |
| `SSH_PRIVATE_KEY` | the full output of `sudo cat /home/lofcrm/.ssh/github_actions` (including the BEGIN/END lines) |
| `SSH_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 crm.yourdomain.com` |
| `SSH_PORT` | only if SSH is not on port 22 |

Then delete the private key from the server: `sudo rm /home/lofcrm/.ssh/github_actions`. The public half stays in
`authorized_keys`.

The workflow is [.github/workflows/deploy-vps.yml](.github/workflows/deploy-vps.yml). It runs on every push to
`main`, and you can also start it from *Actions → Deploy to VPS → Run workflow*. If the type check or tests fail,
nothing is deployed. The older *Deploy to Cloudflare* workflow is manual-only and is not affected.

## 3. First sign-in

Open `https://crm.yourdomain.com` and sign in with the administrator e-mail and password. You must choose a new
password and set up two-step verification. Then create staff logins in *Settings → Staff & user management*.

## 4. Integrations and settings

Edit `/etc/lof-crm/env` (`sudo nano /etc/lof-crm/env`), fill in a provider's secret (e.g. `LMS_TOKEN=…`), then
restart: `sudo -u lofcrm pm2 restart lof-crm`. Non-secret settings (`LMS_URL`, `TELR_STORE_ID`, `ERPNEXT_URL` …)
can also be added to the same file. It overrides `[vars]` in `wrangler.toml`. An integration runs live only when
it is enabled in *Settings → Integrations* **and** its secrets are set. Otherwise it stays in mock mode.

Never change `JWT_SECRET` once people use the CRM. Changing it signs everyone out and breaks two-step codes.

## 5. Day to day

```bash
sudo -u lofcrm pm2 status                    # is it running
sudo -u lofcrm pm2 logs lof-crm              # live logs
sudo -u lofcrm bash /opt/lof-crm/deploy/vps/remote-deploy.sh    # redeploy the latest main by hand
cd /opt/lof-crm && sudo -u lofcrm npx wrangler d1 execute lof_crm --local --persist-to /var/lib/lof-crm/state \
  --command "SELECT * FROM v_enrollments ORDER BY enrolled_on DESC LIMIT 20"     # SQL (views as in DEPLOY.md §4)
```

Each deployment stops the CRM for roughly 10–30 seconds (dependencies, migrations, restart).

**Backups.** There is no automatic point-in-time history like Cloudflare's. Back up the database yourself, for
example with a nightly root cron job:

```bash
0 2 * * * f=$(find /var/lib/lof-crm/state/v3/d1 -name '*.sqlite' ! -name 'metadata*' | head -1); sqlite3 "$f" ".backup '/var/backups/lof-crm-$(date +\%F).sqlite'"; find /var/backups -name 'lof-crm-*.sqlite' -mtime +30 -delete
```

Copy the backups off the server as well. *Settings → Database → Full backup (JSON)* still works too.

## 6. Good to know

- `wrangler`'s local runtime is Cloudflare's development server. It works for a single server, but it is not a
  product Cloudflare supports for production hosting. Watch the logs after updates, and keep the server patched.
- nginx blocks `/cdn-cgi/` from the internet. The local runtime has a data explorer and the cron trigger at that
  path, and only the cron job on `127.0.0.1` may use them. Do not open port 8787 in the firewall.
- Webhook addresses for Meta, WhatsApp, Exotel and Razorpay are `https://crm.yourdomain.com/webhooks/…`. The
  verify tokens are in `/etc/lof-crm/env`.

| Symptom | Fix |
|---|---|
| Action fails at *Deploy* with `Permission denied (publickey)` | `SSH_PRIVATE_KEY` is not the key from step 2, or `SSH_USER` is wrong |
| `Host key verification failed` | `SSH_KNOWN_HOSTS` is missing or old. Run `ssh-keyscan` again |
| Sign-in says *Sign-in from another site is not allowed* | `APP_BASE_URL` in `/etc/lof-crm/env` must be exactly `https://` + your domain |
| `/health` fails after a deploy | `sudo -u lofcrm pm2 logs lof-crm --lines 100` |
| 502 Bad Gateway | the CRM is not running: `sudo -u lofcrm pm2 restart lof-crm` |
