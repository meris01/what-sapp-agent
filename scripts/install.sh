#!/usr/bin/env bash
#
# Installs the WhatsApp agent on a Linux server as a systemd service.
#
#   sudo ./scripts/install.sh
#
# Safe to run again on an existing install: it updates the code and restarts,
# and never touches the database, the WhatsApp session, or .env.

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-whatsapp-agent}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${SERVICE_NAME}}"
SERVICE_USER="${SERVICE_USER:-${SERVICE_NAME}}"
PORT="${PORT:-3000}"
TIMEZONE="${TZ:-UTC}"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '  %s\n' "$1"; }
rule() { printf '  %s\n' "------------------------------------------------"; }
die()  { printf '\n  ERROR: %s\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

printf '\n'; rule; say "Installing ${SERVICE_NAME}"; rule; printf '\n'

# --- prerequisites ---------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20 or newer first."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old. Version 20 or newer is required."
say "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is not installed."

# --- service account -------------------------------------------------------
if id "$SERVICE_USER" >/dev/null 2>&1; then
  say "user ${SERVICE_USER} already exists"
else
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  say "created service user ${SERVICE_USER}"
fi

# --- files -----------------------------------------------------------------
FIRST_INSTALL=1
[ -d "$INSTALL_DIR/data" ] && FIRST_INSTALL=0

mkdir -p "$INSTALL_DIR"

# Replace the code, leave data and .env exactly where they are.
for item in src public scripts package.json package-lock.json .env.example README.md COMPLIANCE.md VERSION; do
  [ -e "$SOURCE_DIR/$item" ] || continue
  rm -rf "${INSTALL_DIR:?}/$item"
  cp -R "$SOURCE_DIR/$item" "$INSTALL_DIR/$item"
done
say "copied application files to ${INSTALL_DIR}"

# Git does not always preserve the executable bit; make sure the follow-up
# script is runnable before anyone reaches for it.
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true

mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"
say "data directory locked to ${SERVICE_USER}"

# --- dependencies ----------------------------------------------------------
say "installing dependencies (this takes a minute)..."
sudo -u "$SERVICE_USER" env HOME="$INSTALL_DIR" npm ci --omit=dev --prefix "$INSTALL_DIR" >/dev/null 2>&1 \
  || die "npm ci failed. Run it by hand in ${INSTALL_DIR} to see why."
say "dependencies installed"

# --- service ---------------------------------------------------------------
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=WhatsApp AI Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=TZ=${TIMEZONE}
Environment=HOST=127.0.0.1
Environment=PORT=${PORT}

# The service only ever needs its own directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
say "systemd service installed"

# --- start -----------------------------------------------------------------
systemctl restart "$SERVICE_NAME"
sleep 4

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  printf '\n'
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
  die "The service did not start. The log above should say why."
fi

printf '\n'; rule; say "Running on http://127.0.0.1:${PORT}"; rule; printf '\n'

if [ "$FIRST_INSTALL" -eq 1 ]; then
  say "The dashboard password was printed once, just now. Read it with:"
  printf '\n      journalctl -u %s | grep -A 3 "shown once"\n\n' "$SERVICE_NAME"
fi

say "It listens on loopback only. To reach it from your laptop:"
printf '\n      ssh -N -L %s:127.0.0.1:%s %s@this-server\n\n' "$PORT" "$PORT" "${SUDO_USER:-you}"
say "Then open http://127.0.0.1:${PORT}"
printf '\n'
say "Useful commands:"
printf '      systemctl status %s\n' "$SERVICE_NAME"
printf '      journalctl -u %s -f\n' "$SERVICE_NAME"
printf '      systemctl restart %s\n\n' "$SERVICE_NAME"
say "Read COMPLIANCE.md before connecting a number that matters."
printf '\n'
