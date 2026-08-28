#!/usr/bin/env bash
#
# Puts the dashboard on a real HTTPS URL, using Caddy for the certificate.
#
#   sudo ./scripts/setup-https.sh dashboard.example.com
#
# Run this after install.sh. The agent keeps listening on loopback; Caddy
# terminates TLS and forwards to it, so the dashboard is never served over
# plain HTTP and the password never crosses the wire in the clear.
#
# You need a domain (or subdomain) with an A record already pointing at this
# server. Let's Encrypt cannot issue a certificate for a bare IP address.

set -euo pipefail

DOMAIN="${1:-}"
SERVICE_NAME="${SERVICE_NAME:-whatsapp-agent}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${SERVICE_NAME}}"
PORT="${PORT:-3000}"

say()  { printf '  %s\n' "$1"; }
rule() { printf '  ------------------------------------------------\n'; }
die()  { printf '\n  ERROR: %s\n\n' "$1" >&2; exit 1; }

if [ -z "$DOMAIN" ]; then
  cat <<'USAGE'

  Usage: sudo ./scripts/setup-https.sh your-domain.com

  You need a domain pointing at this server. Add an A record for it with
  your DNS provider, wait a minute for it to propagate, then run this.

  No domain? Do not expose the dashboard over plain HTTP - the password
  would travel in clear. Reach it over an SSH tunnel instead:

      ssh -N -L 3000:127.0.0.1:3000 root@this-server

  ...then open http://127.0.0.1:3000 on your own machine.

USAGE
  exit 1
fi

printf '\n'; rule; say "Setting up HTTPS for ${DOMAIN}"; rule; printf '\n'

# --- sanity: is the agent actually running? --------------------------------
systemctl is-active --quiet "$SERVICE_NAME" \
  || die "${SERVICE_NAME} is not running. Run scripts/install.sh first."
say "${SERVICE_NAME} is running"

# --- does the domain point here? -------------------------------------------
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || echo '')"

if [ -n "$SERVER_IP" ] && [ -n "$DOMAIN_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  printf '\n'
  say "WARNING: ${DOMAIN} resolves to ${DOMAIN_IP}, but this server is ${SERVER_IP}."
  say "The certificate will fail until the A record points here."
  printf '\n'
  read -r -p "  Carry on anyway? [y/N] " reply
  case "$reply" in [yY]*) ;; *) exit 1 ;; esac
elif [ -n "$DOMAIN_IP" ]; then
  say "${DOMAIN} points at this server"
fi

# --- Caddy ------------------------------------------------------------------
if command -v caddy >/dev/null 2>&1; then
  say "caddy already installed"
else
  say "installing caddy..."
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  say "caddy installed"
fi

# --- reverse proxy ----------------------------------------------------------
cat > /etc/caddy/Caddyfile <<CADDY
# Managed by scripts/setup-https.sh

${DOMAIN} {
    reverse_proxy 127.0.0.1:${PORT}

    encode gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
}
CADDY

systemctl reload caddy 2>/dev/null || systemctl restart caddy
say "caddy configured for ${DOMAIN}"

# --- the app needs to know it is behind a proxy -----------------------------
# Without these the session cookie is not marked Secure and rate limits see
# the proxy's address rather than the real client.
mkdir -p "/etc/systemd/system/${SERVICE_NAME}.service.d"
cat > "/etc/systemd/system/${SERVICE_NAME}.service.d/proxy.conf" <<UNIT
[Service]
Environment=TRUST_PROXY=true
Environment=COOKIE_SECURE=true
UNIT

systemctl daemon-reload
systemctl restart "$SERVICE_NAME"
say "agent restarted behind the proxy"

# --- firewall ---------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  say "opened ports 80 and 443"
fi

# --- wait for the certificate ----------------------------------------------
say "waiting for the certificate..."
for _ in $(seq 1 20); do
  if curl -fsS --max-time 5 "https://${DOMAIN}/login" >/dev/null 2>&1; then
    printf '\n'; rule; say "Live at https://${DOMAIN}"; rule; printf '\n'
    say "Sign in with the username and password in ${INSTALL_DIR}/.env"
    printf '\n'
    say "The dashboard is now on the public internet behind one password."
    say "Make sure it is a strong one."
    printf '\n'
    exit 0
  fi
  sleep 5
done

printf '\n'
say "It is not answering on https://${DOMAIN} yet."
say "Certificates can take a minute. Check with:"
printf '\n      journalctl -u caddy -n 40 --no-pager\n\n'
say "The usual cause is the A record not pointing at this server yet."
printf '\n'
