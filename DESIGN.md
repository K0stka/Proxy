# Proxy — proposed design

One Komodo stack on the VPS, with a private management interface and NGINX handling public traffic. The implementation is available in this workspace; see README.md for setup and verification. It has not been deployed on the user's servers or independently security-audited. The controller uses Node's built-in SQLite rather than Go to match the available toolchain and avoid a native database dependency.

## Product

The main screen is a routing workspace: discovered services on one side, their public hostname or port mapping on the other. Select a service and port, choose a hostname, check reachability, then publish. No configuration editor is required.

Navigation: **Routes · Services · Files · Domains · Settings**.

- **Routes:** Websites and TCP/UDP tabs; destination, exposure, status, edit/disable actions.
- **Services:** Home/VPS groups with running state, published ports, last discovery time, and a Connect action. Unreachable and unpublished ports are clearly distinguished.
- **Domains:** DNS readiness, apex/wildcard certificate coverage, expiry, renewal status, and last failure.
- **Settings:** Administrator access, shared error pages and backup/export. Core connection is configured in environment; servers and published ports are discovered automatically.

Use quiet neutral surfaces, a restrained green accent and compact readable rows. Creation, editing, publishing and error-page setup use full-page step-by-step wizards with review before applying. Folder rules are edited in Files. The sidebar and wizard progress stay fixed while long content scrolls. Status always has a text label. Advanced options stay collapsed. Live edits use the same validated activation and rollback as publishing.

## Deployment

Deploy a single Compose project through Komodo on the VPS:

| Container      | Responsibility                                                        | Sensitive access                                    |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `edge`         | NGINX HTTP and stream modules; small internal configuration applier   | Read-only TLS keys; active generated configuration  |
| `control`      | Node API, compiled React interface, SQLite, discovery, route planning | Read-only Komodo service account; application state |
| `certificates` | Certbot with the Cloudflare DNS plugin; renewal scheduler             | Zone-scoped DNS token; writable Certbot state       |

This deliberately uses three containers within one installable stack. Separating DNS credentials from the public proxy reduces the consequences of a proxy compromise. No Redis, external database, Docker socket, privileged container, host PID namespace, or host firewall editor.

Tailscale stays installed on the hosts. The VPS proxy uses Linux host networking so adding a TCP/UDP listener does not require recreating the container or pre-publishing thousands of Docker ports. It binds only configured ingress addresses, never an implicit `0.0.0.0`/`[::]`. Publish the UI on VPS loopback only, then use Tailscale Serve for private HTTPS on the VPS tailnet name. NGINX public-address listeners and Serve tailnet listeners must not overlap.

Run processes with separate unprivileged identities, read-only root filesystems, limited writable volumes, resource limits, and no-new-privileges. Grant the edge only the low-port binding capability if required. Host networking weakens network isolation: reject unsafe destinations and protect host services with host firewall rules. Pin reviewed image versions/digests and maintain security updates.

## Traffic and discovery

Internet → VPS public IP → NGINX → VPS-local service, or → home Tailscale IP → home service.

The controller talks only to the **home Komodo Core** over Tailscale. Core supplies inventory for both registered servers through their Periphery agents. The UI never contacts Periphery or Docker directly.

At connection time read the Core version, then choose its supported API schema. Current upstream uses `ListServers` and `ListContainers`; older versions use `ListDockerContainers`. Do not assume the current upstream API matches the installed release. Poll every 30 seconds with timeout/backoff and offer manual refresh. Call ListServers with limit 0 so discovery covers all readable servers, not only the default first page. Resolve their Komodo address/external address to literal IPs and determine local-host identity from the edge network interfaces. Normalize server ID, container name/state, container and host ports, bind address, and protocol. Isolate per-server failures. No proxy-managed server mappings or port allowlists.

Use a dedicated account with Read on the two required servers/resources, without Execute, Write, Terminal, Logs, Secrets, or Inspect. Verify that the installed release's list response supplies the necessary published-port metadata. Inspect can expose container environment secrets; missing metadata should produce a manual endpoint field rather than silently requesting broader permission.

Inventory discovery does not mean network discovery. Docker EXPOSE metadata does not establish a reachable port. A home container's bridge IP is not reachable from the VPS by default. Home services must publish the selected host port on the home Tailscale address, with tailnet grants restricted to the VPS. A host-loopback bind is not reachable from a different server. Host-network containers may need a manually entered port.

VPS-local services can publish to VPS loopback, which the host-network edge can reach. Do not publish application backends on the VPS public interface as a side effect of setting up the proxy.

Bind a route to a stable server/resource/service identity and a selected host endpoint. Keep the last applied endpoint if discovery fails; mark its inventory stale. Never delete routes after a missed poll, publish new services automatically, or silently follow a container name reused by an unrelated resource. Endpoint changes become a reviewed route update.

## Route types

### Website

Fields: hostname/domain, service or custom destination, host port, HTTP/HTTPS upstream, optional source CIDR restriction. Show container port → host port explicitly. New routes begin as unpublished drafts and create no ingress listener until explicitly published. Default public traffic to HTTPS. Support WebSockets and streaming/SSE; put upload limits and timeouts in advanced settings. Verify upstream HTTPS certificates by default, including the configured upstream server name and private CA where needed.

Select the apex or a subdomain of any configured domain. Store canonical lower-case/IDNA hostnames and validate labels. Reject duplicate hostnames. Match only configured names; never construct an upstream or redirect hostname from an untrusted Host header.

### Static website

Select a folder beneath the edge's read-only `/sites` mount. Manage shared include/exclude rules and their preview in Files. Route and error-page wizards only choose the folder. Saving shared rules updates every use atomically; legacy per-use rules remain intact until then. Dotfiles and symlinks are always blocked; NGINX exposes only exact paths recorded during apply, disables symlink following at request time, and never lists directories. New filenames need an explicit rescan; existing exposed file contents update immediately. The Files screen offers folders with `index.html`. Folder scanning uses Linux directory descriptors and no-follow opens to prevent symlink races. Limits bound scan depth, entries and exposed files.

The shared 404 and 502 pages can each select a folder with the same filters. Their HTML is copied into the applied revision and given an asset base under `/_proxy/errors/<code>/`; CSS, JS and icons remain exact approved files. Bundles use relative URLs. Error status codes are preserved.

### TCP

Fields: ingress IP, public port, destination IP and port, optional source CIDR allowlist. Raw passthrough is the default. Optional TLS termination is explicit and requires a certificate; application-layer authentication remains the destination's responsibility. Reserve public TCP 80/443 for websites in the initial design.

### UDP / port block

Fields: ingress IP, start/end public ports, destination IP, **preserve destination port**. A single port uses equal start/end values. Show the entire resulting mapping before applying it.

Example of generated NGINX configuration, with placeholders replaced by validated addresses:

```nginx
stream {
    server {
        listen PUBLIC_IPV4:50000-50100 udp reuseport;
        proxy_pass HOME_TAILSCALE_IPV4:$server_port;
        proxy_timeout 60s;
    }
}
```

Treat timeout as a service-specific advanced setting. Do not assume one UDP response per request. NGINX maintains UDP session state; this is an application proxy, not transparent packet forwarding. Backends normally see the VPS address. HTTP forwards the client address through sanitized proxy headers. Only enable PROXY protocol for a destination that explicitly supports it.

Validate port bounds, overlaps on the same ingress IP and protocol, reserved management listeners, and safe destination addresses and protected management ports. TCP and UDP can share the same number. Do not let two services claim the same UDP port just because their DNS names differ: ordinary UDP has no HTTP Host routing. Generic raw TCP is likewise routed by IP:port. Large ranges consume listening sockets and file descriptors; enforce a fixed 1,024-port stream budget and verify it under load before raising it.

The stack never changes host/provider firewall policy. During installation open HTTP/HTTPS plus the intended TCP/UDP ingress ranges in both firewalls. The UI can manage listeners using the route wizard without receiving NET_ADMIN. A proxy socket is not proof of end-to-end reachability: distinguish configured, listening, backend reachable, and externally verified. UDP verification needs a protocol-specific probe, not a generic port check.

## DNS and certificates

Cloudflare must host the authoritative DNS for each automated zone; being the registrar alone is insufficient. Initially point the apex and wildcard DNS records at the VPS. Add AAAA records only if IPv6 ingress is actually configured and protected. Start with DNS-only records for predictable direct ingress. Cloudflare's ordinary orange-cloud proxy does not carry arbitrary TCP/UDP; those hostnames require DNS-only records or a separate Spectrum setup.

For each domain, issue a separate Let's Encrypt certificate containing both `example.com` and `*.example.com` through Certbot DNS-01. A wildcard does not cover the apex by itself or deeper names such as `a.b.example.com`; those need explicit coverage. Other authoritative DNS providers require a corresponding plugin/token and are outside the Cloudflare-first setup.

Pass Cloudflare API tokens through environment variables to the certificate worker only, restricted to DNS Edit on the required zones. Per-zone overrides are supported. Never use the Global API Key; never place tokens in the browser, logs, exported configuration, or proxy container. Certbot credential INI files are generated privately in RAM-backed temporary storage, mode 0600. Zone-level DNS access remains powerful and must be treated accordingly.

The worker checks for renewal twice daily with jitter using Certbot's renewal eligibility, rather than assuming a fixed certificate lifetime. Persist the full Certbot directory. Use staging for setup tests, allow DNS propagation, prevent concurrent renewals, and retain the current certificate on failure. A successful deploy hook writes a renewal event; the edge verifies the new key/certificate pair and reloads. Expose issuance/renewal failure and approaching expiry in Domains, with an optional existing monitoring integration.

The certificate worker accepts only structured requests for administrator-configured zones. Invoke fixed Certbot arguments without a shell; never execute UI-supplied commands or paths.

## Unknown hosts and errors

For each certificate-covered domain, unmatched HTTP hostnames return the static custom **404**, and unmatched HTTPS hostnames do the same after a successful TLS handshake. Defined website routes redirect HTTP to their canonical HTTPS name. Match the apex separately when it is not assigned a website.

For unrelated or certificate-uncovered TLS names, reject the TLS handshake: an HTTP 404 cannot be shown before TLS succeeds. Use a global HTTP default server returning 404 and a rejecting TLS default server. Validate Host/SNI consistency to prevent cross-host routing.

On website routes, NGINX-generated upstream connection failures display a static custom **502** while preserving status 502. Upstream timeouts remain HTTP 504 and use the shared 502 page and assets. Backend 502/504 responses always use the shared 502 bundle. Other application responses retain their bodies. Never show host addresses, internal names, stack traces, or reflected unescaped request values. Customization selects static folders with approved HTML, CSS, JavaScript and icons. Both bundles work when the home server and controller are offline. TCP/UDP cannot display HTML errors.

## Security and safe changes

- UI/API access is tailnet-only, limited to administrator identities by Tailscale grants. Add application passkey authentication through a maintained WebAuthn library, with one-time enrollment and an offline recovery code. Do not treat forwarded identity headers as sufficient authentication. Use private HTTPS, secure HttpOnly sessions, CSRF/origin checks, session expiry, a restrictive CSP, and no browser-stored API tokens.
- Tailscale grants permit VPS → home only on required backend ports and the Core API; permit home Core → VPS Periphery separately. Replace any broad allow-all grants. Public exposure requires an explicit Publish action showing the hostname or IP:ports. Leave sensitive interfaces such as a torrent Web UI unpublished; administrators can access them directly over Tailscale. A private hostname proxy with split DNS is a separate optional feature, outside the initial design.
- Manual upstreams use literal IPs; reject cloud metadata, management ports, unspecified and multicast destinations. Discovered DNS names are resolved to literal endpoints before route creation, preventing live DNS rebinding of an applied route. Treat container labels/names, Core responses, hostnames, imported state, and page text as untrusted.
- The edge applier exposes only a permissioned internal Unix socket and typed routing operations. It validates the schema and destination policy independently, renders fixed templates, and invokes fixed NGINX commands. No arbitrary NGINX directives, uploaded executable templates, shell, file paths, or user-controlled includes.
- Application state and proxy state are separate. Apply serially: validate → render versioned candidate → `nginx -t` → atomic switch → graceful reload → verify new worker/listener state → record applied revision. A successful reload signal alone is not success. Restore the last good revision on failure. Unchanged discovery never reloads the proxy.
- Website traffic continues if the UI or Core is unavailable. In-flight streams may drain on old workers during reload; set and document a finite drain policy rather than promising indefinite connections or immediate revocation. An urgent disable requires terminating affected connections as well as removing the listener.
- Rotate and bound logs; redact cookies, credentials, query strings, and request bodies. Management audit logging is disabled. Keep encrypted backups of route state and certificates, with secrets handled separately. Test restoration.

## BitTorrent boundary

Forward its configured fixed listening TCP and UDP port(s), and configure the client to announce the VPS public endpoint where supported. Access its Web UI separately through Tailscale by default. This design forwards incoming peers; it does not route outbound torrent traffic through the VPS or guarantee that a torrent client never reveals the home's public address. That would require a separately designed egress tunnel and kill switch.

## Delivery and acceptance

Build Node/SQLite control + React UI, NGINX with stream support + typed applier, and a Certbot Cloudflare worker. Deliver one Compose stack, a short setup guide, an environment-variable template, and no default password. Nginx Proxy Manager is an existing baseline for manual management, but its documented setup does not provide this Komodo discovery workflow; the custom work belongs in the controller, not a new forwarding engine.

Before production, verify on the installed Komodo version: inventory/port schema and least-privilege access; home/VPS HTTP and WebSockets; TCP; both endpoints of a UDP range with a real protocol; wildcard/apex and second-zone renewal in ACME staging; 404/502/504 semantics; public UI denial and authentication bypass attempts; malicious hostname/config inputs; firewall exposure; failed apply rollback; Core/tailnet outages; restart/backup restore; and sustained UDP session/socket usage. No production security claim is justified by a visual prototype alone.

## Verified references

- [Komodo architecture](https://komo.do/docs/intro), [permissions](https://komo.do/docs/configuration/permissioning), [current container API and historical names](https://github.com/moghtech/komodo/blob/main/client/core/rs/src/api/read/docker.rs).
- [NGINX stream listeners and port ranges](https://nginx.org/en/docs/stream/ngx_stream_core_module.html), [TCP/UDP proxying](https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html).
- [Certbot Cloudflare DNS plugin and scoped token](https://certbot-dns-cloudflare.readthedocs.io/en/stable/), [Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/).
- [Cloudflare proxy limitations](https://developers.cloudflare.com/dns/proxy-status/limitations/), [Tailscale grants](https://tailscale.com/docs/features/access-control/grants), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
- [Nginx Proxy Manager documented setup](https://nginxproxymanager.com/guide/).

## Configuration ownership

Komodo supplies deployment values (management origin, ingress IPs, website mount, Core URL) and credentials through explicit Compose environment variables. Core URL and credentials are configured in environment. All servers visible to that Core account are discovered automatically. Domains and certificate preferences are managed in the UI and stored in the controller SQLite database. No application config file or operator-managed secret files are mounted. `control` receives only the Core credentials and bootstrap token; `certificates` receives only Cloudflare tokens; `edge` receives no external API credentials. Recreate containers to pick up environment changes. See `.env.example` and README for the complete contract.

Mutable application settings remain in the controller SQLite database. The edge's restart snapshot and settings are also SQLite. A separate sanitized SQLite cache shares only domains and certificate preferences with the read-only certificate worker; the authentication database is never mounted there. Generated NGINX files, website content, ACME material and operational status/request files remain on disk for their respective services. Environment credentials are not persisted in either SQLite database or exposed by the API. Backups include both SQLite state volumes, certificate volumes, website folders and Komodo environment configuration.
