#!/usr/bin/env bash
# Free Let's Encrypt HTTPS for LOF CRM on a CyberPanel / OpenLiteSpeed server, issued and renewed by certbot.
# Run as root; safe to run again. See DEPLOY-VPS.md.
#
#   DOMAIN=crm.example.com LETSENCRYPT_EMAIL=you@example.com bash deploy/vps/ssl-certbot.sh
#
# 1. lets /.well-known/ through to the site folder (certbot's webroot check), everything else to the CRM
# 2. certbot certonly --webroot   (certificate under /etc/letsencrypt/live/lofcrm-<domain>/)
# 3. OpenLiteSpeed: the site's vhssl block + a map on the :443 listener, then http → https redirect
# 4. renewal: certbot's own systemd timer / cron, with a deploy hook that restarts LiteSpeed for the new certificate
# 5. APP_BASE_URL=https://<domain> for the CRM (secure cookies, sign-in origin)
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=crm.example.com}"
EMAIL="${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL - Lets Encrypt sends expiry notices there}"
LSWS=/usr/local/lsws
VHOST_CONF="$LSWS/conf/vhosts/$DOMAIN/vhost.conf"
HTTPD_CONF="$LSWS/conf/httpd_config.conf"
WEBROOT="/home/$DOMAIN/public_html"
CERT_NAME="lofcrm-$DOMAIN"
LIVE="/etc/letsencrypt/live/$CERT_NAME"
ENV_FILE="${LOF_ENV_FILE:-/etc/lof-crm/env}"
APP_USER="${APP_USER:-lofcrm}"
PORT="${LOF_PORT:-8787}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }
[ -f "$VHOST_CONF" ] || { echo "No OpenLiteSpeed site for $DOMAIN ($VHOST_CONF) – create it in CyberPanel first"; exit 1; }
[ -d "$WEBROOT" ] || { echo "Missing $WEBROOT"; exit 1; }
step() { echo; echo "▶ $*"; }
stamp=$(date +%Y%m%d%H%M%S)

write_htaccess() {  # $1 = 1 to redirect http → https
  {
    echo "RewriteEngine On"
    echo "# wrangler's scheduled-event trigger and data explorer must never be public"
    echo 'RewriteRule ^/?(cdn-cgi/|__scheduled) - [F,L]'
    echo "# Let's Encrypt (certbot webroot) validation is served from this folder"
    echo 'RewriteRule ^/?\.well-known/acme-challenge/ - [L]'
    if [ "$1" = 1 ]; then
      echo 'RewriteCond %{HTTPS} !=on'
      echo 'RewriteRule ^(.*)$ https://%{HTTP_HOST}/$1 [R=301,L]'
    fi
    echo 'RewriteRule ^(.*)$ http://lofcrm/$1 [P,L]'
  } > "$WEBROOT/.htaccess"
  chown --reference="$WEBROOT" "$WEBROOT/.htaccess"
}

step "certbot"
command -v certbot >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null; }
certbot --version

step "Validation path /.well-known/acme-challenge/"
cp "$WEBROOT/.htaccess" "$WEBROOT/.htaccess.bak-$stamp" 2>/dev/null || true
write_htaccess 0
# CyberPanel maps /.well-known/acme-challenge to a shared folder with a vhost context
# (usually /usr/local/lsws/Example/html/.well-known/acme-challenge); otherwise it is the site folder
ACME_DIR=$(awk '/^context[ \t]+\/\.well-known\/acme-challenge/ {c=1; next} c && /^[ \t]*location[ \t]/ {print $2; exit} c && /^\}/ {c=0}' "$VHOST_CONF")
ACME_DIR="${ACME_DIR:-$WEBROOT/.well-known/acme-challenge}"
ACME_DIR="${ACME_DIR//\$VH_ROOT//home/$DOMAIN}"; ACME_DIR="${ACME_DIR//\$DOC_ROOT/$WEBROOT}"; ACME_DIR="${ACME_DIR//\$SERVER_ROOT/$LSWS}"
ACME_DIR="${ACME_DIR%/}"
case "$ACME_DIR" in
  */.well-known/acme-challenge) CHALLENGE_ROOT="${ACME_DIR%/.well-known/acme-challenge}" ;;
  *) echo "  /.well-known/acme-challenge is served from $ACME_DIR, which certbot's webroot mode cannot use"; exit 1 ;;
esac
echo "  served from $ACME_DIR"
mkdir -p "$ACME_DIR"; chmod 755 "$ACME_DIR"
echo ok > "$ACME_DIR/lofcrm-check"; chmod 644 "$ACME_DIR/lofcrm-check"
rm -rf "$WEBROOT/.well-known/acme-challenge/lofcrm-check"
systemctl restart lsws; sleep 3
if [ "$(curl -s "http://$DOMAIN/.well-known/acme-challenge/lofcrm-check")" != ok ]; then
  rm -f "$ACME_DIR/lofcrm-check"
  echo "  http://$DOMAIN/.well-known/acme-challenge/ is not served from $ACME_DIR – check DNS and the site's rewrite rules"; exit 1
fi
rm -f "$ACME_DIR/lofcrm-check"
echo "  reachable"

step "Certificate ($CERT_NAME)"
certbot certonly --webroot -w "$CHALLENGE_ROOT" -d "$DOMAIN" --cert-name "$CERT_NAME" \
  -m "$EMAIL" --agree-tos -n --keep-until-expiring
[ -f "$LIVE/fullchain.pem" ] || { echo "  certbot did not produce $LIVE"; exit 1; }

step "OpenLiteSpeed: certificate for the site"
cp "$VHOST_CONF" "$VHOST_CONF.bak-$stamp"
# drop any existing vhssl { … } block (e.g. from CyberPanel) and add ours
awk '/^vhssl[ \t]*\{/ {skip=1; next} skip && /^\}/ {skip=0; next} !skip' "$VHOST_CONF.bak-$stamp" > "$VHOST_CONF"
cat >> "$VHOST_CONF" <<EOF

vhssl  {
  keyFile                 $LIVE/privkey.pem
  certFile                $LIVE/fullchain.pem
  certChain               1
  sslProtocol             24
  enableECDHE             1
  renegProtection         1
  sslSessionCache         1
  enableSpdy              15
  enableStapling          1
  ocspRespMaxAge          86400
}
EOF
grep -q 'extprocessor lofcrm' "$VHOST_CONF" || cat >> "$VHOST_CONF" <<EOF

extprocessor lofcrm {
  type                    proxy
  address                 127.0.0.1:$PORT
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}
EOF
echo "  done (backup: $VHOST_CONF.bak-$stamp)"

step "OpenLiteSpeed: $DOMAIN on the HTTPS listener"
cp "$HTTPD_CONF" "$HTTPD_CONF.bak-$stamp"
awk -v d="$DOMAIN" '
  /^listener[ \t]/ { inb=1; blk=$0 "\n"; sec=0; has=0; next }
  inb && /^[ \t]*secure[ \t]+1/ { sec=1 }
  inb && /^[ \t]*map[ \t]/ { split($0, f, /[ \t]+/); for (i in f) if (f[i] == d || f[i] == d ",") has=1 }
  inb && /^\}/ { if (sec && !has) blk = blk "  map                     " d " " d "\n"; printf "%s%s\n", blk, $0; inb=0; next }
  inb { blk = blk $0 "\n"; next }
  { print }
' "$HTTPD_CONF.bak-$stamp" > "$HTTPD_CONF"
if grep -q '^[ \t]*secure[ \t]\+1' "$HTTPD_CONF"; then
  echo "  done (backup: $HTTPD_CONF.bak-$stamp)"
else
  echo "  no HTTPS listener found in $HTTPD_CONF – add one in CyberPanel (or issue any site SSL once), then run again"; exit 1
fi

step "Renewal"
HOOK=/etc/letsencrypt/renewal-hooks/deploy/lofcrm-restart-lsws.sh
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > "$HOOK" <<'EOF'
#!/bin/sh
# OpenLiteSpeed loads certificates at start – restart it after certbot renews one
systemctl restart lsws
EOF
chmod 755 "$HOOK"
if systemctl list-unit-files certbot.timer >/dev/null 2>&1 && systemctl list-unit-files certbot.timer | grep -q certbot.timer; then
  systemctl enable --now certbot.timer >/dev/null
  echo "  certbot.timer: $(systemctl is-active certbot.timer) (checks twice a day, renews 30 days before expiry)"
else
  echo "17 3,15 * * * root certbot renew -q" > /etc/cron.d/lofcrm-certbot
  echo "  cron: /etc/cron.d/lofcrm-certbot (checks twice a day, renews 30 days before expiry)"
fi
certbot renew --cert-name "$CERT_NAME" --dry-run -q && echo "  renewal dry run: ok"

step "Redirect http → https"
write_htaccess 1
systemctl restart lsws; sleep 3

step "CRM address"
sed -i "s#^APP_BASE_URL=.*#APP_BASE_URL=https://$DOMAIN#" "$ENV_FILE"
grep '^APP_BASE_URL=' "$ENV_FILE" | sed 's/^/  /'
sudo -u "$APP_USER" -H pm2 restart lof-crm >/dev/null
sleep 6

step "Check"
curl -fsS "https://$DOMAIN/health" && echo
echo "  expires: $(openssl x509 -enddate -noout -in "$LIVE/fullchain.pem" | cut -d= -f2)"
echo
echo "✔ https://$DOMAIN is live; certbot renews it automatically"
