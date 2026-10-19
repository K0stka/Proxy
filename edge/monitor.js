import dgram from 'node:dgram';
import { Monitor } from '../shared/monitor.js';

export async function startMonitor({ archive } = {}) {
  const monitor = new Monitor({ archive }), socket = dgram.createSocket('udp4');
  socket.on('message', (data) => monitor.ingest(data.toString('utf8')));
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  socket.on('error', () => console.error('Traffic monitoring receiver failed'));
  return { monitor, port: socket.address().port, close: () => socket.close() };
}
