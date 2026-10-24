#!/usr/bin/env bash
# Updates LOF CRM on the VPS to a commit of the GitHub repository. Run as the app user (default: lofcrm) –
# GitHub Actions calls it over SSH on every push to main; you can also run it by hand. Safe to run again:
# data, logins and secrets are kept, and only new migrations are applied. See DEPLOY-VPS.md.
#
#   bash deploy/vps/remote-deploy.sh [commit-sha] [--data masters|demo]
set -euo pipefail
{ # parsed in full before it runs, so the `git reset` below can safely replace this file

APP_DIR="${LOF_APP_DIR:-/opt/lof-crm}"
STATE_DIR="${LOF_STATE_DIR:-/var/lib/lof-crm/state}"
ENV_FILE="${LOF_ENV_FILE:-/etc/lof-crm/env}"
BRANCH="${LOF_BRANCH:-main}"
PORT="${LOF_PORT:-8787}"
REF=""; DATA="masters"
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2 ;;
    *) REF="$1"; shift ;;
  esac
done
export LOF_STATE_DIR="$STATE_DIR" LOF_ENV_FILE="$ENV_FILE" LOF_PORT="$PORT" WRANGLER_SEND_METRICS=false CI=1

cd "$APP_DIR"
step() { echo; echo "▶ $*"; }
[ -r "$ENV_FILE" ] || { echo "Missing $ENV_FILE – run deploy/vps/server-setup.sh first"; exit 1; }

step "Code"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "${REF:-origin/$BRANCH}"
git clean -fdq -e node_modules -e .wrangler
git log -1 --format='  %h %s (%an, %ar)'

step "Stopping the CRM"
pm2 stop lof-crm >/dev/null 2>&1 && echo "  stopped" || echo "  not running yet"

step "Dependencies"
npm ci --no-audit --no-fund --loglevel=error

step "Frontend"
node scripts/patch-frontend.mjs

step "Database"
mkdir -p "$STATE_DIR"
seeded=$(npx wrangler d1 execute lof_crm --local --persist-to "$STATE_DIR" --json \
  --command "SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0002_seed.sql'" 2>/dev/null | grep -o '"n": *[0-9]*' | grep -o '[0-9]*$' || true)
if [ "${seeded:-0}" = 0 ]; then
  # First setup only: the committed seed holds demo logins with a published password, so it is always rebuilt.
  # masters = branches, programmes, fees, staff (random passwords) and settings; demo = the prototype's sample data.
  if [ "$DATA" = demo ]; then
    DEMO_PASSWORD="Lof-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)7"
    DEMO_PASSWORD="$DEMO_PASSWORD" node scripts/build-seed.mjs
    echo "  demo staff password (shown once): $DEMO_PASSWORD"
  else
    node scripts/build-seed.mjs --masters-only
  fi
fi
npx wrangler d1 migrations apply lof_crm --local --persist-to "$STATE_DIR"
git checkout --quiet -- migrations   # keep the working tree identical to the commit

step "Starting the CRM"
pm2 startOrReload deploy/vps/ecosystem.config.cjs --update-env >/dev/null
pm2 save >/dev/null

step "Health check"
for _ in $(seq 1 30); do
  if body=$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null); then echo "  $body"; echo; echo "✔ LOF CRM updated"; exit 0; fi
  sleep 2
done
echo "✘ /health did not answer – last log lines:"; pm2 logs lof-crm --lines 40 --nostream || true
exit 1
}
