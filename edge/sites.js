import { errorPageTypes } from '../shared/pages.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Problem, parse, staticSiteSchema, siteDocument } from '../shared/model.js';

export const MAX_SITE_FILES = 5000;
const ROOT = '/sites';
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const directoryFlags = flags | constants.O_DIRECTORY;
const descriptorPath = (handle) => `/proc/self/fd/${handle.fd}`;

// Linux directory descriptors pin each parent. Renaming a folder or swapping in
// a symlink cannot redirect a later open outside the mounted content tree.
export async function openPath(relative, directory = true) {
  let current = await open(ROOT, directoryFlags);
  try {
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const next = await open(
        `${descriptorPath(current)}/${parts[i]}`,
        i === parts.length - 1 && !directory ? flags : directoryFlags,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export function glob(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        result += '(?:.*/)?';
        i++;
      } else result += '.*';
    } else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}
export function fileFilter(raw) {
  const spec = parse(staticSiteSchema, raw),
    include = spec.include.map(glob),
    exclude = spec.exclude.map(glob);
  // Dollar signs are excluded because NGINX expands variables in alias paths.
  return (path) =>
    !path.split('/').some((p) => p.startsWith('.')) &&
    !path.startsWith('_proxy/') &&
    !/[\\$\x00-\x1f]/.test(path) &&
    (!include.length || include.some((re) => re.test(path))) &&
    !exclude.some((re) => re.test(path));
}

async function entries(handle) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(descriptorPath(handle), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
export async function inspectSite(raw) {
  const spec = parse(staticSiteSchema, raw),
    allowed = fileFilter(spec),
    files = [];
  let root,
    visited = 0;
  try {
    root = await openPath(spec.directory);
  } catch {
    throw new Problem(400, 'Folder is missing, unreadable, or a symlink');
  }
  async function walk(handle, prefix = '', depth = 0) {
    for (const entry of await entries(handle)) {
      if (++visited > 10000 || files.length >= MAX_SITE_FILES || depth > 20)
        throw new Problem(400, 'Folder is too large; choose a smaller public directory');
      const path = prefix + entry.name;
      if (path.length > 1000 || /[\\\x00-\x1f]/.test(path)) continue;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        files.push({
          path: path + (entry.isDirectory() ? '/' : ''),
          allowed: false,
          reason: entry.isSymbolicLink() ? 'Symlink' : 'Dotfile',
        });
        continue;
      }
      if (entry.isDirectory()) {
        // Excluded trees need not be scanned just to report their rejection.
        if (
          !allowed(`${path}/__file__`) &&
          spec.exclude.some((pattern) => glob(pattern).test(`${path}/__file__`))
        ) {
          files.push({ path: `${path}/`, allowed: false, reason: 'Hidden' });
          continue;
        }
        let child;
        try {
          child = await open(`${descriptorPath(handle)}/${entry.name}`, directoryFlags);
          await walk(child, `${path}/`, depth + 1);
        } catch (e) {
          if (e instanceof Problem) throw e;
          throw new Problem(400, 'Folder changed or is unreadable; try again');
        } finally {
          await child?.close();
        }
      } else if (entry.isFile())
        files.push({ path, allowed: allowed(path), reason: allowed(path) ? null : 'Filtered' });
    }
  }
  try {
    await walk(root);
  } finally {
    await root.close();
  }
  const exposed = files.filter((f) => f.allowed).map((f) => f.path);
  return { directory: spec.directory, files, exposed, count: exposed.length };
}
export async function readSiteDocument(spec, document) {
  const parsed = parse(staticSiteSchema, spec);
  document = parse(siteDocument, document);
  let handle;
  try {
    handle = await openPath(`${parsed.directory}/${document}`, false);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_000_000) throw Error();
    const buffer = Buffer.alloc(1_000_001);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 1_000_000) throw Error();
    return buffer.subarray(0, size).toString('utf8');
  } catch {
    throw new Problem(400, 'Error page document is unreadable or too large');
  } finally {
    await handle?.close();
  }
}
export function errorDocument(html, code, document = 'index.html') {
  const parent = document.includes('/') ? document.slice(0, document.lastIndexOf('/') + 1) : '';
  const base = `<base href="/_proxy/errors/${code}/${parent.split('/').map(encodeURIComponent).join('/')}">`;
  // First base wins, including over any base already present in the selected bundle.
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (match) => match + base);
  if (/<!doctype[^>]*>/i.test(html))
    return html.replace(/<!doctype[^>]*>/i, (match) => match + base);
  return base + html;
}
export async function prepareSites(snapshot) {
  const sites = {},
    errors = {};
  let count = 0;
  for (const route of snapshot.routes.filter((r) => r.published && r.kind === 'static')) {
    sites[route.id] = await inspectSite(route.staticSite);
    count += sites[route.id].count;
  }
  for (const [code, key, documentKey] of errorPageTypes.map(([code, key]) => [code, key + 'Site', key + 'Document'])) {
    if (!snapshot.pages[key]) continue;
    const manifest = await inspectSite(snapshot.pages[key]);
    const document = snapshot.pages[documentKey];
    if (!manifest.exposed.includes(document))
      throw new Problem(400, 'Error page document must be exposed by its folder rules');
    count += manifest.count;
    errors[code] = {
      ...manifest,
      document,
      html: errorDocument(await readSiteDocument(snapshot.pages[key], document), code, document),
    };
  }
  if (count > 10000) throw new Problem(400, 'Too many exposed files across sites');
  return { sites, errors };
}
