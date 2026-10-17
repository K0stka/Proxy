import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, access } from 'node:fs/promises';
import { openPath } from '../edge/sites.js';
import { parse, siteDirectory, Problem } from '../shared/model.js';

export const gitEnvironment = () => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'https:ssh',
  GIT_SSH_COMMAND: '/usr/local/bin/proxy-git-ssh',
  GIT_SSH_VARIANT: 'ssh',
  GIT_ATTR_NOSYSTEM: '1',
  PROXY_GIT_SSH_PATH: process.env.PROXY_GIT_SSH_PATH ?? '',
});

export function runGit(args, cwd, env = gitEnvironment()) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '',
      size = 0,
      failed = false;
    const kill = () => {
      failed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(kill, 120000);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (bytes) => {
        size += bytes.length;
        if (size > 1_000_000) kill();
        else if (stream === child.stdout) output += bytes.toString();
      });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Problem(502, 'Git could not start'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        const error = new Problem(
          502,
          'Git pull failed. Check repository access, SSH keys/known_hosts, write permissions and whether the branch can fast-forward.',
        );
        error.gitExitCode = failed ? null : code;
        reject(error);
      } else resolve(output.trimEnd());
    });
  });
}

const config = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.alternateRefsCommand=/bin/false',
  'credential.helper=',
  'submodule.recurse=false',
  'maintenance.auto=false',
  'gc.auto=0',
  'user.name=Proxy updater',
  'user.email=proxy@localhost',
  'merge.verifySignatures=false',
  'commit.gpgSign=false',
  'http.sslVerify=true',
  'http.lowSpeedLimit=1000',
  'http.lowSpeedTime=30',
];

async function openRepository(directory) {
  // Find a parent repository without ever searching above the mounted sites root.
  const checked = await openPath(directory);
  await checked.close();
  const parts = directory.split('/');
  for (let length = parts.length; length > 0; length--) {
    const root = await openPath(parts.slice(0, length).join('/'));
    try {
      const metadata = await open(
        `/proc/self/fd/${root.fd}/.git`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      return { root, metadata };
    } catch (error) {
      await root.close();
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Problem(400, 'No Git repository found inside /sites');
}

export async function repository(directory) {
  directory = parse(siteDirectory, directory);
  let handles;
  try {
    handles = await openRepository(directory);
    return { directory, git: true };
  } catch {
    return { directory, git: false };
  } finally {
    await handles?.metadata.close();
    await handles?.root.close();
  }
}

export async function pullRepository(directory, git = runGit) {
  directory = parse(siteDirectory, directory);
  let root, metadata;
  try {
    ({ root, metadata } = await openRepository(directory));
    const cwd = `/proc/${process.pid}/fd/${root.fd}`;
    const gitDir = `/proc/${process.pid}/fd/${metadata.fd}`;
    if (
      await lstat(`${gitDir}/commondir`).then(
        () => true,
        () => false,
      )
    )
      throw new Problem(400, 'Linked Git worktrees are not supported');
    await access(cwd, constants.W_OK);
    await access(gitDir, constants.W_OK);
    const base = [
      '--no-pager',
      `--git-dir=${gitDir}`,
      `--work-tree=${cwd}`,
      ...config.flatMap((value) => ['-c', value]),
      '-c',
      `safe.directory=${cwd}`,
    ];
    // Disable local checkout filters as well as hooks: pulling content must not run repository scripts.
    const filters = await git(
      [...base, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
      cwd,
    ).catch((error) => {
      if (error.gitExitCode === 1) return '';
      throw error;
    });
    for (const name of new Set(
      filters
        .split('\0')
        .filter(Boolean)
        .map((key) => key.slice(0, key.lastIndexOf('.'))),
    ))
      for (const [option, value] of [
        ['clean', ''],
        ['smudge', ''],
        ['process', ''],
        ['required', 'false'],
      ])
        base.push('-c', `${name}.${option}=${value}`);
    if (
      await git(
        [...base, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'],
        cwd,
      )
    )
      throw new Problem(409, 'Repository has local changes. Commit or remove them before pulling.');
    const before = await git([...base, 'rev-parse', 'HEAD'], cwd);
    await git(
      [...base, 'pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules'],
      cwd,
    );
    const after = await git([...base, 'rev-parse', 'HEAD'], cwd);
    return { changed: before !== after };
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(
      400,
      'Repository is missing, is a symlink, or is not writable by PROXY_FILES_UID',
    );
  } finally {
    await metadata?.close();
    await root?.close();
  }
}
