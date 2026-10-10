import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/adapters/sqlite.js';
import { runProcess } from '../src/adapters/process.js';
test('SQLite transaction survives separate-process kill on either side of commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-kill-'));
  try {
    for (const fault of ['before', 'after'] as const) {
      const path = join(root, `${fault}.db`);
      await runProcess(process.execPath, [
        new URL('./fixtures/store-crash.js', import.meta.url).pathname,
        path,
        fault,
      ]);
      const db = await SqliteStore.open(path);
      try {
        assert.equal(Boolean(await db.get('mission', 'm')), fault === 'after');
        assert.equal((await db.pending()).length, fault === 'after' ? 1 : 0);
      } finally {
        await db.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('event dedup, optimistic versions, reservations and settlements survive reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-db-')),
    path = join(root, 'runtime.db');
  let db = await SqliteStore.open(path);
  try {
    const writes = [
        {
          kind: 'state',
          id: 'm',
          expectedVersion: 0,
          value: { state: 'ready' },
        },
      ],
      event = { id: 'e', topic: 'ready', payload: { id: 'm' } };
    assert.equal((await db.commit(writes, event)).duplicate, false);
    assert.equal((await db.commit(writes, event)).duplicate, true);
    await assert.rejects(
      db.commit([{ ...writes[0]!, value: { state: 'changed' } }], event),
    );
    await assert.rejects(db.commit(writes, { ...event, id: 'e2' }));
    await db.reserve('r', 'm', 2, 3);
    await db.reserve('r', 'm', 2, 3);
    await assert.rejects(db.reserve('r', 'm', 1, 3));
    await assert.rejects(db.reserve('r2', 'm', 2, 3));
    await db.settle('r', null);
    await db.settle('r', null);
    await assert.rejects(db.settle('r', 0));
    await db.close();
    db = await SqliteStore.open(path);
    assert.deepEqual(await db.balance('m'), {
      reserved: 0,
      spent: 2,
      unknown: 1,
    });
    assert.equal((await db.pending()).length, 1);
    await db.ack('e');
    assert.equal((await db.pending()).length, 0);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('role journal reservation/settlement and outbox roll back together and preserve legacy event dedup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-role-db-'));
  const path = join(root, 'runtime.db');
  let db = await SqliteStore.open(path);
  try {
    const writes = [
      {
        kind: 'role-execution',
        id: 'role',
        expectedVersion: 0,
        value: { state: 'running' },
      },
    ];
    const event = { id: 'role-start', topic: 'role.execution', payload: {} };
    const budget = {
      reservation: { id: 'call', account: 'mission', amount: 0.1, limit: 1 },
    };
    await assert.rejects(
      db.commit(
        [
          ...writes,
          {
            ...writes[0],
            kind: 'conflict',
            id: 'bad',
            expectedVersion: 1,
            value: {},
          },
        ],
        event,
        undefined,
        budget,
      ),
    );
    assert.equal(await db.get('role-execution', 'role'), null);
    assert.deepEqual(await db.balance('mission'), {
      reserved: 0,
      spent: 0,
      unknown: 0,
    });
    assert.deepEqual(await db.pending(), []);
    await db.commit(writes, event, undefined, budget);
    assert.equal(
      (await db.commit(writes, event, undefined, budget)).duplicate,
      true,
    );
    await assert.rejects(
      db.commit(writes, event, undefined, {
        reservation: { ...budget.reservation, amount: 0.2 },
      }),
      /different request/,
    );
    const finished = [
      {
        ...writes[0],
        kind: 'role-execution',
        id: 'role',
        expectedVersion: 1,
        value: { state: 'completed', result: 'report' },
      },
    ];
    const resultEvent = {
      id: 'role-result',
      topic: 'role.completed',
      payload: {},
    };
    const settlement = { settlements: [{ id: 'call', actual: 0.02 }] };
    await assert.rejects(
      db.commit(
        [
          ...finished,
          { kind: 'conflict', id: 'bad', expectedVersion: 1, value: {} },
        ],
        resultEvent,
        undefined,
        settlement,
      ),
    );
    assert.deepEqual(await db.balance('mission'), {
      reserved: 0.1,
      spent: 0,
      unknown: 0,
    });
    assert.deepEqual((await db.get('role-execution', 'role'))?.value, {
      state: 'running',
    });
    await db.commit(finished, resultEvent, undefined, settlement);
    await db.close();
    db = await SqliteStore.open(path);
    assert.equal(
      (await db.commit(finished, resultEvent, undefined, settlement)).duplicate,
      true,
    );
    assert.deepEqual(await db.balance('mission'), {
      reserved: 0,
      spent: 0.02,
      unknown: 0,
    });
    await assert.rejects(db.settle('call', null), /Settlement changed/);

    const legacyWrites = [
      {
        kind: 'state',
        id: 'legacy',
        expectedVersion: 0,
        value: { status: 'waiting' },
      },
    ];
    const legacyEvent = { id: 'legacy-event', topic: 'legacy', payload: {} };
    await db.commit(legacyWrites, legacyEvent);
    assert.equal((await db.commit(legacyWrites, legacyEvent)).duplicate, true);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
