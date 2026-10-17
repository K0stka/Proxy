#!/bin/sh
set -eu
exec setpriv --reuid=10002 --regid=10000 --clear-groups --inh-caps=-all,+net_bind_service --ambient-caps=-all,+net_bind_service --bounding-set=-all,+net_bind_service --no-new-privs "$@"
