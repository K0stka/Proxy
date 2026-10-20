import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const compose = ['compose', '-p', 'proxy-crowdsec-check-' + randomUUID().slice(0, 8), '-f', 'test/crowdsec.compose.yaml'];
const run = (args) => execFileSync('docker', args, { stdio: 'inherit' });
try {
  if (process.env.PROXY_SKIP_BUILD !== 'true') run(['compose', 'build', 'edge', 'crowdsec']);
  run([...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'crowdsec']);
  run([...compose, 'exec', '-T', 'crowdsec', 'cscli', 'decisions', 'add', '--ip', '198.51.100.24', '--duration', '4h', '--reason', 'proxy-local-test']);
  run([...compose, 'run', '--rm', 'tests']);
} finally {
  run([...compose, 'logs', '--tail', '30', 'crowdsec']);
  run([...compose, 'down', '--volumes']);
}
