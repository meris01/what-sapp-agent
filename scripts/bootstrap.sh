#!/usr/bin/env bash
#
# One command, from a bare server to a working HTTPS dashboard.
#
#   curl -fsSL https://raw.githubusercontent.com/meris01/what-sapp-agent/main/scripts/bootstrap.sh | bash -s chat.example.com
#
# Or without a domain, to reach it over an SSH tunnel instead:
#
#   curl -fsSL .../bootstrap.sh | bash
#
# Installs Node if it is missing, fetches the code, installs the service, and
# puts a certificate in front of it. Safe to run again: it updates and
# restarts, and never touches the database, the WhatsApp session or .env.

set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/meris01/what-sapp-agent.git}"
SOURCE_DIR="${SOURCE_DIR:-/opt/whatsapp-agent-src}"
SERVICE_NAME="${SERVICE_NAME:-whatsapp-agent}"
NODE_MAJOR_REQUIRED=20
NODE_INSTALL_VERSION=22

say()  { printf '  %s\n' "$1"; }
rule() { printf '  ------------------------------------------------\n'; }
die()  { printf '\n  ERROR: %s\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root, or with sudo."

printf '\n'; rule; say "WhatsApp Agent - setting up"; rule; printf '\n'

# --- packages ---------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
# Stops apt opening the "which services to restart" dialogue mid-run.
export NEEDRESTART_MODE=a

say "updating package lists..."
apt-get update -qq >/dev/null 2>&1 || die "apt-get update failed."
apt-get install -y -qq git curl ca-certificates build-essential python3 >/dev/null 2>&1 || die "could not install prerequisites."
say "git, curl and build tools ready"

# --- node -------------------------------------------------------------------
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$CURRENT" -ge "$NODE_MAJOR_REQUIRED" ] && NODE_OK=1
fi

if [ "$NODE_OK" -eq 1 ]; then
  say "node $(node -v) already installed"
else
  say "installing node ${NODE_INSTALL_VERSION} (a minute or so)..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_VERSION}.x" | bash - >/dev/null 2>&1 \
    || die "could not add the NodeSource repository."
  apt-get install -y -qq nodejs >/dev/null 2>&1 || die "could not install nodejs."
  say "node $(node -v) installed"
fi

# --- code -------------------------------------------------------------------
if [ -d "$SOURCE_DIR/.git" ]; then
  say "updating the code..."
  git -C "$SOURCE_DIR" fetch --quiet origin
  git -C "$SOURCE_DIR" reset --hard --quiet origin/main
else
  say "downloading the code..."
  rm -rf "$SOURCE_DIR"
  git clone --quiet --depth 1 "$REPO" "$SOURCE_DIR" || die "could not clone ${REPO}."
fi
chmod +x "$SOURCE_DIR"/scripts/*.sh 2>/dev/null || true
say "code ready in ${SOURCE_DIR}"

# --- install ----------------------------------------------------------------
printf '\n'
"$SOURCE_DIR/scripts/install.sh"

# --- https ------------------------------------------------------------------
if [ -n "$DOMAIN" ]; then
  printf '\n'
  "$SOURCE_DIR/scripts/setup-https.sh" "$DOMAIN"
else
  printf '\n'; rule; say "No domain given, so it stays on loopback."; rule; printf '\n'
  say "Reach it from your own machine with:"
  printf '\n      ssh -N -L 3000:127.0.0.1:3000 root@%s\n\n' "$(hostname -I 2>/dev/null | awk '{print $1}')"
  say "...then open http://127.0.0.1:3000"
  printf '\n'
  say "To add a certificate later, point a subdomain here and run:"
  printf '\n      sudo %s/scripts/setup-https.sh your-subdomain.example.com\n\n' "$SOURCE_DIR"
fi
