import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareStorage({
  root = '/data',
  dataPath = process.env.PROXY_DATA_PATH,
  sitesPath = process.env.PROXY_SITES_PATH,
} = {}) {
  const paths = [dataPath, sitesPath].map((value) => {
    if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) === '/')
      throw Error('Set absolute, non-root PROXY_DATA_PATH and PROXY_SITES_PATH values');
    return posix.resolve(value);
  });
  if (
    paths[0] === paths[1] ||
    paths[0].startsWith(paths[1] + '/') ||
    paths[1].startsWith(paths[0] + '/')
  )
    throw Error('Keep sites outside the private data directory');
  const directories = [
    ['', 0, 0o700],
    ['control', 10001, 0o700],
    ['certificate-policy', 10001, 0o2750],
    ['edge', 10002, 0o700],
    ['certificates', 10003, 0o700],
    ['tls', 10003, 0o2750],
    ['cert-status', 10003, 0o2750],
    ['cert-requests', 10003, 0o2770],
  ];
  for (const [name, uid, mode] of directories) {
    const path = name ? `${root}/${name}` : root;
    await mkdir(path, { mode: 0o700, recursive: !name }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.chown(uid, 10000);
      await directory.chmod(mode);
    } finally {
      await directory.close();
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareStorage();
  console.log('Storage ready. Existing files were not modified.');
}
