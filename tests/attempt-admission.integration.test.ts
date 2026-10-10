import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  admissionHarness,
  raceAtAttemptRead,
  deferred,
} from './attempt-helpers.js';
import { Runtime } from '../src/application/runtime.js';
import { FakePlanner, FakeRunner } from '../src/adapters/fake.js';
import { SqliteStore } from '../src/adapters/sqlite.js';
import type { Attempt } from '../src/domain/contracts.js';
import type { MissionState } from '../src/application/runtime.js';
import type { OperationRequest } from '../src/ports/guard.js';
import { runProcess } from '../src/adapters/process.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

test('P1-A: two independent builders cannot exceed maxAttempts=1', async (t) => {
  const h = await admissionHarness(1);
  try {
    raceAtAttemptRead(h.runtimeStore);
    let writes = 0;
    const commit = h.runtimeStore.commit.bind(h.runtimeStore);
    h.runtimeStore.commit = async (...args) => {
      writes += args[0].length;
      return commit(...args);
    };
    const start = performance.now();
    const result = await h.runtime.run(h.mission.id, 'fake');
    const attempts = await h.runtimeStore.list('attempt');
    t.diagnostic(
      JSON.stringify({
        attempts: attempts.length,
        ...h.metrics(),
        durationMs: performance.now() - start,
        recordWrites: writes,
      }),
    );
    assert.ok(attempts.length <= 1, `created ${attempts.length} attempts`);
    assert.ok(h.metrics().starts <= 1);
    assert.equal(result.status, 'waiting');
    const waiting = (await h.runtime.state(h.mission.id)).waiting;
    assert.ok(waiting);
    assert.match(waiting.reason, /budget/);
  } finally {
    await h.close();
  }
});

test(
  'P1-A: available two slots preserve overlapping runner execution and same-runtime exclusion',
  { timeout: 15000 },
  async (t) => {
    const h = await admissionHarness(2, true);
    try {
      raceAtAttemptRead(h.runtimeStore);
      const running = h.runtime.run(h.mission.id, 'fake');
      await h.entered.promise;
      await assert.rejects(
        h.runtime.run(h.mission.id, 'fake'),
        /active scheduler/,
      );
      await h.both.promise;
      h.release.resolve();
      await running;
      t.diagnostic(JSON.stringify(h.metrics()));
      assert.equal(h.metrics().peak, 2);
      assert.equal((await h.runtimeStore.list('attempt')).length, 2);
    } finally {
      h.release.resolve();
      await h.close();
    }
  },
);

for (const parallel of [false, true]) {
  for (const remaining of [0, 1, 2]) {
    test(`P1-A: remaining=${remaining}, parallel=${parallel} survives resume and replan`, async () => {
      const h = await admissionHarness(2);
      try {
        const row = await h.runtimeStore.get<MissionState>(
          'state',
          h.mission.id,
        );
        assert.ok(row);
        const consumed: Attempt[] = Array.from(
          { length: 2 - remaining },
          (_, i) => ({
            id: `consumed-${i}`,
            missionId: h.mission.id,
            workItemId: 'old-plan',
            epoch: i + 1,
            leaseUntil: new Date().toISOString(),
            baseDigest: 'old',
            operationId: `old-operation-${i}`,
            state: 'failed',
            stopped: true,
            waiting: null,
            usage: {
              certainty: 'measured',
              inputTokens: 0,
              outputTokens: 0,
              usd: 0,
            },
          }),
        );
        await h.runtimeStore.commit(
          [
            {
              kind: 'state',
              id: h.mission.id,
              expectedVersion: row.version,
              value: { ...row.value, attempts: consumed.map((a) => a.id) },
            },
            ...consumed.map((a) => ({
              kind: 'attempt',
              id: a.id,
              expectedVersion: 0,
              value: a,
            })),
          ],
          { id: 'seed-consumed', topic: 'test.seed', payload: {} },
        );
        const planner = new FakePlanner();
        const plan = planner.plan.bind(planner);
        planner.plan = async (...args) => {
          const proposal = await plan(...args);
          if (!parallel) {
            const [first, second] = proposal.value.items;
            assert.ok(first && second);
            second.dependsOn = [first.id];
          }
          return proposal;
        };
        // Completed builds let serial work proceed; protected verification is not needed for this budget test.
        h.guard.runner.run = new FakeRunner([]).run.bind(new FakeRunner([]));
        let starts = 0;
        const run = h.guard.runner.run.bind(h.guard.runner);
        h.guard.runner.run = async (...args) => {
          starts++;
          return run(...args);
        };
        const runtime = new Runtime(h.runtimeStore, planner, h.port, 'fake');
        const result = await runtime.run(h.mission.id, 'fake');
        if (remaining < 2) {
          assert.equal(result.status, 'waiting');
          assert.match(
            (await runtime.state(h.mission.id)).waiting?.reason ?? '',
            /budget/,
          );
        }
        assert.equal((await h.runtimeStore.list('attempt')).length, 2);
        assert.equal(starts, remaining);
        await runtime.run(h.mission.id, 'fake');
        assert.equal((await h.runtimeStore.list('attempt')).length, 2);
        assert.equal(starts, remaining);
      } finally {
        await h.close();
      }
    });
  }
}

test('P1-A: admission and Guard replay are idempotent and reject changed content', async (t) => {
  const h = await admissionHarness(1, true);
  try {
    const commit = h.runtimeStore.commit.bind(h.runtimeStore);
    let duplicate = 0;
    h.runtimeStore.commit = async (...args) => {
      const result = await commit(...args);
      if (args[2]) {
        assert.equal((await commit(...args)).duplicate, true);
        duplicate++;
        await assert.rejects(
          commit(args[0], { ...args[1], payload: 'changed' }, args[2]),
          /different request/,
        );
      }
      return result;
    };
    const running = h.runtime.run(h.mission.id, 'fake');
    await h.entered.promise;
    const dispatch = (
      await h.runtimeStore.list<OperationRequest>('dispatch')
    ).find((r) => r.value.type === 'build');
    assert.ok(dispatch);
    await assert.rejects(h.port.operate(dispatch.value), /in flight/);
    h.release.resolve();
    await running;
    await h.port.operate(dispatch.value);
    await assert.rejects(
      h.port.operate({ ...dispatch.value, amount: 0.19 }),
      /different request/,
    );
    assert.equal((await h.runtimeStore.list('attempt')).length, 1);
    assert.equal(duplicate, 1);
    assert.equal(h.metrics().starts, 1);
    const db = new DatabaseSync(join(h.config.runtimeRoot, 'runtime.db'));
    try {
      assert.equal(
        db
          .prepare('SELECT COUNT(*) n FROM reservations WHERE id=?')
          .get((dispatch.value.payload as { attempt: Attempt }).attempt.id)?.n,
        1,
      );
    } finally {
      db.close();
    }
    t.diagnostic(
      JSON.stringify({
        admissionReplays: duplicate,
        guardBuildSends: h.metrics().dispatches,
        runnerStarts: h.metrics().starts,
      }),
    );
  } finally {
    h.release.resolve();
    await h.close();
  }
});

test('P1-A: a failed admission transaction leaves no attempt, dispatch, or reservation', async () => {
  const h = await admissionHarness(1);
  try {
    const commit = h.runtimeStore.commit.bind(h.runtimeStore);
    h.runtimeStore.commit = async (writes, event, admission) => {
      if (admission)
        return commit(
          [
            ...writes,
            { kind: 'state', id: h.mission.id, expectedVersion: -1, value: {} },
          ],
          event,
          admission,
        );
      return commit(writes, event);
    };
    await h.runtime.run(h.mission.id, 'fake');
    assert.equal((await h.runtimeStore.list('attempt')).length, 0);
    assert.equal(
      (await h.runtimeStore.list<OperationRequest>('dispatch')).filter(
        (r) => r.value.type === 'build',
      ).length,
      0,
    );
    assert.equal(h.metrics().starts, 0);
    assert.equal(h.metrics().dispatches, 0);
    assert.deepEqual(await h.runtimeStore.balance(h.mission.id), {
      reserved: 0,
      spent: 0,
      unknown: 0,
    });
  } finally {
    await h.close();
  }
});

test('P1-A: lost commit response is reconciled before dispatch with original IDs', async () => {
  const h = await admissionHarness(1);
  try {
    const commit = h.runtimeStore.commit.bind(h.runtimeStore);
    h.runtimeStore.commit = async (...args) => {
      const result = await commit(...args);
      if (args[2]) throw Error('commit response lost');
      return result;
    };
    await h.runtime.run(h.mission.id, 'fake');
    assert.equal((await h.runtimeStore.list('attempt')).length, 1);
    assert.equal(h.metrics().starts, 1);
    assert.equal(h.metrics().dispatches, 1);
  } finally {
    await h.close();
  }
});

test('P1-A: uncertain dispatch retains charged unknown usage and waits without replay', async () => {
  const h = await admissionHarness(1);
  try {
    h.guard.runner.run = async () => {
      throw Error('effect outcome lost');
    };
    await h.runtime.run(h.mission.id, 'fake');
    const attempts = await h.runtimeStore.list<Attempt>('attempt');
    assert.equal(attempts.length, 1);
    const restarted = new Runtime(
      h.runtimeStore,
      new FakePlanner(),
      h.port,
      'fake',
    );
    await restarted.run(h.mission.id, 'fake');
    const balance = await h.runtimeStore.balance(h.mission.id);
    assert.equal(balance.spent, 0.2);
    assert.equal(balance.unknown, 1);
    assert.equal(h.metrics().dispatches, 1);
    assert.equal((await h.runtimeStore.list('attempt')).length, 1);
    assert.equal((await restarted.state(h.mission.id)).status, 'waiting');
  } finally {
    await h.close();
  }
});

for (const fault of ['before', 'after', 'dispatch'] as const) {
  test(`P1-A: process stop ${fault} admission/result survives Runtime and SQLite restart`, async (t) => {
    const h = await admissionHarness(1);
    const path = join(h.config.runtimeRoot, 'runtime.db');
    try {
      await h.runtimeStore.close();
      const stopped = await runProcess(
        process.execPath,
        [
          new URL('./fixtures/attempt-crash.js', import.meta.url).pathname,
          path,
          join(h.config.guardRoot, 'guard.db'),
          h.mission.id,
          fault,
        ],
        { timeoutMs: 15000 },
      );
      assert.notEqual(stopped.code, 0);
      assert.equal(stopped.code, -1, stopped.stderr);
      assert.equal(
        await readFile(join(h.config.runtimeRoot, 'fault-point.txt'), 'utf8'),
        fault,
      );
      let startsBeforeRestart = 0;
      if (fault === 'dispatch') {
        startsBeforeRestart = (
          await readFile(
            join(h.config.runtimeRoot, 'runner-starts.jsonl'),
            'utf8',
          )
        )
          .trim()
          .split('\n').length;
        assert.equal(startsBeforeRestart, 1);
      }
      const store = await SqliteStore.open(path);
      try {
        const attempts = await store.list<Attempt>('attempt');
        let accepted = 1;
        if (fault === 'before') accepted = 0;
        assert.equal(attempts.length, accepted);
        assert.equal(
          (await store.balance(h.mission.id)).reserved,
          accepted * 0.2,
        );
        h.setRuntimeStore(store);
        const runtime = new Runtime(store, new FakePlanner(), h.port, 'fake');
        if (fault === 'dispatch') {
          await runtime.run(h.mission.id, 'fake');
          assert.equal(h.metrics().starts, 0);
          assert.equal((await store.balance(h.mission.id)).spent, 0.2);
          assert.equal((await store.balance(h.mission.id)).unknown, 1);
        } else {
          const result = await runtime.run(h.mission.id, 'fake');
          assert.equal(result.status, 'waiting');
          assert.equal((await store.list('attempt')).length, 1);
          assert.equal(h.metrics().starts, 1);
        }
        t.diagnostic(
          JSON.stringify({
            fault,
            persistedBeforeRestart: accepted,
            guardBuildSends: h.metrics().dispatches,
            runnerStartsBeforeRestart: startsBeforeRestart,
            runnerStartsAfterRestart: h.metrics().starts,
          }),
        );
      } finally {
        await store.close();
      }
    } finally {
      // runtimeStore was already closed to transfer ownership to the child.
      await h.guardStore.close();
      await h.cleanup();
    }
  });
}

test('P1-A: concurrent identical Guard sends create only one Runner effect', async (t) => {
  const h = await admissionHarness(1);
  try {
    const get = h.guardStore.get.bind(h.guardStore);
    const both = deferred();
    let reads = 0;
    let target = '';
    h.guardStore.get = async <T>(kind: string, id: string) => {
      const row = await get<T>(kind, id);
      if (kind === 'operation' && id === target && reads < 2) {
        reads++;
        if (reads === 2) both.resolve();
        await both.promise;
      }
      return row;
    };
    const port = {
      ...h.port,
      operate: async <T>(request: OperationRequest): Promise<T> => {
        if (request.type !== 'build') return h.port.operate<T>(request);
        target = request.id;
        const results = await Promise.allSettled([
          h.port.operate<T>(request),
          h.port.operate<T>(request),
        ]);
        const succeeded = results.find((r) => r.status === 'fulfilled');
        assert.ok(succeeded && succeeded.status === 'fulfilled');
        assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
        return succeeded.value;
      },
    };
    const runtime = new Runtime(
      h.runtimeStore,
      new FakePlanner(),
      port,
      'fake',
    );
    await runtime.run(h.mission.id, 'fake');
    assert.equal(h.metrics().dispatches, 2);
    assert.equal(h.metrics().starts, 1);
    assert.equal((await h.runtimeStore.list('attempt')).length, 1);
    t.diagnostic(JSON.stringify(h.metrics()));
  } finally {
    await h.close();
  }
});

test('P1-A: independent SQLite connections fence admission and preserve consumed slots after revision', async () => {
  const h = await admissionHarness(1);
  const second = await SqliteStore.open(
    join(h.config.runtimeRoot, 'runtime.db'),
  );
  try {
    const commit = h.runtimeStore.commit.bind(h.runtimeStore);
    h.runtimeStore.commit = async (...args) => {
      if (args[2]) {
        const results = await Promise.allSettled([
          commit(...args),
          second.commit(...args),
        ]);
        for (const result of results) {
          assert.equal(result.status, 'fulfilled');
        }
        assert.equal(
          results.filter((r) => r.status === 'fulfilled' && !r.value.duplicate)
            .length,
          1,
        );
        const attemptWrite = args[0].find((w) => w.kind === 'attempt');
        const dispatchWrite = args[0].find((w) => w.kind === 'dispatch');
        const stateWrite = args[0].find((w) => w.kind === 'state');
        assert.ok(attemptWrite && dispatchWrite && stateWrite);
        const attempt = {
          ...(attemptWrite.value as Attempt),
          id: 'competing-attempt',
          operationId: 'competing-operation',
        };
        const request = dispatchWrite.value as OperationRequest;
        const state = stateWrite.value as MissionState;
        await assert.rejects(
          second.commit(
            [
              { ...attemptWrite, id: attempt.id, value: attempt },
              {
                ...dispatchWrite,
                id: attempt.operationId,
                value: {
                  ...request,
                  id: attempt.operationId,
                  payload: { ...(request.payload as object), attempt },
                },
              },
              {
                ...stateWrite,
                value: { ...state, attempts: [...state.attempts, attempt.id] },
              },
            ],
            { ...args[1], id: 'competing-admission' },
            { missionId: h.mission.id, attemptId: attempt.id },
          ),
          /Attempt budget exhausted/,
        );
        return { duplicate: false };
      }
      return commit(...args);
    };
    await h.runtime.run(h.mission.id, 'fake');
    assert.equal(h.metrics().starts, 1);
    h.runtimeStore.commit = commit;
    const revised = await h.runtime.revise(
      h.mission.id,
      'retain consumed attempts',
    );
    assert.equal((await h.runtime.state(h.mission.id)).attempts.length, 1);
    assert.equal(revised.revision, 2);
    // No grant for the new revision is needed to verify the transactional budget gate.
    await h.runtime.run(h.mission.id, 'fake');
    assert.equal((await second.list('attempt')).length, 1);
    assert.equal(h.metrics().starts, 1);
    assert.match(
      (await h.runtime.state(h.mission.id)).waiting?.reason ?? '',
      /Attempt budget exhausted/,
    );
  } finally {
    await second.close();
    await h.close();
  }
});
