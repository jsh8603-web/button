#!/bin/bash
# Duck DNS auto-update setup for Raspberry Pi
# Usage: bash duckdns-setup.sh <domain> <token>
# Example: bash duckdns-setup.sh mypc abc123-token

set -e

DOMAIN="$1"
TOKEN="$2"

if [ -z "$DOMAIN" ] || [ -z "$TOKEN" ]; then
  echo "Usage: bash duckdns-setup.sh <domain> <token>"
  echo ""
  echo "1. Go to https://www.duckdns.org and sign in"
  echo "2. Create a subdomain (e.g., 'mypc' → mypc.duckdns.org)"
  echo "3. Copy the token from the top of the page"
  echo "4. Run: bash duckdns-setup.sh mypc your-token-here"
  exit 1
fi

echo "Setting up Duck DNS: ${DOMAIN}.duckdns.org"

# Create update script
sudo mkdir -p /opt/duckdns
sudo tee /opt/duckdns/duck.sh > /dev/null << EOF
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=" | curl -k -o /var/log/duckdns/duck.log -K -
EOF
sudo chmod 700 /opt/duckdns/duck.sh

# Create log directory
sudo mkdir -p /var/log/duckdns

# Add cron job (every 5 minutes)
CRON_LINE="*/5 * * * * /opt/duckdns/duck.sh >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v duckdns; echo "$CRON_LINE") | crontab -

# Run once to verify
echo "Testing DNS update..."
sudo /opt/duckdns/duck.sh
RESULT=$(cat /var/log/duckdns/duck.log)

if [ "$RESULT" = "OK" ]; then
  echo ""
  echo "Duck DNS setup complete!"
  echo "  Domain: ${DOMAIN}.duckdns.org"
  echo "  Update: every 5 minutes via cron"
  echo "  Log: /var/log/duckdns/duck.log"
  echo ""
  echo "Test: curl https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=&verbose=true"
else
  echo ""
  echo "ERROR: DNS update failed (result: ${RESULT})"
  echo "Check your domain and token, then try again."
  exit 1
fi
