#!/usr/bin/env bash
# One-time setup of LOF CRM on an Ubuntu / Debian VPS. Run as root; safe to run again. See DEPLOY-VPS.md.
#
#   curl -fsSL https://raw.githubusercontent.com/karthikeyan-trgdev/lof_crm/main/deploy/vps/server-setup.sh -o setup.sh
#   sudo DOMAIN=crm.example.com LETSENCRYPT_EMAIL=you@example.com ADMIN_EMAIL=you@example.com bash setup.sh
#
# Env: DOMAIN (required), LETSENCRYPT_EMAIL (enables HTTPS), ADMIN_EMAIL (+ ADMIN_PASSWORD, asked if missing),
#      REPO_URL, DATA=masters|demo (first setup only), APP_USER=lofcrm, LOF_PORT=8787
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=crm.example.com}"
REPO_URL="${REPO_URL:-https://github.com/karthikeyan-trgdev/lof_crm.git}"
APP_USER="${APP_USER:-lofcrm}"
APP_DIR=/opt/lof-crm
STATE_DIR=/var/lib/lof-crm/state
ENV_DIR=/etc/lof-crm
ENV_FILE=$ENV_DIR/env
PORT="${LOF_PORT:-8787}"
DATA="${DATA:-masters}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }
step() { echo; echo "▶ $*"; }
as_app() { sudo -u "$APP_USER" -H env LOF_APP_DIR="$APP_DIR" LOF_STATE_DIR="$STATE_DIR" LOF_ENV_FILE="$ENV_FILE" LOF_PORT="$PORT" "$@"; }
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

step "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git nginx sqlite3 cron sudo >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pm2 >/dev/null || npm install -g pm2 --silent
echo "  node $(node -v), pm2 $(pm2 -v)"

step "App user $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/.ssh"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$STATE_DIR"
chown "$APP_USER:$APP_USER" /var/lib/lof-crm
install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"

step "Key for GitHub Actions"
KEY="$APP_HOME/.ssh/github_actions"
if [ ! -f "$KEY" ]; then
  as_app ssh-keygen -q -t ed25519 -N '' -C "github-actions@lof-crm" -f "$KEY"
  echo "  created"
fi
touch "$APP_HOME/.ssh/authorized_keys"
grep -qF "$(cat "$KEY.pub")" "$APP_HOME/.ssh/authorized_keys" || cat "$KEY.pub" >> "$APP_HOME/.ssh/authorized_keys"
chown "$APP_USER:$APP_USER" "$APP_HOME/.ssh/authorized_keys"; chmod 600 "$APP_HOME/.ssh/authorized_keys"

step "Code ($REPO_URL)"
if [ ! -d "$APP_DIR/.git" ]; then
  if [[ "$REPO_URL" == git@* ]]; then
    # Private repository: the server reads it with a deploy key
    [ -f "$APP_HOME/.ssh/id_ed25519" ] || as_app ssh-keygen -q -t ed25519 -N '' -C "lof-crm-server" -f "$APP_HOME/.ssh/id_ed25519"
    as_app bash -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'
    if ! as_app git ls-remote "$REPO_URL" >/dev/null 2>&1; then
      echo "  Add this as a read-only Deploy key (GitHub repo → Settings → Deploy keys), then run this script again:"
      echo; cat "$APP_HOME/.ssh/id_ed25519.pub"; exit 1
    fi
  fi
  as_app git clone --quiet "$REPO_URL" "$APP_DIR"
  echo "  cloned"
else
  echo "  already cloned"
fi

step "Settings and secrets ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# LOF CRM server settings – read by wrangler (--env-file). Overrides [vars] in wrangler.toml.
# Integrations stay in mock mode until they are enabled in Configuration AND their secrets below are filled in.
# After editing: pm2 restart lof-crm   (as $APP_USER)
APP_ENV=production
APP_BASE_URL=https://$DOMAIN
INTEGRATION_MODE=auto
ALLOW_IMPERSONATION=false
MFA_REQUIRED_ROLES="System Administrator,Management"
SESSION_IDLE_MINUTES=60
# Never change JWT_SECRET once in use – it signs everyone out and breaks two-step codes
JWT_SECRET=$(rand 64)
WEBSITE_FORM_SECRET=$(rand)
META_VERIFY_TOKEN=$(rand 24)
WHATSAPP_VERIFY_TOKEN=$(rand 24)
EXOTEL_WEBHOOK_TOKEN=$(rand 32)
META_APP_SECRET=
META_PAGE_ACCESS_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
LMS_TOKEN=
TELR_AUTH_KEY=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
ERPNEXT_API_KEY=
ERPNEXT_API_SECRET=
GCAL_SERVICE_ACCOUNT_JSON=
RESEND_API_KEY=
TURNSTILE_SECRET=
EOF
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  echo "  created with fresh random secrets"
else
  echo "  exists (kept)"
fi

step "Process manager"
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
echo "  pm2 starts the CRM on boot"

step "First deployment"
as_app bash "$APP_DIR/deploy/vps/remote-deploy.sh" --data "$DATA"

if [ -n "${ADMIN_EMAIL:-}" ]; then
  step "Administrator $ADMIN_EMAIL"
  email=$(printf '%s' "$ADMIN_EMAIL" | tr 'A-Z' 'a-z' | sed "s/'/''/g")
  found=$(as_app bash -c "cd $APP_DIR && npx wrangler d1 execute lof_crm --local --persist-to $STATE_DIR --json --command \"SELECT COUNT(*) AS n FROM staff_auth WHERE email='$email'\"" 2>/dev/null | grep -o '"n": *[0-9]*' | grep -o '[0-9]*$' || echo 0)
  if [ "${found:-0}" != 0 ]; then
    echo "  already exists – left unchanged (reset passwords from the CRM)"
  else
    if [ -z "${ADMIN_PASSWORD:-}" ]; then read -rsp "  Password (10+ characters, letters and numbers; changed at first sign-in): " ADMIN_PASSWORD; echo; fi
    tmp=$(sudo -u "$APP_USER" mktemp)
    (cd "$APP_DIR" && sudo -u "$APP_USER" -H env ADMIN_PASSWORD="$ADMIN_PASSWORD" node scripts/create-admin.mjs --email "$ADMIN_EMAIL" --name "${ADMIN_NAME:-System Administrator}" --must-change) > "$tmp"
    as_app pm2 stop lof-crm >/dev/null
    as_app bash -c "cd $APP_DIR && npx wrangler d1 execute lof_crm --local --persist-to $STATE_DIR --file $tmp" >/dev/null
    as_app pm2 start lof-crm >/dev/null
    rm -f "$tmp"
    echo "  ready – change the password and set up two-step verification at first sign-in"
  fi
fi

step "Background jobs (every 5 minutes)"
CRON_LINE="*/5 * * * * curl -fsS -o /dev/null 'http://127.0.0.1:$PORT/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*'"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'cdn-cgi/handler/scheduled' || true; echo "$CRON_LINE" ) | crontab -u "$APP_USER" -
echo "  installed"

step "nginx ($DOMAIN)"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/deploy/vps/nginx-lof-crm.conf" > /etc/nginx/sites-available/lof-crm
ln -sf /etc/nginx/sites-available/lof-crm /etc/nginx/sites-enabled/lof-crm
nginx -t -q && systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 'Nginx Full' >/dev/null; fi
if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -n --agree-tos --redirect -m "$LETSENCRYPT_EMAIL" -d "$DOMAIN"
else
  echo "  HTTP only – set LETSENCRYPT_EMAIL and run again for HTTPS (sign-in needs https://$DOMAIN)"
fi

cat <<EOF

✔ LOF CRM is set up at https://$DOMAIN

Connect GitHub Actions (repo → Settings → Secrets and variables → Actions → New repository secret):
  SSH_HOST         $DOMAIN   (or this server's IP)
  SSH_USER         $APP_USER
  SSH_PORT         22        (only if different)
  SSH_PRIVATE_KEY  the whole output of:  sudo cat $KEY
  SSH_KNOWN_HOSTS  the output of:        ssh-keyscan -t ed25519 $DOMAIN
After saving SSH_PRIVATE_KEY you may delete the private key file:  sudo rm $KEY
EOF
