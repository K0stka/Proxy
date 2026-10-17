# Proxy

A private routing workspace for a public VPS and home services connected through Tailscale. One Komodo stack: **NGINX edge + management UI + Certbot**.

- Websites, WebSockets, streaming, custom TCP, and UDP ranges preserving destination ports.
- Static websites from mounted folders, file filters and full-page setup wizards.
- Running containers and published ports discovered through one Komodo Core.
- Multiple domains, Cloudflare DNS-01 wildcard certificates, automatic renewal.
- Shared 404/502 pages, passkeys, persistent drafts, explicit publishing, tested reloads and rollback.

## Run locally

Requires Node 24+; this project was tested on Node 26.7. Linux containers require Docker.

```sh
npm ci --ignore-scripts
npm run setup
npm run dev
```

Open [localhost:5173](http://localhost:5173). Setup creates a local `.env` with `PROXY_ORIGIN=http://localhost:5173` and a random `PROXY_BOOTSTRAP_TOKEN`. Read that token locally to enroll your passkey, then save the recovery code. Existing `.env` files are never overwritten. Local development data lives in `.local/control/proxy.db`.

## Install through Komodo on the VPS

### 1. Create a repository-backed Stack

In Komodo, create a Stack named `proxy`, select the **VPS server**, and choose **Git repository** as the source:

- Repository: `K0stka/Proxy` on `github.com`.
- Branch: `main`.
- Run directory: repository root (`.`).
- Compose file: `compose.yaml`.

Keep image builds enabled; use Komodo's Build action before Deploy if your deployment settings skip builds. All three images build on the VPS. Pasting the Compose file alone is insufficient: its `build: context: .` needs the Dockerfiles and application source. Alternatively, copy the entire project to a directory on the VPS and select **Files on host**, with that directory as the run directory. No Node/Python installation is required on the host. See [Komodo Stack documentation](https://komo.do/docs/deploy/compose).

### 2. Set deployment values and credentials

Paste the variables from [.env.example](.env.example) into the stack's **Environment** field. Never commit a filled-in environment file. For Compose outside Komodo, supply an administrator-owned `.env`.

| Variable                                   | Value                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `PROXY_ORIGIN`                             | Exact lowercase private HTTPS management origin, e.g. your VPS Tailscale Serve URL, without a trailing slash |
| `PROXY_INGRESS_IPS`                        | Comma-separated IPs actually assigned to the VPS interface, with no wildcard binds                           |
| `PROXY_SITES_PATH`                         | Absolute VPS directory containing your website folders; create it before deployment                          |
| `PROXY_DATA_PATH`                          | Optional private data directory; requires `compose.paths.yaml` as described below                            |
| `PROXY_BOOTSTRAP_TOKEN`                    | Random enrollment token of at least 32 characters                                                            |
| `PROXY_KOMODO_URL`                         | Core URL reachable from the proxy: verified HTTPS, or HTTP over a literal Tailscale IPv4 address             |
| `PROXY_KOMODO_KEY` / `PROXY_KOMODO_SECRET` | Dedicated Core account; every server it can Read is discovered automatically                                 |
| `PROXY_CLOUDFLARE_TOKEN`                   | Cloudflare token with Zone Read and DNS Edit for the required zones                                          |
| `PROXY_CLOUDFLARE_TOKENS`                  | Optional JSON token overrides per domain; leave `'{}'` for a single token                                    |

Deployment values, the Core URL and credentials belong here. The proxy discovers every server visible to the Core account and its published container ports automatically. Configure domains and certificate preferences through **Domains → Manage domains**; routes, UDP blocks, static sites and error pages stay in the app/SQLite. There are no separate server mappings, destination allowlists or preapproved public port blocks. Environment changes require a stack recreation.

### Choose host directories (optional)

Set these in the Komodo stack Environment:

```dotenv
PROXY_SITES_PATH=/srv/proxy/sites
PROXY_DATA_PATH=/srv/proxy/data
```

In Komodo's Compose file list, add **both files in this order**: `compose.yaml`, then `compose.paths.yaml`. The second file replaces persistent volume mounts with host directories; setting `PROXY_DATA_PATH` alone does not enable it.

Before deploying, run from this project's checkout **on the VPS**:

```sh
sudo sh scripts/prepare-storage.sh /srv/proxy/data /srv/proxy/sites
```

The helper creates separate directories with the required container UIDs/GID and permissions. It changes directory ownership/modes, but never recursively changes existing files. Websites must be readable by UID 10002. Keep these directories on local Linux storage; SQLite uses WAL files and locking.

```text
/srv/proxy/
  sites/                       your website and error-page folders (read-only in edge)
  data/
    control/proxy.db           settings, routes and authentication
    edge/edge.db               last working proxy state and generated files
    certificate-policy/policy.db  sanitized certificate settings cache
    certificates/             Certbot account and renewal state
    tls/                      exported certificates and private keys
    cert-status/              certificate status
    cert-requests/            pending certificate checks
```

Only the internal IPC socket remains in a Docker-managed volume. Each container receives only its required subdirectories; the certificate worker cannot read the authentication database. Back up the private data directory and sites together, along with Komodo's environment; stop the stack before copying SQLite files.

**Existing deployment:** stop it and copy the contents of the existing named volumes into the corresponding subdirectories, preserving numeric ownership, before switching Compose files. This option does not migrate data automatically. Keep the old volumes until the restored configuration and passkey login are verified; do not deploy against an empty data directory expecting the previous configuration.

For direct Compose, use `docker compose -f compose.yaml -f compose.paths.yaml up -d --build`.

Publish home container ports on its Tailscale address, and VPS-local backends on loopback. Home loopback and Docker bridge addresses are not reachable from the VPS. Limit Tailscale grants to the intended management and backend connections. For provider 1:1 NAT, use the ingress IP assigned to the interface and configure public forwarding separately.

Generate the bootstrap token with a password manager or `openssl rand -hex 32`. Keep credentials in Komodo's protected configuration; environment values are visible to administrators with access to Docker/Komodo. They are never returned by the application API, exported with routes, copied into SQLite or passed to the edge. Do not grant the Core account Inspect, Terminal, Logs, Secrets, Execute, Write or administrator permissions. Never use Cloudflare's Global API Key.

Certbot needs an INI credential file internally. The worker creates private files from its environment under `/tmp/cloudflare` (RAM-backed, mode 0600), and recreates them on restart. There are no operator-managed credential files or mounts.

### 3. Deploy and enable private HTTPS

Deploy/redeploy from Komodo, or run `docker compose up -d --build` with the same environment. Then on the VPS:

```sh
sudo tailscale serve --bg http://127.0.0.1:3001
```

The Serve URL must match `PROXY_ORIGIN`. Limit access to administrators with Tailscale grants. Do not enable Funnel. The management port is bound to VPS loopback; NGINX binds public traffic only on configured ingress addresses. Enroll with `PROXY_BOOTSTRAP_TOKEN` and store the recovery code. Open **Services** to see discovered servers and their container ports. Add your domains and ACME email through **Domains → Manage domains**, then connect services to routes.

### 4. DNS, certificates, then publish

Point the apex and `*` records for each domain at the VPS, initially **DNS-only**. Publish AAAA only when IPv6 is configured and protected. Cloudflare must be the authoritative DNS provider, not only the registrar. Raw TCP/UDP cannot use ordinary orange-cloud proxying.

In **Domains**, confirm a successful staging check. Open **Domains → Manage**, turn off **Test certificates (staging)** and apply. The worker obtains production certificates and the edge reloads automatically. Wait for a production certificate, then use **Services → Connect → Create draft → Publish**. Staging certificates cannot be used to publish TLS routes. Keep torrent administration unpublished and access it directly through Tailscale.

Open TCP 80/443 and the published custom ingress ranges in the host and provider firewalls. The app deliberately cannot edit firewalls. Test ingress from a different network; an edge listener and a successful backend check do not verify the public path. UDP needs a real protocol-specific test.

## Automatic discovery

Set `PROXY_KOMODO_URL`, `PROXY_KOMODO_KEY` and `PROXY_KOMODO_SECRET` in the Komodo stack environment, then recreate the containers. No server list is configured in the proxy. Komodo's Read permissions determine which servers appear. Polling discovers newly accessible servers and removes inaccessible ones after a successful list refresh; a Core outage retains the previous inventory with a stale/error indication.

The proxy uses each server's Komodo address (or external address), resolves DNS to literal IPs, and prefers available Tailscale IPv4 addresses. Configure those addresses in Komodo to be reachable from the proxy host. Core-only Docker names and remote loopback addresses cannot provide a reachable backend endpoint. Explicit published IP bindings are used directly; wildcard bindings use the discovered host address. Local-host detection uses the edge's network interfaces, and only local services may use loopback bindings. API credentials are sent only to Core, never to discovered servers or DNS-selected backends.

Each server's read failure is shown separately and does not hide healthy servers. Discovery never publishes anything or changes a saved route's destination automatically. Container endpoint changes require an explicit route update. Custom IP:port routes also work without adding a destination approval. The controller and edge reject unsafe metadata/link-local/multicast addresses and protected management ports, enforce listener conflict and stream-size limits, and keep failed updates from replacing active traffic. Host/Tailscale/provider firewalls still determine network reachability.

Upgrading from the earlier manual setup preserves routes, domains, file rules and authentication. Obsolete connection/mapping/allowlist settings are removed from SQLite; the Core URL must now be supplied as `PROXY_KOMODO_URL`. Keep your existing data directory and volumes.

## Everyday use

**Routes** is the main workspace: connect a public hostname or port to a destination. **Domains** shows shared certificate coverage. **Services** lists Komodo endpoints, and **Files** lists mounted website folders; both are optional shortcuts into the route wizard. You can create either type directly through Routes → New route.

- **UDP blocks:** choose UDP → Address → Port block, then enter start/end ports. Every public port forwards to the identical destination port. Enter the destination IP and public start/end ports once in the route wizard. No separate port approval is required; the fixed total limit is 1,024 published stream ports.

- **Create or edit:** follow the full-page wizard, review, then save. New routes stay drafts until published. Live edits apply only after NGINX validates and activates them; failed changes retain the working configuration.
- **Disable:** new connections stop after application. Existing connections may drain for up to 30 seconds. This is not an immediate connection kill switch.
- **Certificates:** eligibility is checked twice daily with jitter; manual requests have a cooldown. Failed checks retain valid certificates. Separate staging/production lineages avoid accidentally reusing a staging certificate. The Domains screen shows failures and expiry.
- **Another domain:** add it through Domains → Manage. Ensure the Cloudflare token can access its zone. Only a new token or token override requires updating Komodo environment variables and recreating containers.
- **Private upstream CA:** HTTPS upstreams always verify their hostname and chain. To trust your own CA, provide an administrator-managed CA bundle containing your private CA and system roots at `/etc/ssl/certs/ca-certificates.crt` in the edge. There is no insecure verification toggle.
- **Configuration drift:** the UI compares desired and active configuration hashes. Investigate differences before using Settings → Reapply saved configuration. A lost apply response is treated as uncertain, never as proof that no listener opened.
- **Source IP:** raw TCP/UDP backends normally see the VPS. HTTP overwrites forwarding headers. Enable PROXY protocol only for a backend that supports it.
- **BitTorrent:** forwarding inbound peer ports does not route outgoing traffic through the VPS or hide the home's public IP. An egress tunnel and kill switch are separate work.

## Static sites and error pages

Compose mounts `./sites` read-only at `/sites` in the edge. Put each website in a separate folder containing `index.html`, then select **Files → Host folder**. Open **Files → File rules** to configure and preview the public files; the route wizard only selects a folder. No upload endpoint or execution of server-side scripts is provided.

```text
sites/
  portfolio/       index.html, style.css, app.js, icons/...
  project/         index.html, assets/...
  errors/404/      index.html, style.css, app.js, icons/...
  errors/502/      index.html, style.css, app.js, icons/...
```

In **Files → File rules**, use **Only expose** patterns such as `*.html`, `assets/**`, or `**/*.css`, and **Hide** patterns such as `private/**`. One pattern per line; `*` matches within a folder, `**` across folders, and `?` one character. Matching is case-sensitive and relative to the chosen folder. Dotfiles (including `.git` and `.env`), symlinks, and the reserved `_proxy/` path are always blocked. Default exclusions also hide keys, database files, source maps and `node_modules`; use a dedicated public folder and review the file list.

Saving rules updates every website and error page using the folder. Existing per-route filters are preserved until shared rules are saved. Edits to exposed files appear immediately. New filenames require **Sync files** on the published route (or a configuration apply/edge restart). Certificate renewal reloads preserve the existing file list. Directory listings are disabled. Missing or unreadable folders and missing/filtered `index.html` reject the update. Each site supports up to 5,000 entries and the configuration up to 10,000 exposed files. Filenames containing dollar signs, backslashes or control characters are blocked. Files must be readable by edge UID 10002; keep the mount read-only and do not put unrelated host data in it.

In **Settings → Error pages**, choose a directory for the shared 404 and 502 pages. Use relative asset URLs (`./style.css`, `./app.js`, `./icons/logo.svg`), including in CSS; root-absolute URLs do not resolve into the error bundle. Assets are served under `/_proxy/errors/<code>/`, including on unmatched hostnames. Timeouts use the same 502 bundle while keeping HTTP status 504. Built-in pages remain available. The shared 502 page is always used for backend 502/504 responses; there is no per-route toggle. New error assets are included when applying the pages or reapplying configuration. The website mount starts empty; add your own site and error-page directories.

## State, security and updates

Routes, domains, certificate preferences, folder rules, page selections, passkey public keys, sessions and recovery-code hashes live in **`/state/proxy.db`** (`control_state`). This is the source of truth.

The edge caches its last working routes and settings in **`/runtime/edge.db`** (`edge_state`) so traffic resumes without the controller. The certificate worker reads only domains and certificate preferences from **`/cert-policy/policy.db`** (`certificate_policy`, read-only in the worker), maintained by the controller. It cannot read the authentication database or Core credentials. Both caches can be reconstructed from the controller's saved configuration.

Generated NGINX configuration/error HTML, certificate status/request files, ACME state, certificates and website assets remain runtime files. Credentials stay in container environment variables, with temporary Certbot credential files in RAM. No mock API, automatic-login preview, sample inventory or bundled example sites are shipped.

The controller uses Node's built-in SQLite; React is compiled into static files served by that controller. NGINX handles the public data path. The edge independently validates typed requests over a group-restricted Unix socket. There is no arbitrary configuration editor, shell execution endpoint, public admin API, Docker socket, privileged container, or NET_ADMIN capability.

The edge launcher briefly uses identity/capability setup permissions, drops to UID 10002, and removes everything from the capability bounding set except NET_BIND_SERVICE before starting Node or NGINX. Control runs as UID 10001 and Certbot as UID 10003. Root filesystems are read-only. Host networking is used only by the edge to support dynamic listeners; destination safety checks and host firewall rules remain necessary boundaries.

Back up `control_state`, `edge_state`, `certbot_state`, `tls`, `sites/` and the Komodo stack environment to encrypted storage. Stop the stack before a raw volume copy so SQLite's database/WAL are consistent, or use SQLite's online backup facility. **Export configuration is not a full backup:** it excludes passkeys, sessions, recovery data, certificates and secrets. Restore the matching state volumes together, preserve UIDs/GID, then verify routing and renewal. Do not run `docker compose down --volumes` on your deployed stack.

Public request access logs are disabled to avoid retaining URLs, cookies or application data. Management audit logging is disabled; Docker bounds process logs. NGINX logs only critical operational failures. Maintain the host, Tailscale, Docker, pinned base images and dependencies; rebuild and repeat tests when updating. Environment changes require recreating containers; UI changes apply directly.

## Verify

```sh
npm run check
npm run test:containers
```

Container tests run on an internal/disabled network with no published host ports or DNS credentials. They cover actual NGINX traffic, low-port capabilities, reload failure/rollback, restart, private IPC, Compose volume permissions, and certificate export/failure retention. The script deletes only its dedicated `proxy-smoke` test volumes. It does not start the production stack.

Live Komodo compatibility, actual Cloudflare/ACME issuance and renewal, your host/provider firewalls, Tailscale grants, real authenticator/browser combinations, and sustained production traffic still need acceptance checks on your servers. See [DESIGN.md](DESIGN.md) for the architecture and boundaries. This release is not an independent security audit.
