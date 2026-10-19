# Connection-preserving deployments

The VPS uses Linux IPVS to keep public IPs, DNS, ports and client source IPs intact.
UFW checks incoming traffic before IPVS dispatches it. A separate nftables input
guard drops direct remote access to the private generation addresses in
10.254.240.0/24. That range is also excluded from configurable backend destinations.
No application container receives Docker access or networking-administration capabilities.

Root's `proxy-handoff.service` listens only on the existing private Unix edge IPC
socket. Kernel peer credentials restrict application operations to the controller
UID; only a root peer can select version image IDs. The broker uses root-private,
fixed container templates and never accepts Docker options, paths or commands from
an application request. Candidates keep the existing read-only filesystem,
capability limits, non-root application users, resource limits and private mounts.

Configuration changes start a checked edge generation instead of reloading UDP
workers. Version updates start both a controller and an edge from tested images.
TLS, management isolation and readiness checks precede the switch. New flows use
the replacement; existing flows stay on their old generation. Failed switches
restore the previous destinations. Generation state survives broker restarts.

Old generations retire when their IPVS flow count reaches zero. At one hour they
are forcibly retired, interrupting any remaining flows. The deployment audit records
the generation, role, deadline policy and remaining count (null for pre-migration
connections that IPVS cannot count). At most 16 draining generations are allowed;
further changes fail safely rather than evicting active sessions prematurely.
The broker also refuses overlap when less than 512 MiB of memory is available.

Deployment audit: `/var/log/proxy-deployments.jsonl` and
`journalctl -u proxy-handoff.service`. Persistent management audit:
`/var/log/proxy-management-audit/events.jsonl`. Both files are private and rotated
for 14 archives. Application logs are available from the active container IDs in
`/var/lib/proxy-handoff/state.json`; that file and templates are root-only.
Compose's `proxy-control-1` and `proxy-edge-1` become unprivileged status agents
when `PROXY_HANDOFF_ENABLED=true` is set in the deployment environment. This keeps
ordinary Komodo builds/redeploys from replacing live traffic-handling generations.
Application version changes are activated only by the tested host updater.

Host prerequisites: `ipvsadm`, nftables and the kernel `ip_vs_rr` module. The
current deployment supports its single public IPv4 ingress address; other address
layouts fail closed and need explicit implementation/testing before use. It does
not change DNS, public UFW allow rules, Tailscale Serve, SSH or unrelated Docker
networks. Host/kernel restarts and incompatible database migrations still require
maintenance planning; an overlap cannot preserve processes across a host reboot.

The first migration tracks active UDP traffic through the old listener for at least
60 seconds before switching. Legacy TCP listeners are retained for the full hour
because connections established before IPVS was enabled are not in its counters.
Keep the deployment `.env` flag when changing Komodo's stored environment.

Isolated kernel regression test (root): `python3 scripts/test_handoff_network.py`.
It uses disposable network namespaces and synthetic traffic, never production
listeners. Unit tests cover peer authorization, input bounds, cutover ordering,
rollback and forced retirement. The normal application/container suites continue
to test the standalone deployment with handoff mode disabled.
