import { mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDeployment } from '../shared/env.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { effectivePolicy, defaultSettings } from '../shared/model.js';

process.umask(0o007);
const development = process.env.PROXY_DEVELOPMENT === 'true';
const deployment = readDeployment(process.env, { development });
const stateDir = process.env.PROXY_STATE ?? '.local/control';
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const store = new Store(join(stateDir, 'proxy.db'));
const policy = effectivePolicy(deployment, store.get('settings', defaultSettings), { development });
const certificatePolicyStore = new Store(
  process.env.PROXY_CERT_POLICY ?? join(stateDir, 'certificate-policy.db'),
);
certificatePolicyStore.set('policy', {
  domains: policy.domains,
  certificates: policy.certificates,
});
const app = createApp({
  policy,
  certificatePolicyStore,
  store,
  stateDir,
  development,
  bootstrapToken: process.env.PROXY_BOOTSTRAP_TOKEN ?? '',
  edgeSocket: process.env.PROXY_EDGE_SOCKET ?? '/ipc/edge.sock',
  certStatusDir: process.env.PROXY_CERT_STATUS ?? '/cert-status',
  certRequestDir: process.env.PROXY_CERT_REQUESTS ?? '/cert-requests',
  ...(process.env.PROXY_AUDIT_PATH ? { auditLog: (record) => {
    appendFileSync(process.env.PROXY_AUDIT_PATH, JSON.stringify(record) + '\n', { mode: 0o600 });
    console.info(JSON.stringify(record));
  } } : {}),
});
const stopDiscovery = app.discovery.start();
app.server.listen(
  Number(process.env.PORT ?? 3001),
  process.env.PROXY_LISTEN_HOST ?? '127.0.0.1',
  () => console.log(`Proxy management listening; expected origin ${policy.origin}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopDiscovery();
    app.server.close(() => {
      store.close();
      certificatePolicyStore.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
