import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensure } from '../domain/invariants.js';
import { contract, parseYaml } from './contracts.js';
import type { Models, ProjectProfile } from '../domain/contracts.js';
import type { FakeEdit } from './fake.js';
import type { EvaluationSuite } from '../guard/evolution.js';
export interface Settings {
  mode: 'fake' | 'live';
  runtimeRoot: string;
  guardRoot: string;
  runtimeSocket: string;
  guardSocket: string;
  operatorSocket: string;
  runtimeTokenFile: string;
  guardTokenFile: string;
  operatorTokenFile: string;
  models: Models;
  profiles: ProjectProfile[];
  workerImage: string | null;
  fakeEdits: FakeEdit[];
  fakeOmitFirst: boolean;
  suite: EvaluationSuite;
}
export async function loadSettings(path: string): Promise<Settings> {
  const value: unknown = parseYaml(await readFile(path, 'utf8'));
  ensure(
    value && typeof value === 'object',
    'config',
    'Settings object required',
  );
  const keys = [
    'mode',
    'runtimeRoot',
    'guardRoot',
    'runtimeSocket',
    'guardSocket',
    'operatorSocket',
    'runtimeTokenFile',
    'guardTokenFile',
    'operatorTokenFile',
    'models',
    'profiles',
    'workerImage',
    'fakeEdits',
    'fakeOmitFirst',
    'suite',
  ];
  ensure(
    Object.keys(value).every((k) => keys.includes(k)) &&
      keys.every((k) => k in value),
    'config',
    'Unknown or missing settings field',
  );
  const s = value as Settings;
  ensure(s.mode === 'fake' || s.mode === 'live', 'config', 'Invalid mode');
  s.models = contract('Models', s.models);
  ensure(Array.isArray(s.profiles), 'config', 'Profiles required');
  s.profiles = s.profiles.map((p) => contract('ProjectProfile', p));
  for (const path of [
    s.runtimeRoot,
    s.guardRoot,
    s.runtimeSocket,
    s.guardSocket,
    s.operatorSocket,
    s.runtimeTokenFile,
    s.guardTokenFile,
    s.operatorTokenFile,
  ])
    ensure(
      typeof path === 'string' && resolve(path) === path,
      'config',
      'State/IPC paths must be absolute',
    );
  ensure(
    s.runtimeRoot !== s.guardRoot &&
      !s.guardRoot.startsWith(s.runtimeRoot + '/') &&
      !s.runtimeRoot.startsWith(s.guardRoot + '/'),
    'config',
    'Guard and runtime storage must be separate',
  );
  ensure(
    s.suite &&
      Array.isArray(s.suite.cases) &&
      s.suite.cases.length > 0 &&
      s.suite.cases.some((c) => c.partition === 'separate'),
    'config',
    'Separate evaluation cases required',
  );
  ensure(
    s.mode === 'fake' || s.workerImage,
    'config',
    'Live requires pinned worker image',
  );
  return s;
}
export async function token(path: string): Promise<string> {
  const value = (await readFile(path, 'utf8')).trim();
  ensure(value.length >= 32, 'auth', 'Invalid token');
  return value;
}
export async function ownerLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, 'owner.pid');
  try {
    const pid = Number(await readFile(path, 'utf8'));
    ensure(Number.isInteger(pid) && pid > 0, 'lock', 'Invalid owner lock');
    try {
      process.kill(pid, 0);
      throw new Error('Owner process still running');
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
      await unlink(path);
    }
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  const file = await open(path, 'wx', 0o600);
  await file.writeFile(String(process.pid));
  await file.close();
  return () => unlink(path);
}
