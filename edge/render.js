import { errorPageTypes } from '../shared/pages.js';
import { isIP } from 'node:net';
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
function assetLocation(uri, file, { internal = false } = {}) {
  return `location = ${quote(uri)} { ${internal ? 'internal; types {} default_type text/html; charset utf-8;' : ''} alias ${quote(file)}; disable_symlinks on; add_header X-Content-Type-Options nosniff always; limit_except GET { deny all; } }`;
}
const errorLocations = (dir, errors, include404 = true) =>
  (include404 ? [404, 500, 502] : [500, 502])
    .map((code) => {
      const prefix = `/_proxy/errors/${code}/`;
      const documentUri = `/_proxy/error-documents/${code}`;
      return `error_page ${code === 502 ? '502 504' : code} ${documentUri};\n${assetLocation(documentUri, `${dir}/${code}.html`, { internal: true })}\n${(errors[code]?.exposed ?? []).map((path) => assetLocation(prefix + path, `/sites/${errors[code].directory}/${path}`)).join('\n')}`;
    })
    .join('\n');

function staticLocations(manifest) {
  if (!manifest) throw new Problem(400, 'Static folder has not been checked');
  const root = `/sites/${manifest.directory}`;
  const indexLocation = (uri) =>
    `location = ${quote(uri)} { root ${quote(root)}; index index.html; disable_symlinks on; limit_except GET { deny all; } }`;
  return `autoindex off;\n${manifest.exposed
    .map((path) => {
      const uri = '/' + path;
      let result = assetLocation(uri, `${root}/${path}`);
      if (path === 'index.html') result += '\n' + indexLocation('/');
      else if (path.endsWith('/index.html')) {
        const folder = uri.slice(0, -'index.html'.length);
        result += '\n' + indexLocation(folder);
        result += `\nlocation = ${quote(folder.slice(0, -1))} { return 308 ${quote(encodeURI(folder).replace(/[?#]/g, encodeURIComponent))}; }`;
      }
      return result;
    })
    .join('\n')}\nlocation / { return 404; }`;
}

export function render(
  policy,
  raw,
  { revision, directory, readyDomains = [], wildcardDomains = readyDomains, staticSites = {}, errorSites = {} },
) {
  const snapshot = validateSnapshot(policy, raw),
    routes = snapshot.routes.filter((r) => r.published),
    ready = new Set(readyDomains), wildcard = new Set(wildcardDomains);
  const http = [],
    stream = [];
  const listen = (ip, port, extra = '') =>
    `listen ${address(ip)}:${port}${extra ? ` ${extra}` : ''};`;
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
    const adminProxy = `proxy_pass http://127.0.0.1:3001;
proxy_set_header Host ${policy.adminHostname};
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Forwarded "";
proxy_set_header Proxy "";
proxy_connect_timeout 5s;
proxy_read_timeout 180s;`;
    http.push(`server { ${policy.ingressIPs.map((ip) => listen(ip, 80)).join(' ')} server_name ${policy.adminHostname}; location / { return 308 https://${policy.adminHostname}$request_uri; } }`);
    http.push(`server {
${policy.ingressIPs.map((ip) => listen(ip, 443, 'ssl')).join(' ')}
server_name ${policy.adminHostname}; ${certLines(adminDomain)}
if ($ssl_server_name != $host) { return 421; }
client_max_body_size 1m;
${errorLocations(directory, errorSites)}
location / {
${adminProxy}
proxy_intercept_errors on;
}
location /api/ {
${adminProxy}
proxy_intercept_errors off;
error_page 500 = @admin_api_error;
error_page 502 = @admin_api_unavailable;
error_page 504 = @admin_api_timeout;
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
  for (const r of routes) {
    const endpoint = `${address(r.targetHost)}:${r.kind === 'udp' ? '$server_port' : r.targetPort}`;
    if (r.kind === 'http' || r.kind === 'static') {
      const domain = coveredDomain(r.hostname, policy.domains)?.name;
      if (!ready.has(domain) || (r.hostname !== domain && !wildcard.has(domain)))
        throw new Problem(
          409,
          `Certificate for ${domain} is not ready; issue it before publishing`,
        );
      http.push(
        `server { ${policy.ingressIPs.map((ip) => listen(ip, 80)).join(' ')} server_name ${r.hostname}; ${acl(r)} location / { return 308 https://${r.hostname}$request_uri; } }`,
      );
      http.push(`server {
${policy.ingressIPs.map((ip) => listen(ip, 443, 'ssl')).join(' ')} server_name ${r.hostname}; ${certLines(domain)}
if ($ssl_server_name != $host) { return 421; }
${acl(r)}
${errorLocations(directory, errorSites, r.kind === 'static')}
client_max_body_size ${r.uploadMB}m;
${
  r.kind === 'static'
    ? staticLocations(staticSites[r.id])
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
      if (r.streamTLS && !ready.has(r.tlsDomain))
        throw new Problem(409, `Certificate for ${r.tlsDomain} is not ready`);
      const ports = r.portEnd === r.portStart ? r.portStart : `${r.portStart}-${r.portEnd}`;
      stream.push(
        `server { ${listen(r.ingressIP, ports, r.kind === 'udp' ? 'udp reuseport' : r.streamTLS ? 'ssl' : '')} ${r.streamTLS ? certLines(r.tlsDomain) : ''} ${acl(r)} proxy_connect_timeout 5s; proxy_timeout ${r.timeout}s; ${r.proxyProtocol ? 'proxy_protocol on;' : ''} proxy_pass ${endpoint}; }`,
      );
    }
  }
  const config = `load_module /usr/lib/nginx/modules/ngx_stream_module.so;
pid /tmp/nginx.pid;
error_log stderr crit;
worker_processes 2;
worker_shutdown_timeout 30s;
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
access_log off;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
${http.join('\n')}
}
stream {
access_log off;
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
