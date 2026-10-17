#!/bin/sh
set -eu
data=/tmp/proxy-storage-test/data
sites=/tmp/proxy-storage-test/sites
mkdir -p "$data/control"
echo keep > "$data/control/existing-file"
chmod 0644 "$data/control/existing-file"
sh /checks/scripts/prepare-storage.sh "$data" "$sites"
test "$(stat -c '%u:%g:%a' "$data/control")" = '10001:10000:700'
test "$(stat -c '%u:%g:%a' "$data/edge")" = '10002:10000:700'
test "$(stat -c '%u:%g:%a' "$data/certificates")" = '10003:10000:700'
test "$(stat -c '%u:%g:%a' "$data/certificate-policy")" = '10001:10000:2750'
for dir in tls cert-status; do
  test "$(stat -c '%u:%g:%a' "$data/$dir")" = '10003:10000:2750'
done
test "$(stat -c '%u:%g:%a' "$data/cert-requests")" = '10003:10000:2770'
test "$(stat -c '%u:%a' "$data/control/existing-file")" = '0:644'
test "$(cat "$data/control/existing-file")" = keep
test -d "$sites"
if sh /checks/scripts/prepare-storage.sh /tmp/unsafe /tmp/unsafe/sites; then exit 1; fi
test ! -e /tmp/unsafe
echo 'PASS: Linux storage ownership, permissions, existing-file preservation and nested-path rejection.'
