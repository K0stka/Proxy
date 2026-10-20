# Proxy

A private routing workspace for a public VPS and home services connected through Tailscale. One Komodo stack: **NGINX edge + CrowdSec + management UI + Certbot + isolated Git updater**.

- Websites, WebSockets, streaming, custom TCP, and UDP ranges preserving destination ports.
- Static websites from mounted folders, file filters and full-page setup wizards.
- Running containers and published ports discovered through one Komodo Core.
- Multiple domains, Cloudflare DNS-01 wildcard certificates, automatic renewal.
- Shared 404/500/502 pages, passkeys, persistent drafts, explicit publishing, tested reloads and rollback.

## CrowdSec protection

The deployed Compose stack includes CrowdSec. **Security** uses live edge measurements and CrowdSec decisions, with blocking enabled by default. Configure monitor-only/off modes, per-service overrides, WAF/behavior/reputation sources, allowed IPv4/IPv6 addresses, ban duration, and allow/deny fallback there. A temporary IP ban can be removed without permanently allowing the address. Keep the private Tailscale management address available when tuning rules.

The WAF uses CrowdSec's maintained Lua inspection library, virtual patches, generic rules, and OWASP CRS. HTTP access logs feed maintained scanning/abuse scenarios. Raw TCP/UDP traffic is still logged, but this integration does not apply protocol inspection or firewall bans to it. Client attribution uses the socket peer; forwarded IP headers remain untrusted.

Rule updates run daily inside the CrowdSec service and can be requested in Security. Failures appear in Alerts. The existing daily image updater rebuilds CrowdSec along with the application. CrowdSec's community reputation requires outbound access to its services; request inspection and local decisions run on the VPS. The official engine's default community participation settings apply.

CrowdSec's API/WAF/syslog listeners bind only VPS loopback (8088/7422/7423). Its administration socket and generated bouncer key use a private Docker volume; no key is entered in the UI or exposed to browsers. Back up `crowdsec_config` and `crowdsec_data` (or `crowdsec-config/` and `crowdsec-data/` under the configured host data directory) along with the other persistent state. The `security_ipc` volume is generated runtime state.

Run `npm run test:crowdsec` with Docker for real NGINX/CrowdSec integration checks. It uses a separate Docker network and dedicated test volumes. `npm run preview:mock` remains a separate design preview and never changes deployed policy.

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

Enable **Pre Build Images**, disable **Pre Pull Images** and **Destroy Before Deploy**, and leave Build Extra Args empty. Set deployment Extra Args to `--no-build`; remove `--force-recreate`, `--always-recreate-deps` and `--wait` if present. Komodo runs the cached build once, then Compose updates only containers whose image or configuration changed. Do not use `--no-cache`. Pasting the Compose file alone is insufficient: its `build: context: .` needs the Dockerfiles and application source. Alternatively, copy the entire project to a directory on the VPS and select **Files on host**, with that directory as the run directory. No Node/Python installation is required on the host. See [Komodo Stack documentation](https://komo.do/docs/deploy/compose).

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

Deployment values, the Core URL and credentials belong here. The proxy discovers every server visible to the Core account and its published container ports automatically. Use **Domains → Add domain / Edit** for individual domain coverage and **Settings → Certificates** for the shared email and certificate preferences; routes, UDP blocks, static sites and error pages stay in the app/SQLite. There are no separate server mappings, destination allowlists or preapproved public port blocks. Environment changes require a stack recreation.

Builds use Docker's layer cache: unchanged steps are reused, source changes rebuild only affected steps, and UI-only changes do not rebuild the edge or certificate worker. Docker still checks build inputs during each deployment; disabling Pre Build Images would leave existing images stale after source updates. Compose leaves unchanged containers running. There are no health-dependent startup gates; health checks continue in the background for status reporting. A deployment can finish before all services are ready. Komodo's deployed commit label alone does not identify the code inside an existing running image. If an older UI persists, check that Pre Build Images is enabled and that Tailscale Serve targets the current control container's port.

### Choose host directories (optional)

Set these in the Komodo stack Environment:

```dotenv
PROXY_SITES_PATH=/srv/proxy/sites
PROXY_DATA_PATH=/srv/proxy/data
```

In Komodo's Compose file list, add **both files in this order**: `compose.yaml`, then `compose.paths.yaml`. The second file replaces persistent volume mounts with host directories; setting `PROXY_DATA_PATH` alone does not enable it.

Deploy normally. Compose creates missing host directories automatically. The proxy application containers prepare their writable directories and drop setup privileges before starting. CrowdSec uses its upstream image with a private administration socket and restricted capabilities. There are five long-running services and no separate initialization job or host setup command.

Use canonical absolute, non-overlapping data/sites paths on local Linux storage, without symlink aliases or dot segments. Each startup script touches only its writable mount roots, leaves existing file contents and file ownership alone, and never walks the tree recursively. Containers receive only their required subdirectories; none mounts the whole data root. Websites must be readable by UID 10002; sites permissions are not rewritten. SQLite uses WAL files and locking.

When upgrading from the previous four-service version, remove the obsolete `storage-init` container in Komodo if it remains listed as an orphan. Keep your data directories and volumes.

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

IPC sockets use Docker-managed volumes; log history uses the explicitly named external `proxy_logs` volume. Each container receives only its required subdirectories; the certificate worker cannot read the authentication database. Back up the private data directory and sites together, along with Komodo's environment; stop the stack before copying SQLite files.

**Existing deployment:** stop it and copy the contents of the existing named volumes into the corresponding subdirectories, preserving numeric ownership, before switching Compose files. This option does not migrate data automatically. Keep the old volumes until the restored configuration and passkey login are verified; do not deploy against an empty data directory expecting the previous configuration.

For direct Compose, use `docker compose -f compose.yaml -f compose.paths.yaml up -d --build`.

Publish home container ports on its Tailscale address, and VPS-local backends on loopback. Home loopback and Docker bridge addresses are not reachable from the VPS. Limit Tailscale grants to the intended management and backend connections. For provider 1:1 NAT, use the ingress IP assigned to the interface and configure public forwarding separately.

Generate the bootstrap token with a password manager or `openssl rand -hex 32`. Keep credentials in Komodo's protected configuration; environment values are visible to administrators with access to Docker/Komodo. They are never returned by the application API, copied into SQLite or passed to the edge. Do not grant the Core account Inspect, Terminal, Logs, Secrets, Execute, Write or administrator permissions. Never use Cloudflare's Global API Key.

Certbot needs an INI credential file internally. The worker creates private files from its environment under `/tmp/cloudflare` (RAM-backed, mode 0600), and recreates them on restart. There are no operator-managed credential files or mounts.

### 3. Deploy and enable private HTTPS

Create the external log volume once with `docker volume create proxy_logs`. Deploy/redeploy from Komodo, or run `docker compose up -d --build` with the same environment. Then on the VPS:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3001
```

Set `PROXY_ORIGIN` to the exact Serve URL, including the port, for example `https://byttorrent.pancake-ghost.ts.net:8443`. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) terminates private HTTPS and forwards to loopback. Limit access to administrators with Tailscale grants. Do not enable Funnel. The management port is bound to VPS loopback; NGINX binds public traffic only on configured ingress addresses. Enroll with `PROXY_BOOTSTRAP_TOKEN` and store the recovery code. Open **Services** to see discovered servers and their container ports. Set the shared email in **Settings → Certificates**, add domains individually through **Domains → Add domain**, then connect services to routes.

### 4. DNS, certificates, then publish

Point the apex record at the VPS, initially **DNS-only**. Add a `*` record only for domains on which you enable third-level subdomains. Publish AAAA only when IPv6 is configured and protected. Cloudflare must be the authoritative DNS provider, not only the registrar. Raw TCP/UDP cannot use ordinary orange-cloud proxying.

Set the shared email in **Settings → Certificates**. Use **Domains → Add domain** for each domain, or **Edit** on its card. Disable **Allow third-level subdomains** for an apex-only certificate; enable it to request both the apex and its wildcard. Existing domains retain wildcard coverage. New installations request production certificates automatically; the edge reloads when they are ready. Wait for a certificate, then use **Services → Create proxy, save the disabled route, then enable its switch in Routes**. Staging and DNS timing controls are in **Settings → Certificates → Diagnostics**. Existing staging configurations stay in staging until you switch them off. Keep torrent administration unpublished and access it directly through Tailscale.

Open TCP 80/443 and the published custom ingress ranges in the host and provider firewalls. The app deliberately cannot edit firewalls. Test ingress from a different network; an edge listener and a successful backend check do not verify the public path. UDP needs a real protocol-specific test.

### Public admin hostname and private fallback

In **Settings → General**, set a public hostname covered by a configured domain, for example `proxy.krychlic.com`. Point its DNS record at the VPS. The edge creates a fixed HTTPS proxy to the loopback management port once a production certificate covers it; no custom endpoint or management-port exception is needed. Clearing the hostname disables public access. The hostname is reserved, so ordinary routes cannot claim it.

Management API errors remain JSON, including gateway failures, so action errors can be shown in toasts. Proxied websites use the shared HTML error pages. The management hostname uses trusted built-in errors and blocks custom error assets.

The private Tailscale Serve address remains independent of public DNS, the edge, and Let's Encrypt: `https://byttorrent.pancake-ghost.ts.net:8443` for the example above. Both addresses use passkeys and exact Host/Origin checks. Sessions and passkeys are scoped to their hostname/origin. Existing private-host passkeys remain valid. On first access at the other hostname, enter the recovery code to authorize creating a passkey there, then save the newly rotated recovery code. Cancelling that passkey prompt still shows the recovery code; you can register the passkey later with a one-time link from **Settings → Devices**. Recovery revokes other sessions but preserves existing passkeys. Private availability still requires the control container and host Tailscale service to be running.

## Automatic discovery

Set `PROXY_KOMODO_URL`, `PROXY_KOMODO_KEY` and `PROXY_KOMODO_SECRET` in the Komodo stack environment, then recreate the containers. No server list is configured in the proxy. Komodo's Read permissions determine which servers appear. Polling discovers newly accessible servers and removes inaccessible ones after a successful list refresh; a Core outage retains the previous inventory with a stale/error indication.

The proxy uses each server's Komodo address (or external address), resolves DNS to literal IPs, and prefers available Tailscale IPv4 addresses. Configure those addresses in Komodo to be reachable from the proxy host. Core-only Docker names and remote loopback addresses cannot provide a reachable backend endpoint. Explicit published IP bindings are used directly; wildcard bindings use the discovered host address. Local-host detection uses the edge's network interfaces, and only local services may use loopback bindings. API credentials are sent only to Core, never to discovered servers or DNS-selected backends.

Each server's read failure is shown separately and does not hide healthy servers. Discovery never publishes anything or changes a saved route's destination automatically. Container endpoint changes require an explicit route update. Custom IP:port routes also work without adding a destination approval. The controller and edge reject unsafe metadata/link-local/multicast addresses and protected management ports, enforce listener conflict and stream-size limits, and keep failed updates from replacing active traffic. Host/Tailscale/provider firewalls still determine network reachability.

Upgrading from the earlier manual setup preserves routes, domains, file rules and authentication. Obsolete connection/mapping/allowlist settings are removed from SQLite; the Core URL must now be supplied as `PROXY_KOMODO_URL`. Keep your existing data directory and volumes.

## Everyday use

Resource lists and selectors sort by name ascending. During route creation, the default subdomain follows the formatted route name (for example, `My Service` becomes `my-service`) until edited manually. Renaming an existing route preserves its hostname.

**Routes** is the main workspace: connect a public hostname or port to a destination. **Domains** shows shared certificate coverage. **Services** lists Komodo endpoints, and **Folders** manages explicitly configured folders; both are optional shortcuts into the route wizard. You can create either type directly through Routes → Create route.

Pages and wizard steps use normal paths such as `/settings` and `/routes/route?step=2`, without hash routing. Browser Back/Forward navigate them; refresh restores the current wizard step and its unsaved fields from the tab's history. This does not publish or save changes to the server. Credentials and recovery codes are never placed in navigation history.

- **Port forwarding:** TCP and UDP use one **Ports** field, accepting individual ports and ranges such as `12, 34, 56-78`. Multiple ports forward to the identical destination port numbers; a single TCP port can use a different destination host port. Invalid, overlapping and protected ports are rejected. The fixed total limit is 1,024 published stream ports. Existing single-port and UDP-block routes retain their mappings.

- **Redirects:** choose Redirect, an absolute HTTP(S) destination URL and Temporary (302) or Permanent (301). In Address, select the hostname and path (`/` for the whole site). A path such as `/something` matches that directory and its descendants, including `/something/child`, but not `/somethingelse`. It works without a root route; other HTTPS paths then return 404. With a website or another redirect at the root, the more specific directory wins. Every match goes to the exact destination URL; incoming suffixes and query strings are discarded. Source network restrictions apply independently to each redirect. Redirect hostnames need configured domain coverage and a production certificate before publishing.

- **Create or edit:** each full-page wizard validates the current inputs before advancing to Review. Backend checks still run again on save to catch concurrent changes. Cancel, Back and Continue share the footer. Create routes are saved disabled; use the leading switch in Routes to enable or disable them. Editing a route shows every applicable setting on one page, with Name before Type. Enabled routes and proxied services use a primary-color border; disabled routes use gray. Live edits apply only after NGINX validates and activates them; failed changes retain the working configuration.
- **Disable:** new connections stop after application. Existing connections may drain for up to 30 seconds. This is not an immediate connection kill switch.
- **Certificates:** eligibility is checked twice daily with jitter; manual requests have a cooldown. Failed checks retain valid certificates. Separate staging/production lineages avoid accidentally reusing a staging certificate. The Domains screen shows failures and expiry.
- **Another domain:** add it through Domains → Add domain. Ensure the Cloudflare token can access its zone. Only a new token or token override requires updating Komodo environment variables and recreating containers.
- **Private upstream CA:** HTTPS upstreams always verify their hostname and chain. To trust your own CA, provide an administrator-managed CA bundle containing your private CA and system roots at `/etc/ssl/certs/ca-certificates.crt` in the edge. There is no insecure verification toggle.
- **Configuration drift:** the UI compares desired and active configuration hashes and shows **Retry** when they differ. A lost apply response is treated as uncertain, never as proof that no listener opened.
- **Source IP:** raw TCP/UDP backends normally see the VPS. HTTP overwrites forwarding headers. Enable PROXY protocol only for a backend that supports it.
- **BitTorrent:** forwarding inbound peer ports does not route outgoing traffic through the VPS or hide the home's public IP. An egress tunnel and kill switch are separate work.

## Static sites and error pages

Compose mounts your sites directory read-only at `/sites` in the edge. Use **Folders → Add folder** to define a relative path (such as `websites/portfolio`, with no leading or trailing slash) and include/exclude rules, preview its files, then save. Only configured folders (plus previously saved route/page folders) appear; the mount is not searched for websites. Empty folders and asset-only folders are valid; there is no `index.html` requirement. Use **Edit rules** to change the path or rules and create a static route in Routes to connect it to a hostname. These are folder definitions, not filesystem creation/upload commands; create the actual directories on the host. No server-side scripts execute.

Static routes also have a **Path** field. Set `/something` and choose folder `something` to serve `/sites/something/index.html` at `https://krychlic.com/something/`, with assets beneath the same URL directory. `/something` redirects to `/something/` when an index exists. The mount works without a root route and overrides a root website only for that directory, with its own access restrictions. Other paths keep their root route or return 404. Use relative asset URLs so the site works under its mount path; root-absolute URLs still refer to the hostname root.

```text
sites/
  portfolio/       index.html, style.css, app.js, icons/...
  project/         index.html, assets/...
  errors/404/      index.html, style.css, app.js, icons/...
  errors/502/      index.html, style.css, app.js, icons/...
```

In the folder wizard, use **Only expose** patterns such as `*.html`, `assets/**`, or `**/*.css`, and **Hide** patterns such as `private/**`. One pattern per line; `*` matches within a folder, `**` across folders, and `?` one character. Matching is case-sensitive and relative to the chosen folder. Dotfiles (including `.git` and `.env`), symlinks, and the reserved `_proxy/` path are always blocked. Default exclusions also hide keys, database files, source maps and `node_modules`; use a dedicated public folder and review the file list.

Saving a folder updates every route and error page using it atomically. Changing its path updates those references; it does not move host files. Removing a folder definition is allowed only when unused and never deletes disk content. Saving rules updates every website and error page using the folder. Existing per-route filters are preserved until shared rules are saved. Edits to exposed files appear immediately. New filenames are included after Git pull, saving the folder rules, or a configuration apply/edge restart. Certificate renewal reloads preserve the existing file list. Directory listings are disabled. Missing or unreadable paths reject the update. With no exposed `index.html`, a static route still serves its approved files directly; its root URL returns the shared 404. Each site supports up to 5,000 entries and the configuration up to 10,000 exposed files. Filenames containing dollar signs, backslashes or control characters are blocked. Files must be readable by edge UID 10002; keep the mount read-only and do not put unrelated host data in it.

In **Settings → Error pages**, use **Edit** on the separate 404, 500 or 502 row. Each has its own two-step flow and URL (for example `/settings/pages/502`), and saving one never overwrites the other. Choose a configured folder and its page document, such as `notice.htm` or `nested/error.html`. Existing selections default to `index.html`, but any exposed document can be selected. The chosen document must exist, remain included by the folder rules and be readable (maximum 1 MB); other folders need no page document. Use relative asset URLs (`./style.css`, `./app.js`, `./icons/logo.svg`), including in CSS; root-absolute URLs do not resolve into the error bundle. Relative URLs resolve from the selected document’s subdirectory. Assets are served under `/_proxy/errors/<code>/`, including on unmatched hostnames. Timeouts use the same 502 bundle while keeping HTTP status 504. Built-in pages remain available. The shared 500 page handles backend 500 responses, and the shared 502 page handles backend 502/504 responses; there is no per-route toggle. New error assets are included when applying the pages or reapplying configuration. The website mount starts empty; add your own site and error-page directories.

### Git pull from folder cards

Folder titles use the first path segment: `something/else/entirely` displays **Something**. The full path stays visible. The Git pull button appears when the folder, or a parent inside `/sites`, contains an ordinary Git repository. It pulls the repository's current branch/upstream using fast-forward only, refuses local changes and never resets or deletes them. Hooks and checkout filters are disabled; no build scripts or submodule updates run. A successful pull reapplies the proxy file lists, including error-page assets. File checkout itself is not an atomic website deployment.

Git pulls the nearest parent repository inside `/sites`, including a repository rooted at `/sites` itself. For example, a folder `codenames/dist` uses `/sites/codenames/.git`. Repositories above the mounted `/sites` tree are inaccessible; mount their parent directory if needed.

Git runs in the separate `files` container. It can write the sites mount but has no Core/Cloudflare credentials, authentication database, TLS keys or Docker socket. NGINX keeps its sites mount read-only. Set `PROXY_FILES_UID` in Komodo Environment to the VPS user ID that owns the repositories and SSH keys (usually `1000`; use `0` only if those files are owned by root). Existing ownership is never changed recursively. The updater also needs write access to the repository contents; website files must remain readable by edge UID 10002.

For SSH repositories, append `compose.ssh.yaml` after your other Compose files and set:

```dotenv
PROXY_FILES_UID=1000
PROXY_GIT_SSH_PATH=/home/YOUR_VPS_USER/.ssh
```

For root-owned repositories/keys use UID `0` and `/root/.ssh`. The SSH directory is mounted read-only, at its existing absolute path, into the files updater only. Existing SSH config and standard private keys are used; host keys must already be trusted in `known_hosts`. Interactive key passphrases and an SSH agent from your host session are not available inside the container. HTTPS public repositories need no SSH override. Linked Git worktrees, Git LFS checkout filters and build pipelines are not supported by this pull action. It does not clone repositories or change the remote URL.

## State, security and updates

Routes, domains, certificate preferences, folder rules, page selections, passkey public keys, one-time device links, sessions and recovery-code hashes live in **`/state/proxy.db`** (`control_state`). This is the source of truth.

The edge caches its last working routes and settings in **`/runtime/edge.db`** (`edge_state`) so traffic resumes without the controller. The certificate worker reads only domains and certificate preferences from **`/cert-policy/policy.db`** (`certificate_policy`, read-only in the worker), maintained by the controller. It cannot read the authentication database or Core credentials. Both caches can be reconstructed from the controller's saved configuration.

Generated NGINX configuration/error HTML, certificate status/request files, ACME state, certificates and website assets remain runtime files. Core and Cloudflare credentials stay in container environment variables, with temporary Certbot credential files in RAM. The optional Discord webhook secret stays in the controller SQLite database. No mock API, automatic-login preview, sample inventory or bundled example sites are shipped.

The controller uses Node's built-in SQLite; React is compiled into static files served by that controller. NGINX handles the public data path. The edge independently validates typed requests over a group-restricted Unix socket. There is no arbitrary configuration editor, shell execution endpoint, public admin API, Docker socket, privileged container, or NET_ADMIN capability.

Startup scripts briefly use directory ownership and identity/capability setup permissions, then exec the applications as unprivileged users. The edge drops to UID 10002 and removes everything from the capability bounding set except NET_BIND_SERVICE before starting Node or NGINX. Control runs as UID 10001 and Certbot as UID 10003, both with empty capability sets. Root filesystems are read-only. Host networking is used only by the edge to support dynamic listeners; destination safety checks and host firewall rules remain necessary boundaries.

Back up `proxy_logs`, `control_state`, `edge_state`, `certbot_state`, `tls`, `sites/` and the Komodo stack environment to encrypted storage. Stop the stack before a raw volume copy so SQLite's database/WAL are consistent, or use SQLite's online backup facility. Restore the matching state volumes together, preserve UIDs/GID, then verify routing and renewal. Do not run `docker compose down --volumes` on your deployed stack.

**Logs** shows request/session history, refreshing every five seconds. **Security → Alerts** holds detections and operational alerts; **Security → Audit logs** holds administrative and edge lifecycle events. Every published HTTP/static/redirect route, TCP/UDP listener and HTTP wildcard/default catch-all is monitored. Route attribution uses the original hostname/path; unmatched traffic is grouped as catch-all. New HTTP records retain the full scheme/hostname/request URI (including query strings), method and raw peer IP so requests from one client can be traced across services. Headers, cookies and bodies are not recorded. Older pseudonymous entries cannot be converted back into IP addresses. Cloudflare or another upstream proxy appears as the source; forwarded headers are not trusted for monitoring.

All edge generations share `/logs/edge/logs.db`, and all controllers share `/logs/control/logs.db`, in the explicitly named external `proxy_logs` volume. Logs survive overlapping generations and stack destruction; generation cleanup never deletes this volume. See [persistent log storage](LOG-STORAGE.md) for migration, permissions and host log locations. Logs survive restarts and generation handoffs and expire after **30 days**, with an additional **128 MiB event-data cap per component** that removes the oldest entries sooner on busy servers. SQLite tables and indexes add overhead; each database has a 512 MiB file ceiling, plus temporary WAL files. Freed pages are reused. A 300-byte event at one request per second is approximately 742 MiB per month before database overhead, so retention under load can be shorter. **Logs** provides one global Last hour/day/week/month/Today selector and a service checkbox selector; Today starts at 00:00 in the browser timezone. Last month is a rolling 30 days. These filters apply to metrics, the separate 4xx/5xx chart lines, response outcomes, events and downloads. Events combine edge and administration logs with pagination. **Download all** streams every matching retained event as NDJSON, including records beyond the visible page; an unavailable edge prevents an incomplete download. Client IP filtering traces one address across services. Writes are batched every second, so an abrupt crash can lose the last second of events. Persistence failures are shown in the app without stopping proxy traffic. The live view keeps up to 500 events with space reserved for 100 alerts; live counters reset on restart.

Counters expire after a 60-second window per service/source; at most 4,096 windows are tracked. Alerts trigger at 300 completed requests/sessions per source/service (3,000 per service), 20 server errors with at least a 50% failure rate, 20 denials, five common exploit-path probes (legacy deployments without CrowdSec), or 60 catch-all 404s in that window. Configured routes also alert at 60 missing-resource responses when at least 80% of requests return 404. Twenty failed management authentication operations per minute also trigger an alert. These operational alerts do not block traffic; legitimate load can trigger them. CrowdSec independently detects and blocks malicious HTTP traffic according to the Security policy.

**Settings → Discord alerts** optionally sends new alerts to a configurable Discord channel webhook. The webhook URL is a secret stored only in the controller database and never returned by the API or passed to the edge. Save, enable/disable, remove and send a test notification in the app. Alerts include the service name, reason, protocol/status and source IP, with mentions disabled. Delivery runs while the app is closed, sends at most once per 10 seconds, suppresses duplicate service/reason pairs for 15 minutes, respects Discord cooldowns and retries failed deliveries. Cursors and duplicate suppression survive controller restarts. Enabling starts with new alerts, not old history. Delivery status and errors are visible in the app. Network uncertainty can cause duplicate delivery; disabling or replacing a webhook cannot recall a request already in flight. TCP/UDP is monitored as completed sessions, without inspecting payloads. Long-lived sessions appear when they close; rejected TLS handshakes before HTTP and traffic to unproxied discovered services are outside this view. This is not a full intrusion-detection system or backend application log viewer.

NGINX sends sanitized metadata to a loopback-only ephemeral UDP syslog receiver in its edge process. Delivery is best effort, so persisted logs can still miss events and are not exact traffic accounting. Administrative security events also continue to process logs without request bodies or secrets; Docker bounds process logs. NGINX logs only critical operational failures to stderr. Maintain the host, Tailscale and Docker. See [Security maintenance](SECURITY-UPDATES.md) for daily tested image rebuilds, automatic tested npm updates, and rollback. Environment changes require recreating containers; UI changes apply directly.

## Verify

```sh
npm run check
npm run test:containers
```

Container tests run on an internal/disabled network with no published host ports or DNS credentials. They cover actual NGINX traffic, low-port capabilities, reload failure/rollback, restart, private IPC, Compose volume permissions, and certificate export/failure retention. The script deletes only its dedicated `proxy-smoke` test volumes. It does not start the production stack.

Live Komodo compatibility, actual Cloudflare/ACME issuance and renewal, your host/provider firewalls, Tailscale grants, real authenticator/browser combinations, and sustained production traffic still need acceptance checks on your servers. See [DESIGN.md](DESIGN.md) for the architecture and boundaries. This release is not an independent security audit.

The admin panel includes an installable app manifest and icons. Open its HTTPS address and use the browser's Install app / Add to Home Screen command. It stays online-only; no service worker caches management data or credentials. Each hostname is a separate app and passkey origin.


### Default log filters

Settings → Log filters controls two enabled defaults: hide Uptime Kuma requests and hide requests to the management panel. Kuma detection matches the `Uptime-Kuma/` user-agent prefix case-insensitively, regardless of client IP. Only the classification flag is retained, not the full header. These filters apply before pagination to Logs events, charts, totals and full downloads; the Logs page has no additional controls for them. Stored records, security alerts, administration events and edge operations are retained. Disable the filters to view the recorded requests again. Older records without a Kuma classification remain visible. Existing IP-based filter settings migrate automatically while preserving the management-panel preference.

## Local mock review

Run `npm run preview:mock` and open [the local mock preview](http://127.0.0.1:4180/logs). It binds only to loopback and uses synthetic services and historical traffic. It never loads deployment credentials or contacts the real edge or Core. Discord delivery is real: enter and save a real webhook URL in Settings, enable notifications, then use Send test notification. There is no seeded fake webhook. Preview webhook settings persist separately in `.local/preview/control.db`. A blue banner identifies the mock throughout the app. Its data lives separately in `.local/preview/`; production images do not include this preview script. Stop it with Ctrl+C. Set `PROXY_PREVIEW_PORT` to choose another local port.
