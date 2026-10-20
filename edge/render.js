import { errorPageTypes } from '../shared/pages.js';
import { isIP } from 'node:net';
import { portRanges, samePorts } from '../shared/ports.js';
import { coveredDomain, validateSnapshot, Problem, snapshotHash } from '../shared/model.js';

export const activeHash = snapshotHash;
const address = (v) => (isIP(v) === 6 ? `[${v}]` : v);
const escapeHTML = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function errorPage(code, title, text) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${code} · ${escapeHTML(title)}</title><style>html{font:16px/1.6 system-ui;color-scheme:light dark;background:light-dark(#f5f8f6,#111a15);color:light-dark(#1a3023,#e2ece5)}body{margin:0;min-height:100svh;display:grid;place-items:center}main{max-width:34rem;padding:3rem}small{letter-spacing:.15em;opacity:.6}h1{font-size:clamp(2rem,7vw,3.5rem);line-height:1.15;font-weight:550;letter-spacing:-.05em}p{opacity:.7}</style><main><small>${code}</small><h1>${escapeHTML(title)}</h1><p>${escapeHTML(text)}</p></main></html>`;
}
const certLines = (domain) =>
  `ssl_certificate /tls/live/${domain}/fullchain.pem;\nssl_certificate_key /tls/live/${domain}/privkey.pem;\nssl_protocols TLSv1.2 TLSv1.3;\nssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;\nssl_session_tickets off;`;
const acl = (r) =>
  r.sourceCIDRs.length ? `${r.sourceCIDRs.map((c) => `allow ${c};`).join('\n')}\ndeny all;` : '';
const quote = (value) => `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
function assetLocation(uri, file, { internal = false, access = '' } = {}) {
  return `location = ${quote(uri)} { ${internal ? 'internal; types {} default_type text/html; charset utf-8; allow all;' : ''} ${access} alias ${quote(file)}; disable_symlinks on; add_header X-Content-Type-Options nosniff always; limit_except GET { deny all; } }`;
}
const errorLocations = (dir, errors, include404 = true) =>
  [404, 500, 502]
    .map((code) => {
      const prefix = `/_proxy/errors/${code}/`;
      const documentUri = `/_proxy/error-documents/${code}`;
      return `${code === 404 && !include404 ? '' : `error_page ${code === 502 ? '502 504' : code} ${documentUri};`}\n${assetLocation(documentUri, `${dir}/${code}.html`, { internal: true })}\n${(errors[code]?.exposed ?? []).map((path) => assetLocation(prefix + path, `/sites/${errors[code].directory}/${path}`, { access: 'allow all;' })).join('\n')}`;
    })
    .join('\n');

const containsPath = (base, path) => base === '/' || path === base || path.startsWith(base + '/');
function staticLocations(manifest, route, overrides) {
  if (!manifest) throw new Problem(400, 'Static folder has not been checked');
  const root = `/sites/${manifest.directory}`;
  const mount = route.path === '/' ? '' : route.path;
  const access = `${acl(route) || 'allow all;'} error_page 404 /_proxy/error-documents/404;`;
  const shadowed = (uri) => overrides.some((other) => containsPath(other.path, uri));
  const locations = manifest.exposed
    .filter((path) => !shadowed(mount + '/' + path))
    .map((path) => {
      const uri = mount + '/' + path;
      let result = assetLocation(uri, `${root}/${path}`, { access });
      if (path === 'index.html' || path.endsWith('/index.html')) {
        const folder = uri.slice(0, -'index.html'.length);
        if (!shadowed(folder)) result += `\nlocation = ${quote(folder)} { alias ${quote(root + '/' + path.slice(0, -'index.html'.length))}; index index.html; ${access} disable_symlinks on; limit_except GET { deny all; } }`;
        if (folder !== '/' && !shadowed(folder.slice(0, -1)))
          result += `\nlocation = ${quote(folder.slice(0, -1))} { return 308 ${quote(encodeURI(folder).replace(/[?#]/g, encodeURIComponent))}; }`;
      }
      return result;
    })
    .join('\n');
  const hasIndex = manifest.exposed.includes('index.html');
  return `${locations}\n${mount ? `${hasIndex ? '' : `location = ${quote(mount)} { error_page 404 /_proxy/error-documents/404; return 404; }`}\nlocation ^~ ${quote(mount + '/')} { error_page 404 /_proxy/error-documents/404; return 404; }` : 'location / { return 404; }'}`;
}

export function render(
  policy,
  raw,
  { revision, directory, readyDomains = [], wildcardDomains = readyDomains, staticSites = {}, errorSites = {}, bindIP, monitorPort, securityEnabled = false },
) {
  const snapshot = validateSnapshot(policy, raw),
    routes = snapshot.routes.filter((r) => r.published),
    ready = new Set(readyDomains), wildcard = new Set(wildcardDomains);
  const http = [],
    stream = [];
  const listen = (ip, port, extra = '') =>
    `listen ${address(bindIP ?? ip)}:${port}${extra ? ` ${extra}` : ''};`;
  http.push(
    `server { listen unix:/tmp/proxy-health.sock; access_log off; location = /revision { return 200 '${revision}'; } location / { return 404; } }`,
  );
  for (const ip of policy.ingressIPs) {
    http.push(
      `server { ${listen(ip, 80, 'default_server')} server_name _; ${errorLocations(directory, errorSites)} location / { return 404; } }`,
    );
    http.push(
      `server { ${listen(ip, 443, 'ssl default_server')} server_name _; ssl_reject_handshake on; }`,
    );
    for (const domain of policy.domains.filter((d) => ready.has(d.name))) {
      const pattern = domain.name.replace(/\./g, '\\.');
      http.push(
        `server { ${listen(ip, 443, 'ssl')} server_name ~^${domain.subdomains && wildcard.has(domain.name) ? '(?:[a-z0-9-]+\\.)?' : ''}${pattern}$; ${certLines(domain.name)} if ($ssl_server_name != $host) { return 421; } ${errorLocations(directory, errorSites)} location / { return 404; } }`,
      );
    }
  }
  const adminDomain = coveredDomain(policy.adminHostname, policy.domains)?.name;
  if (policy.adminHostname && !policy.certificates.staging && ready.has(adminDomain) && (policy.adminHostname === adminDomain || wildcard.has(adminDomain))) {
    const adminHeaders = `add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
add_header Strict-Transport-Security "max-age=31536000" always;`;
    const adminProxy = `proxy_pass http://127.0.0.1:3001;
proxy_set_header Host ${policy.adminHostname};
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Forwarded "";
proxy_set_header Proxy "";
proxy_connect_timeout 5s;
proxy_read_timeout 180s;
proxy_buffering off;`;
    http.push(`server { ${policy.ingressIPs.map((ip) => listen(ip, 80)).join(' ')} server_name ${policy.adminHostname}; location / { return 308 https://${policy.adminHostname}$request_uri; } }`);
    const adminAPI = `${adminProxy}
proxy_intercept_errors off;
error_page 429 = @admin_api_throttled;
error_page 500 = @admin_api_error;
error_page 502 = @admin_api_unavailable;
error_page 504 = @admin_api_timeout;`;
    http.push(`server {
${policy.ingressIPs.map((ip) => listen(ip, 443, 'ssl')).join(' ')}
server_name ${policy.adminHostname}; ${certLines(adminDomain)}
if ($ssl_server_name != $host) { return 421; }
client_max_body_size 1m;
${adminHeaders}
error_page 500 502 503 504 /_proxy/admin-unavailable;
location = /_proxy/admin-unavailable {
internal;
default_type text/html;
${adminHeaders}
add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
add_header Cache-Control no-store always;
return 502 '<!doctype html><html lang="en"><meta charset="utf-8"><title>Management unavailable</title><h1>Management temporarily unavailable</h1><p>Try again shortly or use the private management address.</p></html>';
}
location ^~ /_proxy/ { return 404; }
location / {
${adminProxy}
proxy_intercept_errors on;
}
location /api/ {
${adminAPI}
}
location /api/auth/ {
limit_req zone=proxy_auth burst=20 nodelay;
limit_req_status 429;
${adminAPI}
}
location @admin_api_throttled {
default_type application/json;
return 429 '{"error":"Too many sign-in attempts. Wait a minute."}';
}
location @admin_api_error {
default_type application/json;
return 500 '{"error":"Management service error. Check the operation result before retrying."}';
}
location @admin_api_unavailable {
default_type application/json;
return 502 '{"error":"Management service unavailable. Check the operation result before retrying."}';
}
location @admin_api_timeout {
default_type application/json;
return 504 '{"error":"Management request timed out. Check the operation result before retrying."}';
}
}`);
  }
  const websiteGroups = new Map();
  const redirectVariables = new Map();
  for (const route of routes.filter((route) => ['http', 'static', 'redirect'].includes(route.kind))) {
    if (!websiteGroups.has(route.hostname)) websiteGroups.set(route.hostname, []);
    websiteGroups.get(route.hostname).push(route);
    if (route.kind === 'redirect' && route.sourceCIDRs.length) {
      const variable = `$redirect_allowed_${redirectVariables.size}`;
      redirectVariables.set(route.id, variable);
      http.push(`geo ${variable} { default 0; ${route.sourceCIDRs.map((cidr) => `${cidr} 1;`).join(' ')} }`);
    }
  }
  const redirectLocations = (redirects) => redirects.map((route) => {
    const restricted = route.sourceCIDRs.length
      ? `if (${redirectVariables.get(route.id)} = 0) { return 403; } ` : '';
    const body = `${restricted}return ${route.redirectStatus} ${quote(route.redirectURL)};`;
    return route.path === '/'
      ? `location / { ${body} }`
      : `location = ${quote(route.path)} { ${body} }\nlocation ^~ ${quote(route.path + '/')} { ${body} }`;
  }).join('\n');
  for (const entry of routes) {
    let r = entry;
    if (['http', 'static', 'redirect'].includes(r.kind)) {
      const group = websiteGroups.get(r.hostname);
      if (group[0] !== r) continue;
      const root = group.find((route) => route.path === '/');
      const redirects = group.filter((route) => route.kind === 'redirect');
      const redirectRules = redirectLocations(redirects);
      const staticRoutes = group.filter((route) => route.kind === 'static');
      const staticRules = staticRoutes.map((route) => staticLocations(staticSites[route.id], route,
        group.filter((other) => other !== route && containsPath(route.path, other.path)))).join('\n');
      const staticUpgrades = staticRoutes.filter((route) => route.path !== '/').map((route) =>
        `location = ${quote(route.path)} { return 308 https://${route.hostname}$request_uri; }\nlocation ^~ ${quote(route.path + '/')} { return 308 https://${route.hostname}$request_uri; }`).join('\n');
      r = root ?? r;
      const endpoint = `${address(r.targetHost)}:${r.targetPort}`;
      const domain = coveredDomain(r.hostname, policy.domains)?.name;
      if (!ready.has(domain) || (r.hostname !== domain && !wildcard.has(domain)))
        throw new Problem(
          409,
          `Certificate for ${domain} is not ready; issue it before publishing`,
        );
      http.push(
        `server { ${policy.ingressIPs.map((ip) => listen(ip, 80)).join(' ')} server_name ${r.hostname}; ${acl(r)} ${redirectRules} ${staticUpgrades} ${root?.kind === 'redirect' ? '' : `location / { return 308 https://${r.hostname}$request_uri; }`} }`,
      );
      http.push(`server {
${policy.ingressIPs.map((ip) => listen(ip, 443, 'ssl')).join(' ')} server_name ${r.hostname}; ${certLines(domain)}
if ($ssl_server_name != $host) { return 421; }
${acl(r)}
${errorLocations(directory, errorSites, r.kind !== 'http')}
client_max_body_size ${r.uploadMB}m;
${redirectRules}
${staticRules}
${
  !root ? 'location / { return 404; }'
    : r.kind === 'redirect' ? ''
    : r.kind === 'static' ? ''
    : `
location / {
proxy_pass ${r.upstreamTLS ? 'https' : 'http'}://${endpoint};
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port $server_port;
proxy_set_header Forwarded "";
proxy_set_header Proxy "";
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_connect_timeout 5s;
proxy_read_timeout ${r.timeout}s;
proxy_send_timeout ${r.timeout}s;
proxy_buffering off;
proxy_intercept_errors on;
${r.upstreamTLS ? `proxy_ssl_server_name on; proxy_ssl_name ${r.upstreamServerName}; proxy_ssl_verify on; proxy_ssl_verify_depth 4; proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;` : ''}
}`
}
}`);
    } else {
      const endpoint = `${address(r.targetHost)}:${samePorts(r) ? '$server_port' : r.targetPort}`;
      if (r.streamTLS && !ready.has(r.tlsDomain))
        throw new Problem(409, `Certificate for ${r.tlsDomain} is not ready`);
      const listeners = portRanges(r).map(({ start, end }) => listen(r.ingressIP, start === end ? start : `${start}-${end}`, r.kind === 'udp' ? 'udp reuseport' : r.streamTLS ? 'ssl' : '')).join('\n');
      stream.push(
        `server { ${listeners} ${r.streamTLS ? certLines(r.tlsDomain) : ''} ${acl(r)} proxy_connect_timeout 5s; proxy_timeout ${r.timeout}s; ${r.proxyProtocol ? 'proxy_protocol on;' : ''} proxy_pass ${endpoint}; }`,
      );
    }
  }
  const config = `load_module /usr/lib/nginx/modules/ngx_stream_module.so;
load_module /usr/lib/nginx/modules/ndk_http_module.so;
load_module /usr/lib/nginx/modules/ngx_http_lua_module.so;
pid /tmp/nginx.pid;
error_log stderr crit;
worker_processes 2;
worker_shutdown_timeout 3600s;
events { worker_connections 8192; }
http {
include /etc/nginx/mime.types;
default_type application/octet-stream;
server_tokens off;
client_body_temp_path /tmp/client_temp;
proxy_temp_path /tmp/proxy_temp;
fastcgi_temp_path /tmp/fastcgi_temp;
uwsgi_temp_path /tmp/uwsgi_temp;
scgi_temp_path /tmp/scgi_temp;
${monitorPort ? httpMonitoring(routes, [...new Set([policy.adminHostname, new URL(policy.origin).hostname].filter(Boolean))], monitorPort, securityEnabled) : 'access_log off;'}
${securityEnabled ? `lua_package_path '/usr/local/share/lua/5.1/?.lua;/usr/local/share/lua/5.1/?/init.lua;;';
lua_shared_dict crowdsec_cache 10m;
init_by_lua_block { local cs = require 'crowdsec'; cs.proxy_initialized = cs.init('/security-ipc/bouncer.conf', 'proxy-crowdsec/1') }
map $monitor_service $security_mode { default ${policy.security.mode}; ${Object.entries(policy.security.routes).filter(([, mode]) => mode !== 'inherit').map(([id, mode]) => `${id} ${mode};`).join(' ')} }
map $host $security_failure { default ${policy.security.failure}; }
map $host $security_inspected { default false; }
map $host $security_action { default Allowed; }
map $host $security_engine { default ''; }
map $host $security_reason { default ''; }
server_rewrite_by_lua_file /app/edge/security.lua;
# Do not turn our own blocks or management authentication failures into IP bans.
map "$monitor_service:$security_action" $crowdsec_behavior_log {
    default 1;
    ~^management: 0;
    ~:(Blocked|Detected|Error)$ 0;
}
access_log syslog:server=127.0.0.1:7423,tag=nginx combined if=$crowdsec_behavior_log;` : ''}
map $request_method $proxy_auth_key { default ""; POST $binary_remote_addr; }
limit_req_zone $proxy_auth_key zone=proxy_auth:1m rate=20r/m;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
${http.join('\n')}
}
stream {
${monitorPort ? `map_hash_bucket_size 128;
map "$server_addr:$protocol:$server_port" $monitor_service { default catch-all;
${routes.filter((r) => ['tcp', 'udp'].includes(r.kind)).flatMap((r) => portRanges(r).flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => `"${bindIP ?? r.ingressIP}:${r.kind.toUpperCase()}:${start + i}" ${r.id};`))).join('\n')}
}
log_format proxy_monitor escape=json '{"protocol":"$protocol","service":"$monitor_service","address":"$remote_addr","status":"$status","bytes":"$bytes_sent","signal":"none"}';
access_log syslog:server=127.0.0.1:${monitorPort},tag=proxy_stream proxy_monitor;` : 'access_log off;'}
${stream.join('\n')}
}
`;
  return {
    config,
    pages: Object.fromEntries(errorPageTypes.map(([code, key]) => [
      `${code}.html`, errorSites[code]?.html ?? errorPage(code, snapshot.pages[key + 'Title'], snapshot.pages[key + 'Text']),
    ])),
    hash: activeHash(snapshot),
  };
}

function httpMonitoring(routes, adminHostnames, port, securityEnabled) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = routes.filter((r) => ['http', 'static', 'redirect'].includes(r.kind))
    .toSorted((a, b) => b.path.length - a.path.length)
    .map((r) => `${quote(`~^${escape(r.hostname)}:${escape(r.path)}${r.path === '/' ? '' : '(?:[/?]|$)'}`)} ${r.id};`);
  return `map "$host:$request_uri" $monitor_service {
default catch-all;
${adminHostnames.map((hostname) => `${quote(`~^${escape(hostname)}:`)} management;`).join('\n')}
${matches.join('\n')}
}
map $request_uri $monitor_signal {
default none;
${securityEnabled ? '' : `${quote('~*^[^?]*(?:\\.env|\\.git|wp-login|wp-admin|xmlrpc\\.php|/phpmyadmin|/vendor/phpunit|%2e%2e|\\.\\./)')} probe;`}
}
map $http_user_agent $monitor_uptime_kuma {
default false;
~*^Uptime-Kuma/ true;
}
map $http_user_agent $monitor_cs2_renderer {
default false;
~^AutoTournament-Recorder/1[.]0$ true;
}
log_format proxy_monitor escape=json '{"protocol":"http","service":"$monitor_service","address":"$remote_addr","status":"$status","bytes":"$bytes_sent","signal":"$monitor_signal","url":"$scheme://$host$request_uri","method":"$request_method","uptimeKuma":$monitor_uptime_kuma,"cs2Renderer":$monitor_cs2_renderer${securityEnabled ? ',"securityInspected":$security_inspected,"securityAction":"$security_action","securityEngine":"$security_engine","securityReason":"$security_reason"' : ''}}';
access_log syslog:server=127.0.0.1:${port},tag=proxy_http proxy_monitor;`;
}
