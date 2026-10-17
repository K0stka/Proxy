import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const configuration = JSON.parse(
  execFileSync('docker', ['compose', 'config', '--format', 'json'], { encoding: 'utf8' }),
);
for (const [name, service] of Object.entries(configuration.services)) {
  const env = service.environment ?? {};
  for (const secret of ['PROXY_CLOUDFLARE_TOKEN', 'PROXY_CLOUDFLARE_TOKENS'])
    assert.equal(secret in env, name === 'certificates');
  for (const secret of [
    'PROXY_KOMODO_URL',
    'PROXY_KOMODO_KEY',
    'PROXY_KOMODO_SECRET',
    'PROXY_BOOTSTRAP_TOKEN',
  ])
    assert.equal(secret in env, name === 'control');
  for (const key of [
    'PROXY_TARGETS',
    'PROXY_DOMAINS',
    'PROXY_KOMODO_SERVERS',
    'PROXY_INGRESS_PORTS',
    'PROXY_ACME_STAGING',
  ])
    assert(!(key in env));
  if (name === 'certificates')
    assert(service.volumes.find((volume) => volume.target === '/cert-policy')?.read_only);
  assert(
    !service.volumes.some(
      (volume) =>
        volume.target === '/config/config.json' || volume.target.startsWith('/run/secrets/'),
    ),
  );
}

const hostStorage = JSON.parse(
  execFileSync(
    'docker',
    ['compose', '-f', 'compose.yaml', '-f', 'compose.paths.yaml', 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROXY_DATA_PATH: '/srv/proxy/data',
        PROXY_SITES_PATH: '/srv/proxy/sites',
      },
    },
  ),
);
assert.deepEqual(Object.keys(hostStorage.services).sort(), ['certificates', 'control', 'edge']);
for (const [name, service] of Object.entries(hostStorage.services)) {
  for (const mount of service.volumes) {
    if (mount.target === '/ipc') {
      assert.equal(mount.type, 'volume');
      continue;
    }
    assert.equal(mount.type, 'bind');
    assert.equal(mount.source.startsWith('/srv/proxy/'), true);
    assert.notEqual(mount.bind.create_host_path, false);
    assert.equal(
      Boolean(mount.read_only),
      (name === 'edge' && ['/sites', '/tls'].includes(mount.target)) ||
        (name === 'control' && mount.target === '/cert-status') ||
        (name === 'certificates' && mount.target === '/cert-policy'),
    );
  }
  assert(!service.volumes.some((mount) => mount.source === '/srv/proxy/data'));
}

const run = (args, input) =>
  execFileSync('docker', args, {
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    input,
  });
const smoke = ['compose', '-p', 'proxy-smoke', '-f', 'test/compose.yaml'];
run(['compose', '-p', 'proxy', '--progress', 'quiet', 'build']);
run([
  'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  ...['NET_BIND_SERVICE', 'CHOWN', 'FOWNER', 'SETUID', 'SETGID', 'SETPCAP'].flatMap(cap => ['--cap-add', cap]),
  ...['/state', '/cert-policy', '/cert-requests', '/runtime', '/ipc', '/certbot', '/tls', '/cert-status'].flatMap(path => ['--tmpfs', path + ':rw,nosuid,size=1m']),
  '--mount', `type=bind,source=${resolve('test/startup.test.js')},target=/checks/startup.test.js,readonly`,
  '--env', 'PROXY_STARTUP_TEST=true', '--entrypoint', 'node',
  'proxy-edge', '--test', '/checks/startup.test.js',
]);
run(['build', '-q', '-f', 'test/linux.Dockerfile', '-t', 'proxy-linux-test', '.']);
run([
  'run',
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--cap-add',
  'NET_BIND_SERVICE',
  '--cap-add',
  'CHOWN',
  '--cap-add',
  'FOWNER',
  '--cap-add',
  'SETUID',
  '--cap-add',
  'SETGID',
  '--cap-add',
  'SETPCAP',
  '--security-opt',
  'no-new-privileges:true',
  '--sysctl',
  'net.ipv4.ip_unprivileged_port_start=1024',
  '--pids-limit',
  '200',
  '--memory',
  '512m',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=64m,uid=10002,gid=10000',
  '--tmpfs',
  '/runtime:rw,noexec,nosuid,size=64m,uid=10002,gid=10000',
  '--tmpfs',
  '/tls:rw,noexec,nosuid,size=32m,uid=10002,gid=10000',
  '--tmpfs',
  '/sites:rw,noexec,nosuid,size=32m,uid=10002,gid=10000',
  'proxy-linux-test',
]);
run([
  'run',
  '--rm',
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--mount',
  `type=bind,source=${resolve('certificates')},target=/checks,readonly`,
  '--entrypoint',
  'python',
  'proxy-certificates',
  '-m',
  'unittest',
  'discover',
  '-s',
  '/checks',
  '-p',
  'test_*.py',
  '-v',
]);
try {
  run([...smoke, 'up', '-d', '--wait', '--wait-timeout', '45']);
  run(
    [...smoke, 'exec', '-T', '--user', '10001:10000', 'control', 'node', '--input-type=module'],
    readFileSync('test/smoke-client.js'),
  );
  run([
    ...smoke,
    'exec',
    '-T',
    '--user',
    '10003:10000',
    '-w',
    '/app',
    'certificates',
    'python',
    '-c',
    "import worker; p=worker.load_policy(); assert p['domains']==[]; print('PASS: certificate worker reads the sanitized SQLite policy from its read-only volume')",
  ]);
} finally {
  run([...smoke, 'down', '--volumes']);
}
