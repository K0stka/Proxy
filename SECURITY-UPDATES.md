# Security maintenance

The public management hostname serves only trusted application content. Its error
responses never load the configurable website error bundles. Ordinary websites
keep their custom error pages. Public authentication POSTs are limited by NGINX
using the actual TCP client address; forwarded headers cannot choose this key.
The controller adds a separate global ceiling of 1,000 authentication requests
per minute per management origin. Private Tailscale access retains that ceiling.

Recovery and passkey removal revoke sessions, device links, pending authentication
and enrollment challenges across both management origins. Administrative audit
events go to the controller's rotated Docker logs. Events contain only operation,
time, method, management origin, and status; bodies and credentials are excluded.

## Automatic updates

The VPS uses [connection-preserving handoffs](HANDOFF.md), orchestrated by the
Komodo Update Proxy Procedure. Its Stack lists real application generations.
The tested updater activates them through the root-only broker operation. Public
firewall checks still precede traffic dispatch. Old flows drain for at most one
hour, with forced retirement recorded in persistent audit logs.

Dependabot opens daily npm minor/patch updates. GitHub Actions runs the application
checks and isolated container suite. A separate privileged workflow merges only a
successful, current Dependabot revision that changes package.json/package-lock.json.
It never checks out or executes PR code with its write token. Dependency build tests
run as a non-root user with root-owned orchestration files. Major npm updates
remain manual. GitHub Actions and Dependabot must be enabled for the repository.

The Komodo Procedure runs daily at 04:15 Europe/Prague. The former systemd update
timer is disabled. It fetches main, creates a private candidate source tree, pulls current
Node 26 / Alpine 3.24, official stable NGINX, and Certbot images, upgrades Alpine packages, and rebuilds all
four services. Node's major version and Alpine's release remain selected explicitly;
Certbot follows its upstream latest image. New images must pass application, build,
startup privilege, NGINX, certificate, and Compose integration tests before deployment.
Tests use isolated networks, synthetic credentials, and disposable proxy-smoke volumes.

The job retains previous image IDs and a consistent online SQLite backup, refuses
dirty checkouts/concurrent deployments, and verifies container health, private login
availability, public authentication enforcement, and custom asset isolation. A failed
deployment restores the previous images. It does not restore the database over live
administrative changes. Future incompatible database migrations need a separate
migration/rollback procedure. Seven private recovery snapshots are retained, and the
latest successful image set remains tagged as proxy-rollback-<service>:latest.
These local snapshots are not a substitute for off-server encrypted backups.

This updater targets the repository-backed `proxy` project using compose.paths.yaml
and its protected .env. It does not overwrite Komodo's environment configuration.
Use Update Proxy in Komodo for immediate updates. Its Actions stream the fixed
host updater's output and propagate failures. Ordinary registry polling does not
rebuild these locally built images or run their tests. See
[Komodo maintenance](KOMODO-MAINTENANCE.md) for installed host components and workflow.

Install on the VPS as root after checking the repository:

```sh
install -m 0755 scripts/security-update.py /usr/local/lib/proxy-security-update.py
install -m 0644 scripts/proxy-security-update.service /etc/systemd/system/
install -m 0644 scripts/proxy-security-update.timer /etc/systemd/system/
systemctl daemon-reload
# Standalone scheduling only; do not enable alongside the Komodo Procedure.
# systemctl enable --now proxy-security-update.timer
```

Run immediately with `systemctl start proxy-security-update.service`. Inspect
`journalctl -u proxy-security-update.service` and
`/var/lib/proxy-security-updates/last-success.json`. Failures leave a failed systemd
unit and preserve the existing deployment or trigger image rollback. Run this trusted
script only as an administrator: building images and using Docker grant host privileges.

Accepted deployment exceptions: staging upstream HTTP and the existing mounted SSH
key remain unchanged. Other workloads' resource limits and UDP/firewall investigation
are outside this change. Temporary Tailscale/root authorization remains operator-managed.
