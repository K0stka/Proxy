#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 2 ]; then
  echo 'Usage: sudo sh scripts/prepare-storage.sh /absolute/data/path /absolute/sites/path' >&2
  exit 1
fi
data=${1%/}
sites=${2%/}
case "$data" in /*) ;; *) echo 'Data path must be absolute' >&2; exit 1 ;; esac
case "$sites" in /*) ;; *) echo 'Sites path must be absolute' >&2; exit 1 ;; esac
case "$data/" in "$sites/"*) echo 'Keep sites outside the private data directory' >&2; exit 1 ;; esac
case "$sites/" in "$data/"*) echo 'Keep sites outside the private data directory' >&2; exit 1 ;; esac

install -d -m 0700 "$data"
install -d -o 10001 -g 10000 -m 0700 "$data/control"
install -d -o 10001 -g 10000 -m 2750 "$data/certificate-policy"
install -d -o 10002 -g 10000 -m 0700 "$data/edge"
install -d -o 10003 -g 10000 -m 0700 "$data/certificates"
install -d -o 10003 -g 10000 -m 2750 "$data/tls" "$data/cert-status"
install -d -o 10003 -g 10000 -m 2770 "$data/cert-requests"
if [ ! -d "$sites" ]; then install -d -m 0755 "$sites"; fi
echo 'Storage directories ready. Existing files were not moved or changed.'
