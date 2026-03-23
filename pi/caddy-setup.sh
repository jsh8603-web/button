#!/bin/bash
# Caddy reverse proxy setup for Raspberry Pi (automatic HTTPS)
# Usage: bash caddy-setup.sh <domain>
# Example: bash caddy-setup.sh mypc.duckdns.org
#
# Prerequisites:
#   - Duck DNS configured (run duckdns-setup.sh first)
#   - Router port forwarding: 80 + 443 → Pi IP

set -e

DOMAIN="$1"

if [ -z "$DOMAIN" ]; then
  echo "Usage: bash caddy-setup.sh <domain>"
  echo "Example: bash caddy-setup.sh mypc.duckdns.org"
  echo ""
  echo "Prerequisites:"
  echo "  1. Duck DNS configured (bash duckdns-setup.sh <subdomain> <token>)"
  echo "  2. Router port forwarding: 80 + 443 → Pi IP (TCP)"
  exit 1
fi

echo "Installing Caddy for ${DOMAIN}..."

# Install Caddy (official Debian/Ubuntu/Raspbian repo)
sudo apt-get update -qq
sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq caddy

# Create Caddyfile
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
${DOMAIN} {
    reverse_proxy localhost:7777
}
EOF

# Restart Caddy
sudo systemctl enable caddy
sudo systemctl restart caddy

# Wait for certificate
echo "Waiting for HTTPS certificate (may take 30-60 seconds)..."
sleep 10

# Verify
STATUS=$(sudo systemctl is-active caddy)
if [ "$STATUS" = "active" ]; then
  echo ""
  echo "Caddy setup complete!"
  echo "  HTTPS: https://${DOMAIN}"
  echo "  Reverse proxy: ${DOMAIN} → localhost:7777"
  echo "  Certificate: auto-renewed by Caddy (Let's Encrypt)"
  echo ""
  echo "Router port forwarding required:"
  echo "  80  → Pi IP (HTTP-01 challenge)"
  echo "  443 → Pi IP (HTTPS traffic)"
  echo ""
  echo "Old port 7777 forwarding can be removed."
  echo ""
  echo "Test: curl -I https://${DOMAIN}/health"
else
  echo ""
  echo "ERROR: Caddy failed to start."
  echo "Check: sudo journalctl -u caddy --no-pager -n 20"
  echo ""
  echo "Common issues:"
  echo "  - Port 80/443 not forwarded → certificate can't be issued"
  echo "  - Domain not resolving → check Duck DNS"
  exit 1
fi
