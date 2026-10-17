#!/bin/sh
set -eu
ssh_root=${PROXY_GIT_SSH_PATH:-}
[ -n "$ssh_root" ] && [ -d "$ssh_root" ] || { echo 'Mount the VPS SSH directory using compose.ssh.yaml' >&2; exit 1; }
ssh_config=/dev/null
[ ! -f "$ssh_root/config" ] || ssh_config=$ssh_root/config
set -- -F "$ssh_config" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_root/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 "$@"
for key in id_ed25519 id_rsa id_ecdsa; do
  [ ! -f "$ssh_root/$key" ] || set -- -i "$ssh_root/$key" "$@"
done
exec ssh "$@"
