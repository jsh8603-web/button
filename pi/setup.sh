#!/bin/bash
# Run on Raspberry Pi to set up WOL relay as systemd service

set -e

APP_DIR="$HOME/wol-relay"
SERVICE_NAME="wol-relay"

echo "=== Setting up WOL relay ==="

# Copy files
mkdir -p "$APP_DIR"
cp wol-server.js package.json "$APP_DIR/"

# Create .env if not exists
if [ ! -f "$APP_DIR/.env" ]; then
  cp .env.example "$APP_DIR/.env"
  echo ">> Edit $APP_DIR/.env with your values!"
fi

# Create systemd service
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=WOL Magic Packet Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node wol-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl start ${SERVICE_NAME}

echo "=== Done! Status: ==="
sudo systemctl status ${SERVICE_NAME} --no-pager
