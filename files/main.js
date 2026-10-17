import http from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { bodyJSON, json } from '../shared/http.js';
import { Problem } from '../shared/model.js';
import { repository, pullRepository } from './git.js';

process.umask(0o007);
const socket = '/ipc/files.sock';
await unlink(socket).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
let busy = false;
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') throw new Problem(405, 'Method not allowed');
    const body = await bodyJSON(req);
    if (req.url === '/repositories') {
      if (!Array.isArray(body.directories) || body.directories.length > 1000)
        throw new Problem(400, 'Invalid folder list');
      json(res, await Promise.all(body.directories.map(repository)));
    } else if (req.url === '/pull') {
      if (busy) throw new Problem(409, 'Another Git pull is running');
      busy = true;
      try {
        json(res, await pullRepository(body.directory));
      } finally {
        busy = false;
      }
    } else throw new Problem(404, 'Not found');
  } catch (error) {
    json(
      res,
      { error: error instanceof Problem ? error.message : 'Git update failed' },
      error instanceof Problem ? error.status : 500,
    );
  }
});
server.requestTimeout = 150000;
server.headersTimeout = 10000;
server.listen(socket, async () => {
  await chmod(socket, 0o660);
  console.log('Files updater ready');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
