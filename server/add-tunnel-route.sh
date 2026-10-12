#!/bin/sh
# Adds hunt.tradersedges.net to the Cloudflare Tunnel on this server.
# Run with sudo. Backs up the config, validates, and restores it on failure.
set -e
CONF=/etc/cloudflared/config.yml
HOST=hunt.tradersedges.net
if grep -q "hostname: $HOST" "$CONF"; then
  echo "$HOST is already in $CONF"
else
  BAK="$CONF.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CONF" "$BAK"
  # New rule goes just above the catch-all 404 rule
  sed -i "s|^  - service: http_status:404|  - hostname: $HOST\n    service: http://127.0.0.1:8095\n  - service: http_status:404|" "$CONF"
  if ! cloudflared tunnel --config "$CONF" ingress validate; then
    cp "$BAK" "$CONF"
    echo "Validation failed; restored $CONF from $BAK" >&2
    exit 1
  fi
  echo "Added $HOST (backup: $BAK)"
fi
systemctl restart cloudflared
sleep 2
systemctl is-active cloudflared
