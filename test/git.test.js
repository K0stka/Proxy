import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { gitEnvironment, repository, pullRepository, runGit } from '../files/git.js';

test('isolated Git pulls fast-forward, reject dirty folders and symlinks, and never run hooks or filters',
  { skip: process.env.PROXY_FILES_TEST !== 'true', timeout: 30000 }, async () => {
    assert.equal(process.getuid(), 1000);
    assert.match(await readFile('/proc/self/status', 'utf8'), /CapBnd:\s+0000000000000000/);
    const env = { ...gitEnvironment(), GIT_ALLOW_PROTOCOL: 'file:https:ssh', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    await mkdir('/tmp/seed');
    git('/tmp', 'init', '--bare', '/tmp/origin.git');
    git('/tmp/seed', 'init', '-b', 'main');
    await writeFile('/tmp/seed/index.html', 'old');
    await writeFile('/tmp/seed/.gitattributes', '*.html filter=danger');
    git('/tmp/seed', 'add', '.'); git('/tmp/seed', 'commit', '-m', 'First');
    git('/tmp/seed', 'remote', 'add', 'origin', '/tmp/origin.git');
    git('/tmp/seed', 'push', '-u', 'origin', 'main');
    git('/tmp', 'clone', '-b', 'main', '/tmp/origin.git', '/sites/site');
    git('/sites/site', 'remote', 'set-url', 'origin', 'https://example.com/site.git');
    git('/sites/site', 'config', 'filter.danger.smudge', 'touch /tmp/filter-ran');
    git('/sites/site', 'config', 'filter.danger.required', 'true');
    await writeFile('/sites/site/.git/hooks/post-merge', '#!/bin/sh\ntouch /tmp/hook-ran\n', { mode: 0o755 });
    await writeFile('/tmp/seed/index.html', 'new');
    git('/tmp/seed', 'commit', '-am', 'Update');git('/tmp/seed', 'push');
    const runner = (args, cwd) => runGit(args.includes('pull')
      ? ['-c', 'url.file:///tmp/origin.git.insteadOf=https://example.com/site.git', ...args] : args, cwd, env);
    assert.deepEqual(await repository('site'), { directory: 'site', git: true });
    await mkdir('/sites/site/nested/public', { recursive: true });
    assert.deepEqual(await repository('site/nested/public'), { directory: 'site/nested/public', git: true });
    assert.deepEqual(await pullRepository('site', runner), { changed: true });
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'new');
    await assert.rejects(access('/tmp/hook-ran')); await assert.rejects(access('/tmp/filter-ran'));
    assert.deepEqual(await pullRepository('site', runner), { changed: false });
    let configurationCalls = 0;
    await assert.rejects(pullRepository('site', async () => {
      configurationCalls++;
      const error = new Error('Cannot read Git configuration');
      error.status = 502;
      throw error;
    }), /missing|symlink|writable/);
    assert.equal(configurationCalls, 1);
    await writeFile('/sites/site/index.html', 'local edits');
    await assert.rejects(pullRepository('site', runner), /local changes/);
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'local edits');
    git('/sites/site', 'config', 'filter.danger.required', 'false');
    git('/sites/site', 'add', 'index.html');
    git('/sites/site', 'commit', '-m', 'Local commit');
    const localHead = git('/sites/site', 'rev-parse', 'HEAD');
    await writeFile('/tmp/seed/index.html', 'diverged');
    git('/tmp/seed', 'commit', '-am', 'Upstream diverges');git('/tmp/seed', 'push');
    await assert.rejects(pullRepository('site', runner), /Git pull failed/);
    assert.equal(git('/sites/site', 'rev-parse', 'HEAD'), localHead);
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'local edits');
    await symlink('/tmp/seed', '/sites/link');
    assert.deepEqual(await repository('link'), { directory: 'link', git: false });
    await assert.rejects(pullRepository('link', runner), /missing|symlink/);
    await assert.rejects(pullRepository('../private', runner));
    await mkdir('/tmp/ssh');
    await writeFile('/tmp/ssh/id_ed25519', 'test-only', { mode: 0o600 });
    await writeFile('/tmp/ssh/known_hosts', '');
    const sshConfig = execFileSync('/usr/local/bin/proxy-git-ssh', ['-G', 'git@example.com'], {
      env: { ...gitEnvironment(), PROXY_GIT_SSH_PATH: '/tmp/ssh' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(sshConfig, /batchmode yes/);
    assert.match(sshConfig, /stricthostkeychecking true/);
    assert.match(sshConfig, /identityfile \/tmp\/ssh\/id_ed25519/);
    assert.match(sshConfig, /userknownhostsfile \/tmp\/ssh\/known_hosts/);
    process.env.PROXY_KOMODO_SECRET = 'must-not-inherit';
    assert.equal(gitEnvironment().PROXY_KOMODO_SECRET, undefined);
  });
