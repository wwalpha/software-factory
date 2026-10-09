import { createHash } from 'node:crypto';
import {
  readdir,
  lstat,
  readFile,
  mkdir,
  writeFile,
  realpath,
  chmod,
} from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { ensure, safePath, inScope } from '../domain/invariants.js';
import { runProcess } from './process.js';
import type { Tree } from '../domain/tree.js';
export type { Tree } from '../domain/tree.js';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
}
export function treeDigest(tree: Tree): string {
  return digest(tree);
}
export function changedPaths(base: Tree, next: Tree): string[] {
  return [...new Set([...Object.keys(base), ...Object.keys(next)])]
    .filter((p) => canonical(base[p]) !== canonical(next[p]))
    .sort();
}
export function validateTree(tree: Tree): void {
  ensure(Object.keys(tree).length <= 5000, 'tree', 'Too many files');
  let bytes = 0;
  for (const [path, file] of Object.entries(tree)) {
    ensure(
      safePath(path) &&
        typeof file.content === 'string' &&
        typeof file.executable === 'boolean',
      'path',
      'Unsafe file',
    );
    ensure(
      Buffer.from(file.content, 'base64').toString('base64') === file.content,
      'tree',
      'Invalid file bytes',
    );
    bytes += Buffer.byteLength(file.content, 'base64');
    ensure(bytes <= 16 * 1024 * 1024, 'tree', 'Tree too large');
  }
}
export function validateCandidate(
  base: Tree,
  next: Tree,
  scope: string[],
): void {
  validateTree(next);
  ensure(
    changedPaths(base, next).every((p) => inScope(p, scope)),
    'scope',
    'Candidate changed protected paths',
  );
}
export async function readTree(root: string): Promise<Tree> {
  const tree: Tree = {};
  const realRoot = await realpath(root);
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const path = join(dir, name),
        rel = relative(root, path);
      ensure(safePath(rel), 'path', 'Unsafe workspace path');
      const stat = await lstat(path);
      ensure(
        !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
        'path',
        'Links and special files are rejected',
      );
      ensure(
        (await realpath(path)).startsWith(realRoot + '/'),
        'path',
        'Path escapes workspace',
      );
      if (stat.isDirectory()) await walk(path);
      else {
        ensure(stat.nlink === 1, 'path', 'Hardlinks are rejected');
        ensure(stat.size <= 4 * 1024 * 1024, 'tree', 'File too large');
        tree[rel] = {
          content: (await readFile(path)).toString('base64'),
          executable: Boolean(stat.mode & 0o111),
        };
      }
    }
  }
  await walk(root);
  validateTree(tree);
  return tree;
}
export async function writeTree(
  root: string,
  tree: Tree,
  readonly = false,
): Promise<void> {
  validateTree(tree);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, file] of Object.entries(tree)) {
    const full = resolve(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(file.content, 'base64'), {
      flag: 'wx',
      mode: readonly
        ? file.executable
          ? 0o555
          : 0o444
        : file.executable
          ? 0o755
          : 0o644,
    });
  }
  if (readonly) await chmod(root, 0o555);
}
export async function trackedSnapshot(
  repository: string,
): Promise<{ tree: Tree; commit: string }> {
  const git = async (args: string[]) => {
    const r = await runProcess(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.attributesFile=/dev/null',
        ...args,
      ],
      { cwd: repository },
    );
    ensure(r.code === 0, 'git', 'Git snapshot command failed');
    return r.stdout;
  };
  const commit = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
  const listing = await git(['ls-tree', '-r', '-z', commit]);
  const tree: Tree = {};
  for (const row of listing.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(row);
    ensure(match, 'git', 'Submodules and special entries unsupported');
    const [, mode, blob, path] = match;
    ensure(
      path &&
        blob &&
        safePath(path) &&
        ['100644', '100755'].includes(mode ?? ''),
      'path',
      'Tracked secret/link/unsafe path rejected',
    );
    // cat-file reads object bytes without filters, hooks, or external diff drivers.
    const file = await runProcess('git', ['cat-file', 'blob', blob], {
      cwd: repository,
      maxBytes: 4 * 1024 * 1024,
    });
    ensure(file.code === 0, 'git', 'Object read failed');
    const actual = await lstat(resolve(repository, path));
    ensure(
      actual.isFile() && !actual.isSymbolicLink() && actual.nlink === 1,
      'path',
      'Tracked path is not a regular file',
    );
    ensure(
      (await readFile(resolve(repository, path))).equals(file.stdoutBytes) &&
        Boolean(actual.mode & 0o111) === (mode === '100755'),
      'dirty',
      'Tracked product differs from its committed base',
    );
    tree[path] = {
      content: file.stdoutBytes.toString('base64'),
      executable: mode === '100755',
    };
  }
  const index = await git(['ls-files', '--stage', '-z']);
  const expected = listing.replace(/ blob ([a-f0-9]+)\t/g, ' $1 0\t');
  ensure(
    index === expected,
    'dirty',
    'Staged project changes must be resolved by their owner',
  );
  validateTree(tree);
  return { tree, commit };
}
export function mergeTrees(base: Tree, current: Tree, incoming: Tree): Tree {
  const merged = { ...current };
  for (const path of changedPaths(base, incoming)) {
    ensure(
      canonical(current[path]) === canonical(base[path]) ||
        canonical(current[path]) === canonical(incoming[path]),
      'merge-conflict',
      `Conflicting change: ${path}`,
    );
    if (incoming[path]) merged[path] = incoming[path];
    else delete merged[path];
  }
  return merged;
}
