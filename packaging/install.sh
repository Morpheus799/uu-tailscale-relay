#!/bin/sh
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[ "$(uname -s)" = Linux ] || { echo 'This package requires Linux.' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo sh install.sh.' >&2; exit 1; }
install_command=1
case "$#:${1-}" in
  0:) ;;
  1:--service-only) install_command=0 ;;
  *) echo 'Usage: sudo sh install.sh [--service-only]' >&2; exit 1 ;;
esac
[ -d /run/systemd/system ] || { echo 'The running system must use systemd.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node.js 22+ in the system PATH.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node.js 22+ is required.' >&2; exit 1; }
[ -x /usr/bin/tailscale ] || { echo 'Install Tailscale first.' >&2; exit 1; }
version=$(/usr/bin/tailscale version | head -n 1)
node -e 'const [a,b]=process.argv[1].split(".").map(Number);if (!(a>1 || a===1 && b>=104)) process.exit(1)' "$version" || {
  echo 'Install Tailscale 1.104+.' >&2; exit 1;
}

source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bundle=$source/relay.cjs
[ -f "$bundle" ] || bundle=$source/../dist/relay.cjs
output=$(dirname -- "$bundle")
notices=$output/THIRD_PARTY_LICENSES.txt
cli=$output/uurelay.cjs
[ -f "$bundle" ] && [ -f "$notices" ] && [ -f "$cli" ] || { echo 'Use a release archive or run npm ci and npm run build from source.' >&2; exit 1; }
node --check "$bundle"
node --check "$cli"

if [ "$install_command" -eq 1 ] && { [ -e /usr/local/bin/uurelay ] || [ -L /usr/local/bin/uurelay ]; }; then
  [ "$(readlink -- /usr/local/bin/uurelay)" = /opt/uu-tailscale-relay/uurelay.cjs ] || {
    echo 'A different uurelay already exists at /usr/local/bin/uurelay.' >&2
    exit 1
  }
fi

install -d -m 0755 /opt/uu-tailscale-relay
[ -d /etc/uu-tailscale-relay ] || install -d -m 0700 /etc/uu-tailscale-relay
[ -d /var/lib/uu-tailscale-relay ] || install -d -m 0700 /var/lib/uu-tailscale-relay
install -m 0644 "$bundle" /opt/uu-tailscale-relay/relay.cjs.next
mv -f /opt/uu-tailscale-relay/relay.cjs.next /opt/uu-tailscale-relay/relay.cjs
install -m 0755 "$cli" /opt/uu-tailscale-relay/uurelay.cjs.next
mv -f /opt/uu-tailscale-relay/uurelay.cjs.next /opt/uu-tailscale-relay/uurelay.cjs
if [ "$install_command" -eq 1 ]; then
  install -d -m 0755 /usr/local/bin
  ln -sfn /opt/uu-tailscale-relay/uurelay.cjs /usr/local/bin/uurelay
fi
install -m 0644 "$notices" /opt/uu-tailscale-relay/THIRD_PARTY_LICENSES.txt
install -m 0644 "$source/uu-tailscale-relay.service" /etc/systemd/system/uu-tailscale-relay.service
systemctl daemon-reload
printf '%s\n' 'Installed. Run sudo uurelay init.'
