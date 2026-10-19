import http from 'node:http';
import { readFile } from 'node:fs/promises';

export async function activeController() {
  const generation = process.env.PROXY_CONTROL_GENERATION;
  if (!generation) return true;
  return JSON.parse(await readFile('/handoff/active.json', 'utf8')).id === generation;
}

// Only root's read-only registry selects the destination; request headers never do.
export async function forwardHandoff(req, res) {
  const generation = process.env.PROXY_CONTROL_GENERATION;
  if (!generation || req.url === '/healthz') return false;
  const active = JSON.parse(await readFile('/handoff/active.json', 'utf8'));
  if (active.id === generation) return false;
  if (!/^10\.254\.240\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|250)$/.test(active.ip))
    throw new Error('Invalid management handoff address');
  if (req.headers['x-proxy-handoff-hop']) throw new Error('Management handoff loop');
  const upstream = http.request({ hostname: active.ip, port: 3001, path: req.url,
    method: req.method, headers: { ...req.headers, 'x-proxy-handoff-hop': '1', connection: 'close' },
    timeout: 30000 }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"Management handoff unavailable"}');
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
  return true;
}
