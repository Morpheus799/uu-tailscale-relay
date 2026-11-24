#!/bin/sh
set -eu
umask 022

case "${1-}" in
  ''|*[!0-9.a-zA-Z+~-]*) echo 'Expected a Debian package version.' >&2; exit 1 ;;
esac
[ "$#" -eq 1 ] || { echo 'Usage: sh packaging/build-deb.sh <version>' >&2; exit 1; }
version=$1
source=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
output=$source/dist

command -v dpkg-deb >/dev/null || { echo 'Install dpkg-deb first.' >&2; exit 1; }
for name in relay.cjs uurelay.cjs THIRD_PARTY_LICENSES.txt; do
  [ -f "$output/$name" ] || { echo "Build dist/$name first with npm run build." >&2; exit 1; }
done

stage=$(mktemp -d "${TMPDIR:-/tmp}/uu-tailscale-relay-deb.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
tree=$stage/package
install -d -m 0755 "$tree/DEBIAN" "$tree/opt/uu-tailscale-relay" "$tree/usr/bin" \
  "$tree/usr/lib/systemd/system" "$tree/usr/share/doc/uu-tailscale-relay"
install -m 0644 "$output/relay.cjs" "$output/THIRD_PARTY_LICENSES.txt" "$tree/opt/uu-tailscale-relay/"
install -m 0755 "$output/uurelay.cjs" "$tree/opt/uu-tailscale-relay/"
ln -s /opt/uu-tailscale-relay/uurelay.cjs "$tree/usr/bin/uurelay"
install -m 0644 "$source/packaging/uu-tailscale-relay.service" "$tree/usr/lib/systemd/system/"
install -m 0644 "$source/README.md" "$source/LICENSE" "$source/packaging/config.example.json" \
  "$tree/usr/share/doc/uu-tailscale-relay/"
install -m 0755 "$source/packaging/debian/postinst" "$source/packaging/debian/prerm" \
  "$source/packaging/debian/postrm" "$tree/DEBIAN/"
sed "s/@VERSION@/$version/g" "$source/packaging/debian/control" >"$tree/DEBIAN/control"

package=uu-tailscale-relay_${version}_all.deb
dpkg-deb --root-owner-group --build "$tree" "$stage/$package"
cp "$stage/$package" "$output/$package"
(cd "$output" && sha256sum "$package" >"$package.sha256")
printf '%s\n' "$output/$package"
