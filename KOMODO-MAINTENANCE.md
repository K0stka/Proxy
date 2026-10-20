# Komodo maintenance

The Proxy Repo tracks K0stka/Proxy main on K0stkaVPS. Update Proxy runs daily at
04:15 Europe/Prague, or manually from Procedures. It pulls the Repo and invokes
the fixed root updater through a Komodo Action. Build/test output and failure
status appear in Komodo. Only passing images are handed over; failed deployment
health checks restore the previous images. The systemd update timer is disabled.
Rollback also restores the previous root-owned controller/edge environment before
starting the old images. Seven local recovery snapshots include those templates.
The Stack environment remains managed in Komodo. Before building, the Procedure
syncs it to the linked checkout; the fixed root helper copies it privately into
the independent build checkout at /etc/komodo/stacks/proxy. This keeps later UI
inventory refreshes from changing a build's source or environment mid-run.

The proxy Stack links directly to the Proxy Repo resource on main and uses its
compose.komodo.yaml. No commit pin or GitHub CI success is required. It includes the root-owned
/var/lib/proxy-handoff/compose.json, listing actual active and draining containers,
files, and certificates. Private environment files remain under that root-only
directory. Compose inventory deployments use --no-recreate --no-build --pull never
and select files/certificates only; they never replace live traffic generations.
Use Update Proxy for application version updates. Ordinary Stack Deploy refreshes
inventory only. The Repo and Stack both track main; actual runtime source revisions
remain visible in container names and the updater's last-success record.

New generation names are edge-<six-character-commit>-<counter> and
control-<six-character-commit>-<counter>. Counters start at zero per role and commit,
increase persistently, and skip occupied names. Multiple draining versions remain
supported, subject to the existing memory and generation limits. Old containers
retire when idle, or forcibly after one hour.
Idle retirement allows 30 seconds for Komodo metadata to settle, extending that
window during an active update but never beyond the original one-hour deadline.
Only draining generations are excluded from aggregate Stack health checks; active
edge/controller and infrastructure remain checked. Generation health exclusions
are maintained by Refresh Proxy Stack so expected retirement does not cause a
false unhealthy alert. Other manually configured exclusions are retained.

Force Retire Old Proxy Containers is manual only. It removes only broker-recorded
draining generations, refuses active generations, and audits remaining connection
counts. Running it can disconnect sessions on those old versions. It never runs a
Docker prune or selects containers by a broad name pattern.

Refresh Proxy Stack is a supporting Action. A root-only HMAC webhook requests it
after runtime membership changes, so UI config changes and automatic retirement
also update Komodo's service list. The VPS holds only this Action's webhook secret,
not a Komodo administrative API key. API access is over the existing Tailscale link.

## Components that run directly on the VPS

- Docker daemon and Komodo Periphery (existing services).
- proxy-handoff.service running /usr/local/lib/proxy-handoff.py as root: fixed
  container templates, private loopback aliases, IPVS switching, the nftables
  direct-access guard, certificate-triggered edge handovers, and retirement.
- proxy-generations.slice: shared memory/process limits for overlapping versions.
- /usr/local/lib/proxy-security-update.py: invoked by Komodo, not a scheduler;
  backs up SQLite, builds/tests images, activates and verifies them, and rolls back.
- /usr/local/lib/proxy-maintenance.py and komodo_inventory.py: fixed root commands
  and actual-container Compose inventory/webhook publication.
- var-lib-proxylogs.mount: exposes the external proxy_logs named volume at
  /var/lib/proxylogs for host tools. This is a bind alias to the same data.
- /usr/local/lib/proxy_log_storage.py: imports surviving legacy log records,
  including final records before a retiring generation is deleted. Import workers
  drop to the owning application UID; SQLite WAL files keep the correct owner.
- Existing Ubuntu unattended security upgrades and logrotate. Host/Docker restarts
  still require maintenance; generation handoffs cannot survive a host reboot.

Root scripts, templates, state and webhook settings are host administrator-owned;
application containers receive no Docker socket, network-admin capability or
Komodo write credentials. Host script changes require administrator installation;
ordinary application updates do not silently replace privileged host programs.

Detailed update output: /var/lib/proxylogs/host/updates/update-*.log (root-only, latest seven
runs). Komodo receives the log path and at most the last 16 KB, so verbose Docker
progress cannot overflow its execution document. The updater checks the fetched
`main` revision against the last successful revision before inspecting containers
or creating backups; when unchanged, it exits without building or deploying.
Consequently, upstream base-image and OS package refreshes happen when a new
repository revision is processed, rather than on no-change daily runs. Docker
reuses unchanged layers between update runs.

Deployment audit: /var/lib/proxylogs/host/deployments.jsonl. Management audit:
/var/lib/proxylogs/audit/events.jsonl. Traffic and administration archives:
/var/lib/proxylogs/edge/logs.db and /var/lib/proxylogs/control/logs.db. The Stack
declares proxy_logs external, so Compose destroy, even with volumes, retains it.
See [log storage](LOG-STORAGE.md) for migration and lifecycle details. Broker diagnostics:
journalctl -u proxy-handoff.service. Local snapshots retain seven SQLite backups
and the previous image set; off-server backup remains a separate responsibility.

A Komodo Builder selects the server where Komodo Build/Repo build jobs execute;
it uses that server's Docker daemon, CPU and RAM and provides no extra isolation.
These Actions use Periphery's server commands, so no additional Builder is needed.
