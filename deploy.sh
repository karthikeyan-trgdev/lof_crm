#!/usr/bin/env bash
# One-command deployment of LOF CRM to Cloudflare. Safe to run again for updates. See DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 22 first: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node.js 22 or newer is needed"; exit 1; }

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || read -rp "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID
[ -n "${CLOUDFLARE_API_TOKEN:-}" ]  || { read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN; echo; }
if [ -z "${ADMIN_EMAIL:-}" ]; then read -rp "Administrator e-mail (blank to skip on updates): " ADMIN_EMAIL; fi
if [ -n "${ADMIN_EMAIL:-}" ] && [ -z "${ADMIN_PASSWORD:-}" ]; then
  read -rsp "Administrator password (10+ characters, letters and numbers; changed at first sign-in): " ADMIN_PASSWORD; echo
fi
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN ADMIN_EMAIL ADMIN_PASSWORD

echo "▶ Installing and testing"
npm ci --no-audit --no-fund
npm run typecheck
npm test
node scripts/cf-deploy.mjs "$@"
