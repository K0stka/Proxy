#!/bin/sh
set -eu

fail() { echo "$*" >&2; exit 1; }
prepare() {
    [ -d "$1" ] && [ ! -L "$1" ] || fail "Storage directory unavailable: $1"
    chown -h "$2:10000" "$1"
    chmod "$3" "$1"
}

# Host paths are deployment inputs; reject ambiguous or overlapping public/private roots.
host_path() {
    value=$1
    while [ "${value%/}" != "$value" ]; do value=${value%/}; done
    case "$value" in /*) ;; *) fail 'Storage paths must be absolute and non-root' ;; esac
    case "$value/" in *'/../'*|*'/./'*|*'//'*) fail 'Use canonical storage paths without dot segments' ;; esac
    printf '%s' "$value"
}

role=$1
shift
case "$role" in
    control)
        if [ -n "${PROXY_DATA_PATH:-}${PROXY_SITES_PATH:-}" ]; then
            data=$(host_path "${PROXY_DATA_PATH:-}")
            sites=$(host_path "${PROXY_SITES_PATH:-}")
            case "$sites/" in "$data/"*) fail 'Keep sites outside private data' ;; esac
            case "$data/" in "$sites/"*) fail 'Keep data outside public sites' ;; esac
        fi
        prepare /state 10001 0700
        prepare /cert-policy 10001 2750
        prepare /cert-requests 10003 2770
        uid=10001
        ;;
    edge)
        prepare /runtime 10002 0700
        prepare /ipc 10002 2770
        exec proxy-as-edge "$@"
        ;;
    certificates)
        prepare /certbot 10003 0700
        prepare /tls 10003 2750
        prepare /cert-status 10003 2750
        prepare /cert-requests 10003 2770
        uid=10003
        ;;
    *) fail 'Unknown container role' ;;
esac
exec setpriv --reuid="$uid" --regid=10000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs "$@"
