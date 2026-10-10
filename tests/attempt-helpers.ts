import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { harness } from './helpers.js';
import { FakePlanner, FakeRunner } from '../src/adapters/fake.js';
import type { MissionState } from '../src/application/runtime.js';
import { Runtime } from '../src/application/runtime.js';
import { runProcess } from '../src/adapters/process.js';

export const deferred = () => {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  assert.ok(resolve);
  return { promise, resolve };
};

export const admissionHarness = async (
  maxAttempts: number,
  overlap = false,
) => {
  let starts = 0;
  let active = 0;
  let peak = 0;
  let overlapMs = 0;
  let overlapStart = 0;
  let dispatches = 0;
  let recordWrites = 0;
  let sqlMutations = 0;
  let transactions = 0;
  const admissionMs: number[] = [];
  const admissionStarts: number[] = [];
  const both = deferred();
  const entered = deferred();
  const release = deferred();
  const runner = new FakeRunner([]);
  const h = await harness({
    stop: async () => true,
    isStopped: async () => true,
    run: async (...args) => {
      starts++;
      active++;
      peak = Math.max(peak, active);
      if (active === 2) overlapStart = performance.now();
      entered.resolve();
      if (starts === 2) both.resolve();
      if (overlap) await release.promise;
      const out = await runner.run(...args);
      if (active === 2) overlapMs += performance.now() - overlapStart;
      active--;
      return {
        ...out,
        fact: { ...out.fact, outcome: 'refused' as const, handoff: null },
      };
    },
  });
  const profile = h.profiles[0];
  assert.ok(profile);
  profile.budget.maxAttempts = maxAttempts;
  await writeFile(
    join(profile.repository, 'extra.ts'),
    'export const extra=1;',
  );
  for (const args of [
    ['add', 'extra.ts'],
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'independent module',
    ],
  ]) {
    const result = await runProcess('git', args, { cwd: profile.repository });
    assert.equal(result.code, 0, result.stderr);
  }
  profile.scope.push('extra.ts');
  await writeFile(h.configPath, JSON.stringify(h.config));
  let durableStore = h.runtimeStore;
  const port = {
    ...h.port,
    operate: async <T>(
      request: import('../src/ports/guard.js').OperationRequest,
    ): Promise<T> => {
      if (request.type === 'build') {
        dispatches++;
        const began = admissionStarts[dispatches - 1];
        if (began !== undefined) admissionMs.push(performance.now() - began);
        assert.ok(
          await durableStore.get(
            'attempt',
            (request.payload as import('../src/ports/guard.js').BuildPayload)
              .attempt.id,
          ),
        );
        assert.ok(await durableStore.get('dispatch', request.id));
      }
      return h.port.operate<T>(request);
    },
  };
  const runtime = new Runtime(h.runtimeStore, new FakePlanner(), port, 'fake');
  const mission = await runtime.submit('independent builders', profile);
  await h.grant(mission);
  const list = h.runtimeStore.list.bind(h.runtimeStore);
  h.runtimeStore.list = async <T>(kind: string) => {
    if (
      kind === 'attempt' &&
      (await h.runtimeStore.get<MissionState>('state', mission.id))?.value.plan
    )
      admissionStarts.push(performance.now());
    return list<T>(kind);
  };
  const commit = h.runtimeStore.commit.bind(h.runtimeStore);
  h.runtimeStore.commit = async (...args) => {
    const result = await commit(...args);
    if (!result.duplicate) {
      recordWrites += args[0].length;
      sqlMutations += args[0].length + 1;
      transactions++;
      if (args[2]) sqlMutations++;
    }
    return result;
  };
  const reserve = h.runtimeStore.reserve.bind(h.runtimeStore);
  h.runtimeStore.reserve = async (...args) => {
    await reserve(...args);
    sqlMutations++;
    transactions++;
  };
  const settle = h.runtimeStore.settle.bind(h.runtimeStore);
  h.runtimeStore.settle = async (...args) => {
    await settle(...args);
    sqlMutations++;
    transactions++;
  };
  const ack = h.runtimeStore.ack.bind(h.runtimeStore);
  h.runtimeStore.ack = async (...args) => {
    await ack(...args);
    sqlMutations++;
  };

  return {
    ...h,
    runtime,
    mission,
    port,
    both,
    entered,
    release,
    setRuntimeStore: (
      store: import('../src/adapters/sqlite.js').SqliteStore,
    ) => {
      durableStore = store;
    },
    metrics: () => ({
      starts,
      dispatches,
      peak,
      overlapMs,
      admissionMs,
      recordWrites,
      sqlMutations,
      transactions,
    }),
  };
};

export const raceAtAttemptRead = (
  store: import('../src/adapters/sqlite.js').SqliteStore,
) => {
  const list = store.list.bind(store);
  const both = deferred();
  let reads = 0;
  store.list = async <T>(kind: string) => {
    const rows = await list<T>(kind);
    if (
      kind === 'attempt' &&
      reads < 2 &&
      (await store.list<{ plan: unknown }>('state')).some((r) => r.value.plan)
    ) {
      reads++;
      if (reads === 2) both.resolve();
      await both.promise;
    }
    return rows;
  };
};
