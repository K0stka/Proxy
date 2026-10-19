import http from 'node:http';
// Compose keeps these unprivileged status agents; root's host service owns handoffs.
console.info('Proxy handoff mode: application generations are managed by proxy-handoff.service');
if (process.argv[2] === 'control') {
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404); res.end(); return; }
    const probe = http.get({ socketPath: '/ipc/edge.sock', path: '/status', timeout: 1500 }, (response) => {
      response.resume();
      res.writeHead(response.statusCode === 200 ? 200 : 503);
      res.end('{"ok":true}');
    });
    probe.on('timeout', () => probe.destroy());
    probe.on('error', () => { res.writeHead(503); res.end(); });
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.listen(3001, '0.0.0.0');
}
setInterval(() => {}, 60000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
