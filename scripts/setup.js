import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

await mkdir('.local', { recursive: true, mode: 0o700 });
try {
  const template = (await readFile('.env.example', 'utf8'))
    .replace(/^PROXY_ORIGIN=.*$/m, 'PROXY_ORIGIN=http://localhost:5173')
    .replace(/^PROXY_INGRESS_IPS=.*$/m, 'PROXY_INGRESS_IPS=127.0.0.1')
    .replace(
      /^PROXY_BOOTSTRAP_TOKEN=.*$/m,
      `PROXY_BOOTSTRAP_TOKEN=${randomBytes(32).toString('base64url')}`,
    );
  await writeFile('.env', template, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created .env for local development. Enrollment token is in PROXY_BOOTSTRAP_TOKEN; read it locally.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env retained.');
}
