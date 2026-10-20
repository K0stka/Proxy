# Persistent log storage

The explicitly named Docker volume `proxy_logs` is external to Compose. It holds
the canonical application log history across container restarts, configuration
handovers, version updates and stack destruction, including `down --volumes`.
Recreating the stack reattaches it. Manual volume removal or disk loss still removes
the data; include this volume in backups.

All edge generations write to `/logs/edge/logs.db`, and all controllers write to
`/logs/control/logs.db`. SQLite WAL transactions serialize writers, and IDs and
retention budgets are shared per component. The current edge's log API sees the
combined history, including traffic completed by draining versions. The separate
databases/directories preserve role permissions: UID 10002 owns edge, UID 10001
owns control, and each directory is 0700. Controllers retrieve traffic through the
restricted Unix broker rather than reading the edge database directly.

The volume also contains `audit/events.jsonl`, `host/deployments.jsonl`, and
`host/updates/update-*.log`. Audit and deployment rotations remain configured;
the latest seven detailed update logs are retained. The application archives keep
their existing 30-day / 128 MiB event-data budget per component, plus SQLite/WAL
overhead. Persistence does not disable retention. Diagnostic Docker stdout/stderr
and the systemd journal remain engine/host-managed copies, not the Logs archive.

The root-owned `var-lib-proxylogs.mount` exposes the same volume at
`/var/lib/proxylogs` for host tools; it contains no second copy. Host updater,
deployment and management audits use this location. No Docker socket or additional
capability is given to application containers.

Exclude this bind alias from Komodo Periphery's disk statistics to avoid counting
the root filesystem twice. Add `/var/lib/proxylogs` to `exclude_disk_mounts` in
`/etc/komodo/periphery.config.toml`, preserving any existing exclusions, then
restart `periphery.service`. This restarts monitoring only, not proxy containers.
The VPS has this exclusion configured.

Before a fresh direct Compose deployment:

```sh
docker volume create proxy_logs
docker compose up -d --build
```

`PROXY_LOG_VOLUME` can select a different external volume for direct Compose.
The existing managed VPS uses the fixed `proxy_logs` name.

For the managed VPS, install the reviewed host integration as root:

```sh
docker volume create proxy_logs
mkdir -p /var/lib/proxylogs
install -m 0644 scripts/var-lib-proxylogs.mount /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now var-lib-proxylogs.mount
install -m 0755 scripts/proxy_log_storage.py /usr/local/lib/
systemctl stop proxy-handoff.service
python3 /usr/local/lib/proxy_log_storage.py prepare
install -m 0755 scripts/proxy-handoff.py /usr/local/lib/
install -m 0755 scripts/proxy-maintenance.py /usr/local/lib/
install -m 0644 scripts/proxy-handoff.service /etc/systemd/system/
install -m 0644 scripts/proxy-handoff.logrotate /etc/logrotate.d/proxy-handoff
systemctl daemon-reload
systemctl start proxy-handoff.service
```

Stopping the host broker leaves running traffic containers and IPVS routes intact.
Preparation imports surviving legacy databases and copies existing host/audit logs.
The root broker continues bounded incremental imports from legacy writers during
draining. Import cursors are recorded transactionally in the destination database,
so retries do not duplicate records. Before deleting a retiring generation, the
broker stops it to flush its buffer and performs the final import. Protected
migration backups live inside the same volume under `host/migration-backups`.
Previously deleted generation databases cannot be recovered by this migration.

The host mount unit currently targets Docker's default local-volume directory.
If moving Docker's data root, adjust its `What=` and verify the alias before restart.
Never copy a live SQLite `.db` alone: use SQLite's online backup API or stop all
writers and include its WAL/SHM files. An abrupt process crash can still lose the
last second of buffered events, and loopback UDP syslog is best effort.
