import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';

test('startup prepares storage repeatedly and runs each role without setup privileges',
  { skip: process.env.PROXY_STARTUP_TEST !== 'true' }, () => {
    const env = { ...process.env, PROXY_DATA_PATH: '', PROXY_SITES_PATH: '' };
    writeFileSync('/state/existing', 'keep', { mode: 0o644 });
    const existing = statSync('/state/existing');
    for (const [role, uid, path, mode, caps] of [
      ['control', 10001, '/state', 0o700, '0'],
      ['certificates', 10003, '/certbot', 0o700, '0'],
      ['edge', 10002, '/runtime', 0o700, '400'],
    ]) {
      for (let attempt = 0; attempt < 2; attempt++)
        execFileSync('proxy-start', [role, process.execPath, '-e', `
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          assert.equal(process.getuid(), ${uid});
          assert.equal(process.getgid(), 10000);
          if (${uid} === 10001) {
            assert.equal(fs.readFileSync('/state/existing', 'utf8'), 'keep');
            assert.equal(fs.statSync('/state/existing').uid, ${existing.uid});
          }
          const status = fs.readFileSync('/proc/self/status', 'utf8');
          for (const kind of ['Eff', 'Prm', 'Bnd', 'Amb'])
            assert.equal(BigInt('0x' + status.match(new RegExp('Cap' + kind + ':\\\\s+(\\\\w+)'))[1]), BigInt('0x${caps}'));
          fs.writeFileSync('${path}/writable', 'ok');
        `], { env, stdio: 'pipe' });
      const info = statSync(path);
      assert.equal(info.uid, uid);
      assert.equal(info.gid, 10000);
      assert.equal(info.mode & 0o7777, mode);
    }
    for (const [data, sites] of [
      ['/srv/data/', '/srv/data/sites'],
      ['/srv/sites/data', '/srv/sites/'],
      ['/', '/srv/sites'],
      ['/srv/data', '/srv/data/../sites'],
    ])
      assert.throws(() => execFileSync('proxy-start', ['control', 'true'], {
        env: { ...env, PROXY_DATA_PATH: data, PROXY_SITES_PATH: sites }, stdio: 'pipe',
      }));
  });
