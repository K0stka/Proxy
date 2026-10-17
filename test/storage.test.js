import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import { prepareStorage } from '../containers/init-storage.mjs';

test(
  'storage initializer prepares private directories, preserves files and rejects unsafe layouts',
  { skip: process.platform !== 'linux' || process.getuid?.() !== 0 },
  async (t) => {
    const base = await mkdtemp('/tmp/proxy-storage-');
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = base + '/data',
      options = { root, dataPath: '/srv/proxy/data', sitesPath: '/srv/proxy/sites' };
    await mkdir(root + '/control', { recursive: true });
    await writeFile(root + '/control/existing', 'keep');
    await chmod(root + '/control/existing', 0o644);
    await prepareStorage(options);
    await prepareStorage(options);
    for (const [name, uid, mode] of [
      ['control', 10001, 0o700],
      ['edge', 10002, 0o700],
      ['certificate-policy', 10001, 0o2750],
      ['certificates', 10003, 0o700],
      ['tls', 10003, 0o2750],
      ['cert-status', 10003, 0o2750],
      ['cert-requests', 10003, 0o2770],
    ]) {
      const info = await stat(root + '/' + name);
      assert.equal(info.uid, uid);
      assert.equal(info.gid, 10000);
      assert.equal(info.mode & 0o7777, mode);
    }
    const preserved = await stat(root + '/control/existing');
    assert.equal(preserved.uid, 0);
    assert.equal(preserved.mode & 0o777, 0o644);
    assert.equal(await readFile(root + '/control/existing', 'utf8'), 'keep');
    for (const [dataPath, sitesPath] of [
      ['/srv/proxy', '/srv/proxy/sites'],
      ['/srv/proxy/', '/srv/proxy/sites/'],
      ['/srv/proxy/sites/data', '/srv/proxy/sites'],
      ['/srv/proxy', '/srv/../srv/proxy'],
      ['/', '/srv/sites'],
      ['relative', '/srv/sites'],
    ])
      await assert.rejects(prepareStorage({ ...options, dataPath, sitesPath }));
    const unsafe = base + '/unsafe',
      target = base + '/target';
    await mkdir(unsafe);
    await mkdir(target);
    await chmod(target, 0o755);
    await symlink(target, unsafe + '/control');
    await assert.rejects(prepareStorage({ ...options, root: unsafe }));
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  },
);
