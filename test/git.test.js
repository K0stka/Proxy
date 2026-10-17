import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { gitEnvironment, gitProblem, repository, pullRepository, runGit } from '../files/git.js';

test('Git failures explain conflicts, access and networking without exposing remote credentials', () => {
  for (const [stderr, status, message] of [
    ['fatal: Not possible to fast-forward, aborting.', 409, /diverged/],
    ['There is no tracking information for the current branch.', 409, /upstream/],
    ['Permission denied (publickey).', 502, /authentication/],
    ['Host key verification failed.', 502, /known_hosts/],
    ["error: cannot open '.git/FETCH_HEAD': Permission denied", 400, /PROXY_FILES_UID/],
    ['fatal: Could not resolve host', 502, /connectivity/],
    [
      'fatal: unrecognized error at https://user:secret@example.com/repo.git',
      502,
      /Git pull failed/,
    ],
  ]) {
    const error = gitProblem(stderr);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /secret|user:|example\.com/);
  }
});

test(
  'isolated Git pulls fast-forward, reject dirty folders and symlinks, and never run hooks or filters',
  { skip: process.env.PROXY_FILES_TEST !== 'true', timeout: 30000 },
  async () => {
    assert.equal(process.getuid(), 1000);
    assert.match(await readFile('/proc/self/status', 'utf8'), /CapBnd:\s+0000000000000000/);
    const env = {
      ...gitEnvironment(),
      GIT_ALLOW_PROTOCOL: 'file:https:ssh',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    };
    const git = (cwd, ...args) =>
      execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    await mkdir('/tmp/seed');
    git('/tmp', 'init', '--bare', '/tmp/origin.git');
    git('/tmp/seed', 'init', '-b', 'main');
    await writeFile('/tmp/seed/index.html', 'old');
    await mkdir('/tmp/seed/nested/public', { recursive: true });
    await writeFile('/tmp/seed/nested/public/index.html', 'old nested site');
    await writeFile('/tmp/seed/.gitattributes', '*.html filter=danger');
    git('/tmp/seed', 'add', '.');
    git('/tmp/seed', 'commit', '-m', 'First');
    git('/tmp/seed', 'remote', 'add', 'origin', '/tmp/origin.git');
    git('/tmp/seed', 'push', '-u', 'origin', 'main');
    git('/tmp', 'clone', '-b', 'main', '/tmp/origin.git', '/sites/site');
    git('/sites/site', 'remote', 'set-url', 'origin', 'https://example.com/site.git');
    git('/sites/site', 'config', 'filter.danger.smudge', 'touch /tmp/filter-ran');
    git('/sites/site', 'config', 'filter.danger.required', 'true');
    await writeFile('/sites/site/.git/hooks/post-merge', '#!/bin/sh\ntouch /tmp/hook-ran\n', {
      mode: 0o755,
    });
    await writeFile('/tmp/seed/index.html', 'new');
    await writeFile('/tmp/seed/nested/public/index.html', 'new nested site');
    git('/tmp/seed', 'commit', '-am', 'Update');
    git('/tmp/seed', 'push');
    const runner = (args, cwd) =>
      runGit(
        args.includes('pull')
          ? ['-c', 'url.file:///tmp/origin.git.insteadOf=https://example.com/site.git', ...args]
          : args,
        cwd,
        env,
      );
    assert.deepEqual(await repository('site'), { directory: 'site', git: true });
    assert.deepEqual(await repository('site/nested/public'), {
      directory: 'site/nested/public',
      git: true,
    });
    assert.deepEqual(await pullRepository('site/nested/public', runner), { changed: true });
    assert.equal(await readFile('/sites/site/nested/public/index.html', 'utf8'), 'new nested site');
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'new');
    await assert.rejects(access('/tmp/hook-ran'));
    await assert.rejects(access('/tmp/filter-ran'));
    assert.deepEqual(await pullRepository('site', runner), { changed: false });
    let configurationCalls = 0;
    await assert.rejects(
      pullRepository('site', async () => {
        configurationCalls++;
        const error = new Error('Cannot read Git configuration');
        error.status = 502;
        throw error;
      }),
      /missing|symlink|writable/,
    );
    assert.equal(configurationCalls, 1);
    await writeFile('/sites/site/index.html', 'local edits');
    await assert.rejects(pullRepository('site', runner), /local changes/);
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'local edits');
    git('/sites/site', 'config', 'filter.danger.required', 'false');
    git('/sites/site', 'add', 'index.html');
    git('/sites/site', 'commit', '-m', 'Local commit');
    const localHead = git('/sites/site', 'rev-parse', 'HEAD');
    await writeFile('/tmp/seed/index.html', 'diverged');
    git('/tmp/seed', 'commit', '-am', 'Upstream diverges');
    git('/tmp/seed', 'push');
    await assert.rejects(
      pullRepository('site', runner),
      (error) => error.status === 409 && /diverged/.test(error.message),
    );
    assert.equal(git('/sites/site', 'rev-parse', 'HEAD'), localHead);
    assert.equal(await readFile('/sites/site/index.html', 'utf8'), 'local edits');
    await symlink('/tmp/seed', '/sites/link');
    assert.deepEqual(await repository('link'), { directory: 'link', git: false });
    await assert.rejects(pullRepository('link', runner), /missing|symlink/);
    await assert.rejects(pullRepository('../private', runner));
    // A sites mount may itself be the repository root, with a public folder selected in the UI.
    git('/tmp', 'init', '--bare', '/tmp/root-origin.git');
    git('/sites', 'init', '-b', 'main');
    await writeFile('/sites/.gitignore', '/*\n!/.gitignore\n!/root-dist/\n');
    await mkdir('/sites/root-dist');
    await writeFile('/sites/root-dist/index.html', 'old root site');
    git('/sites', 'add', '.gitignore', 'root-dist');
    git('/sites', 'commit', '-m', 'Root site');
    git('/sites', 'remote', 'add', 'origin', '/tmp/root-origin.git');
    git('/sites', 'push', '-u', 'origin', 'main');
    git('/tmp', 'clone', '-b', 'main', '/tmp/root-origin.git', '/tmp/root-seed');
    await writeFile('/tmp/root-seed/root-dist/index.html', 'new root site');
    git('/tmp/root-seed', 'commit', '-am', 'Root update');
    git('/tmp/root-seed', 'push');
    git('/sites', 'remote', 'set-url', 'origin', 'https://example.com/root.git');
    const rootRunner = (args, cwd) =>
      runGit(
        args.includes('pull')
          ? [
              '-c',
              'url.file:///tmp/root-origin.git.insteadOf=https://example.com/root.git',
              ...args,
            ]
          : args,
        cwd,
        env,
      );
    assert.deepEqual(await repository('root-dist'), { directory: 'root-dist', git: true });
    assert.deepEqual(await pullRepository('root-dist', rootRunner), { changed: true });
    assert.equal(await readFile('/sites/root-dist/index.html', 'utf8'), 'new root site');
    await mkdir('/tmp/ssh');
    await writeFile('/tmp/ssh/id_ed25519', 'test-only', { mode: 0o600 });
    await writeFile('/tmp/ssh/known_hosts', '');
    const sshConfig = execFileSync('/usr/local/bin/proxy-git-ssh', ['-G', 'git@example.com'], {
      env: { ...gitEnvironment(), PROXY_GIT_SSH_PATH: '/tmp/ssh' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(sshConfig, /batchmode yes/);
    assert.match(sshConfig, /stricthostkeychecking true/);
    assert.match(sshConfig, /identityfile \/tmp\/ssh\/id_ed25519/);
    assert.match(sshConfig, /userknownhostsfile \/tmp\/ssh\/known_hosts/);
    process.env.PROXY_KOMODO_SECRET = 'must-not-inherit';
    assert.equal(gitEnvironment().PROXY_KOMODO_SECRET, undefined);
  },
);
