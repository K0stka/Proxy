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
const errorCopy = {
  404: ['Oops! Page not found', "The page you're looking for seems to have wandered off into the digital void. It might have been moved, deleted, or perhaps it never existed at all."],
  500: ['Internal server error', 'We are sorry, but an internal server error has occurred. Please try again later.'],
  502: ['Oops! Bad Gateway', 'The server is currently undergoing maintenance. Please try again later.'],
  504: ['Request timed out', 'The server did not respond in time. Please try again later.'],
};
const errorIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#101824"/><text x="32" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="#f8fafc">!</text></svg>';
export function errorPage(code) {
  const [title, text] = errorCopy[code];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" type="image/svg+xml" href="/_proxy/error-icon.svg"><title>Error ${code}: ${escapeHTML(title)}</title><style>
*{box-sizing:border-box}html,body{margin:0}body{display:grid;place-items:center;min-height:100vh;min-height:100dvh;overflow-x:hidden;padding:4rem 1.5rem;font:16px/1.6 Inter,system-ui,-apple-system,sans-serif;color:#f8fafc;background:linear-gradient(135deg,#040810 0%,#060a14 25%,#080e18 50%,#090f1a 75%,#0a101c 100%)}.glows{position:fixed;inset:0;overflow:hidden;pointer-events:none}.glow{position:absolute;border-radius:50%;filter:blur(35px);opacity:var(--opacity);width:var(--size);height:var(--size);top:var(--top);left:var(--left);background:var(--color)}.glow:nth-child(1){--size:75rem;--top:-40rem;--left:-30rem;--opacity:.18;--color:radial-gradient(circle,#ff6ec4,#7873f5 42%,transparent 75%)}.glow:nth-child(2){--size:70rem;--top:10%;--left:55%;--opacity:.15;--color:radial-gradient(circle,#42e695,#3bb2b8 42%,transparent 75%)}.glow:nth-child(3){--size:55rem;--top:-25rem;--left:65%;--opacity:.12;--color:radial-gradient(circle,#f7971e,#ffd200 42%,transparent 75%)}.glow:nth-child(4){--size:42rem;--top:55%;--left:-15rem;--opacity:.17;--color:radial-gradient(circle,#43cea2,#185a9d 42%,transparent 75%)}.glow:nth-child(5){--size:45rem;--top:35%;--left:30%;--opacity:.12;--color:radial-gradient(circle,#ff512f,#dd2476 42%,transparent 75%)}main{position:relative;width:min(100%,30rem);padding:3.5rem 3rem;text-align:center;border:1px solid #ffffff14;border-radius:20px;background:#ffffff08;backdrop-filter:blur(40px) saturate(180%)}h1{margin:0 0 1.5rem;font-size:clamp(3.5rem,12vw,6rem);font-weight:800;letter-spacing:-.02em;line-height:1;text-shadow:0 2px 8px #0005}h2{margin:0 0 1.25rem;font-size:clamp(1.5rem,4.5vw,2rem);font-weight:600;letter-spacing:-.01em;line-height:1.2}p{margin:0;color:#cbd5e1;font-size:clamp(1rem,3vw,1.125rem)}footer{position:fixed;bottom:0;left:0;width:100%;padding:1.5rem;text-align:center;background:linear-gradient(0deg,#040810b3,transparent)}footer a{display:inline-flex;align-items:center;gap:.6rem;padding:.5rem 1rem;border-radius:8px;color:#cbd5e1;font-size:.875rem;font-weight:500;text-decoration:none;transition:color .2s ease,background .2s ease,transform .2s ease}footer a:hover,footer a:focus-visible{color:#f8fafc;background:#ffffff0d;outline:2px solid #e2e8f0;outline-offset:2px;transform:translateY(-1px)}footer svg{width:1.1em;height:1.1em;fill:currentColor;transition:transform .2s ease}footer a:hover svg,footer a:focus-visible svg{transform:scale(1.1)}@media(max-width:480px){main{padding:2.75rem 1.75rem}}@media(prefers-reduced-transparency:reduce){main{background:#101824}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><div class="glows" aria-hidden="true"><div class="glow"></div><div class="glow"></div><div class="glow"></div><div class="glow"></div><div class="glow"></div></div><main><h1>${code}</h1><h2>${escapeHTML(title)}</h2><p>${escapeHTML(text)}</p></main><footer><a href="https://github.com/K0stka" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.17c-3.22.7-3.9-1.37-3.9-1.37-.53-1.35-1.29-1.71-1.29-1.71-1.06-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.29-5.27-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18A11 11 0 0 1 12 6.3c.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.73.8 1.18 1.83 1.18 3.08 0 4.4-2.7 5.38-5.28 5.67.41.36.77 1.07.77 2.15v2.89c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>Website by K0stka</a></footer><script>
const glows = document.querySelectorAll('.glow');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let pointerX = .5, pointerY = .5, frame;
addEventListener('pointermove', (event) => {
  pointerX = event.clientX / innerWidth;
  pointerY = event.clientY / innerHeight;
}, { passive: true });
function animate(time) {
  glows.forEach((glow, index) => {
    const phase = time * .00035 * (1 + index * .15) + index;
    const x = Math.sin(phase) * (12 + index * 3) + (pointerX - .5) * (index % 2 ? -24 : 24);
    const y = Math.cos(phase * .8) * (12 + index * 3) + (pointerY - .5) * (index % 2 ? 24 : -24);
    glow.style.transform = \`translate3d(\${x}px,\${y}px,0)\`;
  });
  frame = requestAnimationFrame(animate);
}
function syncMotion() {
  cancelAnimationFrame(frame);
  if (document.hidden || motion.matches) {
    glows.forEach((glow) => { glow.style.transform = ''; });
  } else {
    frame = requestAnimationFrame(animate);
  }
}
document.addEventListener('visibilitychange', syncMotion);
motion.addEventListener('change', syncMotion);
syncMotion();
</script></body></html>`;
}
const certLines = (domain) =>
  `ssl_certificate /tls/live/${domain}/fullchain.pem;\nssl_certificate_key /tls/live/${domain}/privkey.pem;\nssl_protocols TLSv1.2 TLSv1.3;\nssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;\nssl_session_tickets off;`;
const acl = (r) =>
  r.sourceCIDRs.length ? `${r.sourceCIDRs.map((c) => `allow ${c};`).join('\n')}\ndeny all;` : '';
const quote = (value) => `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
function assetLocation(uri, file, { internal = false, access = '' } = {}) {
  return `location = ${quote(uri)} { ${internal ? 'internal; types {} default_type text/html; charset utf-8; allow all;' : ''} ${access} alias ${quote(file)}; disable_symlinks on; add_header X-Content-Type-Options nosniff always; limit_except GET { deny all; } }`;
}
const errorLocations = (dir) =>
  [404, 500, 502, 504]
    .map((code) => {
      const documentUri = `/_proxy/error-documents/${code}`;
      return `error_page ${code} ${documentUri};\n${assetLocation(documentUri, `${dir}/error-${code}.html`, { internal: true })}`;
    })
    .concat(assetLocation('/_proxy/error-icon.svg', `${dir}/error-icon.svg`, { access: 'allow all;' }))
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
  { revision, directory, readyDomains = [], wildcardDomains = readyDomains, staticSites = {}, bindIP, monitorPort, securityEnabled = false },
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
      `server { ${listen(ip, 80, 'default_server')} server_name _; ${errorLocations(directory)} location / { return 404; } }`,
    );
    http.push(
      `server { ${listen(ip, 443, 'ssl default_server')} server_name _; ssl_reject_handshake on; }`,
    );
    for (const domain of policy.domains.filter((d) => ready.has(d.name))) {
      const pattern = domain.name.replace(/\./g, '\\.');
      http.push(
        `server { ${listen(ip, 443, 'ssl')} server_name ~^${domain.subdomains && wildcard.has(domain.name) ? '(?:[a-z0-9-]+\\.)?' : ''}${pattern}$; ${certLines(domain.name)} if ($ssl_server_name != $host) { return 421; } ${errorLocations(directory)} location / { return 404; } }`,
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
${errorLocations(directory)}
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
    pages: {
      ...Object.fromEntries([404, 500, 502, 504].map((code) => [`error-${code}.html`, errorPage(code)])),
      'error-icon.svg': errorIcon,
    },
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
