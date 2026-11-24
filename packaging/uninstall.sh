#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo sh uninstall.sh.' >&2; exit 1; }
if [ -f /etc/systemd/system/uu-tailscale-relay-update.timer ]; then
  systemctl disable --now uu-tailscale-relay-update.timer
fi
if [ -f /etc/systemd/system/uu-tailscale-relay.service ]; then
  systemctl disable --now uu-tailscale-relay.service
  rm -f /etc/systemd/system/uu-tailscale-relay.service
  systemctl daemon-reload
fi
if [ -L /usr/local/bin/uurelay ] && [ "$(readlink -- /usr/local/bin/uurelay)" = /opt/uu-tailscale-relay/uurelay.cjs ]; then
  rm -f /usr/local/bin/uurelay
fi
rm -f /opt/uu-tailscale-relay/relay.cjs /opt/uu-tailscale-relay/uurelay.cjs /opt/uu-tailscale-relay/THIRD_PARTY_LICENSES.txt
rmdir /opt/uu-tailscale-relay 2>/dev/null || true
printf '%s\n' 'Service removed. Configuration and credential state remain in /etc/uu-tailscale-relay and /var/lib/uu-tailscale-relay.'
