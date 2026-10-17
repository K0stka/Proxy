import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/main.js'], {
    stdio: 'inherit',
    env: { ...process.env, PROXY_DEVELOPMENT: 'true' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
    stdio: 'inherit',
  }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children)
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
