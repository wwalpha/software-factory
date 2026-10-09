import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  chmod,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runProcess } from '../src/adapters/process.js';
import { checkVersion, ProtectedChecks } from '../src/adapters/checks.js';
import { SqliteStore } from '../src/adapters/sqlite.js';
import {
  FakeRunner,
  FakePlanner,
  type FakeEdit,
} from '../src/adapters/fake.js';
import { GuardService } from '../src/guard/service.js';
import { EvolutionService } from '../src/guard/evolution.js';
import { Runtime } from '../src/application/runtime.js';
import { digest } from '../src/adapters/artifacts.js';
import type {
  Models,
  ProjectProfile,
  MissionRevision,
} from '../src/domain/contracts.js';
import type { Settings } from '../src/adapters/config.js';
import type { GuardPort, OperationRequest } from '../src/ports/guard.js';
export const repositoryRoot = resolve(
  new URL('../..', import.meta.url).pathname,
);
const binding = {
  enabled: false,
  model: 'unconfigured',
  reasoning: 'low' as const,
  verifiedAt: null,
  priceReference: 'operator must verify official pricing',
  inputUsdPerMillion: null,
  outputUsdPerMillion: null,
  maxOutputTokens: 4096,
};
export const models: Models = {
  reasoner: { ...binding },
  engineer: { ...binding },
  scout: { ...binding },
};
export const edits: FakeEdit[] = [
  {
    path: 'range.ts',
    before: 'Math.min(max, value)',
    after: 'Math.max(min, Math.min(max, value))',
  },
  {
    path: 'names.ts',
    before: 'export function userNames',
    after:
      'export function normalizeName(name: string): string { return name.trim().toLowerCase(); }\nexport function userNames',
  },
  {
    path: 'names.ts',
    before: 'names.map((name) => name.trim().toLowerCase())',
    after: 'names.map(normalizeName)',
  },
];
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-test-'));
  const checkRoot = join(root, 'checks');
  await mkdir(checkRoot);
  const profiles: ProjectProfile[] = [];
  for (const [id, file] of [
    ['repair', 'range.ts'],
    ['refactor', 'names.ts'],
  ] as const) {
    const repository = join(root, id);
    await mkdir(repository);
    await writeFile(
      join(repository, file),
      await readFile(join(repositoryRoot, 'examples', id, file)),
    );
    for (const args of [
      ['init', '--quiet'],
      ['add', file],
      [
        '-c',
        'user.name=Factory Test',
        '-c',
        'user.email=factory@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
    ]) {
      const r = await runProcess('git', args, { cwd: repository });
      if (r.code) throw Error(r.stderr);
    }
    const checkFile = `${id}.test.mjs`;
    await writeFile(
      join(checkRoot, checkFile),
      await readFile(join(repositoryRoot, 'examples/checks', checkFile)),
    );
    const check = {
      id: `${id}-acceptance`,
      kind: 'node-test' as const,
      files: [checkFile],
    };
    profiles.push({
      id,
      repository,
      taskType: id === 'repair' ? 'bugfix' : 'refactor',
      scope: [file],
      acceptance: [
        {
          id: `${id}-works`,
          description: await readFile(
            join(repositoryRoot, 'examples', id, 'requirements.txt'),
            'utf8',
          ),
          checkId: check.id,
        },
      ],
      delegation: {
        operations: ['snapshot', 'build', 'check', 'seal', 'evaluate', 'adopt'],
        autoRecipe: true,
      },
      budget: { maxUsd: 10, maxAttempts: 6, maxMinutes: 10 },
      checks: [{ ...check, version: await checkVersion(checkRoot, check) }],
      checkRoot,
    });
  }
  const runtimeRoot = join(root, 'runtime'),
    guardRoot = join(root, 'guard');
  await mkdir(runtimeRoot);
  await mkdir(guardRoot);
  const tokenFiles = [];
  for (const name of ['runtime', 'guard', 'operator']) {
    const file = join(root, `${name}.token`);
    await writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    tokenFiles.push(file);
  }
  const config: Settings = {
    mode: 'fake',
    runtimeRoot,
    guardRoot,
    runtimeSocket: join(root, 'runtime.sock'),
    guardSocket: join(root, 'guard.sock'),
    operatorSocket: join(guardRoot, 'operator.sock'),
    runtimeTokenFile: tokenFiles[0] ?? '',
    guardTokenFile: tokenFiles[1] ?? '',
    operatorTokenFile: tokenFiles[2] ?? '',
    models,
    profiles,
    workerImage: null,
    fakeEdits: edits,
    fakeOmitFirst: true,
    suite: {
      id: 'initial-suite',
      cases: [
        {
          id: 'development-repair',
          partition: 'development',
          projectId: 'repair',
        },
        {
          id: 'separate-refactor',
          partition: 'separate',
          projectId: 'refactor',
        },
      ],
    },
  };
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return {
    root,
    config,
    configPath,
    profiles,
    cleanup: async () => {
      async function writable(path: string): Promise<void> {
        await chmod(path, 0o700);
        for (const entry of await readdir(path, { withFileTypes: true }))
          if (entry.isDirectory()) await writable(join(path, entry.name));
      }
      await writable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function harness(
  runner?: import('../src/ports/agents.js').RunnerPort,
) {
  const f = await fixture();
  const runtimeStore = await SqliteStore.open(
      join(f.config.runtimeRoot, 'runtime.db'),
    ),
    guardStore = await SqliteStore.open(join(f.config.guardRoot, 'guard.db'));
  const checks = new ProtectedChecks();
  const guard = new GuardService(
    {
      root: f.config.guardRoot,
      development: true,
      caller: 'factoryd',
      projects: f.profiles,
      models,
      secrets: ['sk-private-canary-secret'],
    },
    guardStore,
    runner ?? new FakeRunner(edits, true),
    checks,
  );
  await guard.initialize();
  const evolution = new EvolutionService(guard, checks, f.config.suite);
  const port: GuardPort = {
    operate: <T>(r: OperationRequest) => guard.operate(r) as Promise<T>,
    call: async <T>(method: string, p: unknown): Promise<T> => {
      if (method === 'followup') return (await evolution.followup(p)) as T;
      if (method === 'experimentDescriptor')
        return (await evolution.descriptor(String(p))) as T;
      if (method === 'experimentFix') return (await evolution.fix(p)) as T;
      if (method === 'experimentPropose') {
        const q = p as { id: string; prompt: string };
        return (await evolution.propose(q.id, q.prompt)) as T;
      }
      if (method === 'experimentRun')
        return (await evolution.run(String(p))) as T;
      return (await guard.call(method, p)) as T;
    },
  };
  const runtime = new Runtime(runtimeStore, new FakePlanner(), port, 'fake');
  async function grant(mission: MissionRevision) {
    const value = {
      id: `grant-${mission.id}`,
      caller: 'factoryd',
      projectId: mission.projectId,
      missionId: mission.id,
      operations: mission.delegation.operations,
      scope: mission.scope,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxUsd: mission.budget.maxUsd,
      missionDigest: digest(mission),
      releaseId: mission.factoryRelease,
    };
    await guard.operator('grant', { mission, grant: value });
    return value;
  }
  return {
    ...f,
    runtime,
    runtimeStore,
    guard,
    guardStore,
    checks,
    evolution,
    port,
    grant,
    close: async () => {
      await runtimeStore.close();
      await guardStore.close();
      await f.cleanup();
    },
  };
}
