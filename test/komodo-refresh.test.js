import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes('(async function(komodo, console, setTimeout) {\n' +
  readFileSync(new URL('../komodo/refresh-proxy.ts', import.meta.url), 'utf8') + '\n})');
const run = new Function('return ' + source)();

test('inventory refresh retries a completed busy deployment, but propagates real failures', async () => {
  for (const busy of [true, false]) {
    let deployments = 0;
    const komodo = {
      execute_server_terminal: async (_request, callbacks) => {
        for (const line of ['PROXY_DEPLOYED_REVISION=' + 'a'.repeat(40),
          'PROXY_ACTIVE=["edge-aaaaaa-0","control-aaaaaa-0"]', 'PROXY_DRAINING=[]']) callbacks.onLine(line);
        callbacks.onFinish(0);
      },
      read: async (type) => type === 'GetStack' ? { config: { ignore_services: [] }, info: { deployed_services: [] } } : {
        status: 'Complete', success: deployments > 1,
        logs: [{ stderr: busy ? 'ERROR: Resource is busy' : 'Compose configuration invalid' }],
      },
      write: async () => {},
      execute: async () => { deployments++; return { id: 'deployment', status: 'InProgress' }; },
    };
    const execution = run(komodo, { log() {} }, (callback) => callback());
    if (busy) { await execution; assert.equal(deployments, 2); }
    else { await assert.rejects(execution, /inventory deployment failed/); assert.equal(deployments, 1); }
  }
});

test('inventory refresh retries Komodo API Stack busy responses', async () => {
  let deployments = 0;
  const komodo = {
    execute_server_terminal: async (_request, callbacks) => {
      callbacks.onLine('PROXY_DEPLOYED_REVISION=' + 'a'.repeat(40));
      callbacks.onLine('PROXY_ACTIVE=["edge-aaaaaa-0","control-aaaaaa-0"]');
      callbacks.onFinish(0);
    },
    read: async (type) => type === 'GetStack'
      ? { config: { ignore_services: [] }, info: { deployed_services: [] } }
      : { status: 'Complete', success: true },
    write: async () => {},
    execute: async () => {
      deployments++;
      if (deployments === 1) throw { status: 500, result: { error: 'Stack busy', trace: [] } };
      return { id: 'deployment', status: 'InProgress' };
    },
  };
  await run(komodo, { log() {} }, (callback) => callback());
  assert.equal(deployments, 2);
});
