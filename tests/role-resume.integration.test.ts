import test from 'node:test';
import OpenAI from 'openai';
import { deferred } from './attempt-helpers.js';
import assert from 'node:assert/strict';
import { harness, edits } from './helpers.js';
import { RolePlanner, roleHarness } from './role-helpers.js';
import type { MissionState } from '../src/application/runtime.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../src/adapters/process.js';
import { digest } from '../src/adapters/artifacts.js';
import type {
  AuthorityGrant,
  FactoryRelease,
} from '../src/domain/contracts.js';
import { FakeRunner } from '../src/adapters/fake.js';
import { Runtime } from '../src/application/runtime.js';
import { FactoryError } from '../src/domain/invariants.js';

test('P1-B: planned role retries once on explicit resume', async () => {
  const h = await harness(new FakeRunner(edits));
  try {
    const planner = new RolePlanner();
    const runtime = new Runtime(h.runtimeStore, planner, h.port, 'fake');
    const profile = h.profiles[0];
    assert.ok(profile);
    profile.budget.maxAttempts = 1;
    const m = await runtime.submit('repair with investigation', profile);
    await h.grant(m);
    assert.equal((await runtime.run(m.id, 'fake')).status, 'waiting');
    assert.equal(planner.calls.get('inspect-alpha'), 1);
    const after = await runtime.resume(m.id, 'fake');
    console.log(
      'P1-B probe',
      JSON.stringify({
        status: after.status,
        roleCalls: planner.calls.get('inspect-alpha'),
        budget: await h.runtimeStore.balance(m.id),
      }),
    );
    assert.equal(after.status, 'completed');
    assert.equal(planner.calls.get('inspect-alpha'), 2);
    assert.equal((await runtime.state(m.id)).attempts.length, 1);
  } finally {
    await h.close();
  }
});

for (const role of ['explorer', 'test-designer'] as const) {
  test(`P1-B: ${role} survives SQLite reopen; run/recover alone cannot retry`, async () => {
    const planner = new RolePlanner();
    planner.role = role;
    planner.itemId = `task-${role}-other-id`;
    const h = await roleHarness(planner);
    try {
      assert.equal(
        (await h.runtime.run(h.mission.id, 'fake')).status,
        'waiting',
      );
      const [failed] = await h.executions();
      assert.ok(failed);
      assert.equal(failed.retryable, true);
      assert.equal(failed.calls.length, 1);
      assert.equal(failed.calls[0]?.usage.certainty, 'unknown');
      await h.restart();
      await h.runtime.recover(h.mission.id);
      await h.runtime.run(h.mission.id, 'fake');
      assert.equal(planner.calls.get(planner.itemId), 1);
      assert.equal(
        (await h.runtime.resume(h.mission.id, 'fake')).status,
        'completed',
      );
      assert.equal(planner.calls.get(planner.itemId), 2);
      assert.deepEqual(await h.store.balance(h.mission.id), {
        reserved: 0,
        spent: 0.1 + 0.02,
        unknown: 1,
      });
      const [completed] = await h.executions();
      assert.ok(completed?.result);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.calls.length, 2);
      assert.notEqual(completed.calls[0]?.id, completed.calls[1]?.id);
      assert.equal((await h.runtime.state(h.mission.id)).attempts.length, 1);
      await h.restart();
      await h.runtime.resume(h.mission.id, 'fake');
      assert.equal(planner.calls.get(planner.itemId), 2);
      assert.deepEqual((await h.executions())[0]?.result, completed.result);
    } finally {
      await h.close();
    }
  });
}

test('P1-B: persistent transient rejection is limited to one call per explicit resume', async () => {
  const planner = new RolePlanner();
  planner.failures = Infinity;
  const h = await roleHarness(planner);
  try {
    await h.runtime.run(h.mission.id, 'fake');
    for (let count = 2; count <= 4; count++) {
      assert.equal(
        (await h.runtime.resume(h.mission.id, 'fake')).status,
        'waiting',
      );
      assert.equal(planner.calls.get(planner.itemId), count);
      assert.equal((await h.executions())[0]?.calls.length, count);
      assert.equal((await h.runtime.state(h.mission.id)).attempts.length, 0);
    }
    const balance = await h.store.balance(h.mission.id);
    assert.equal(balance.spent, 0.4);
    assert.equal(balance.unknown, 4);
  } finally {
    await h.close();
  }
});

test('P1-B: independent completed role retains its report across retries and restarts', async () => {
  const planner = new RolePlanner();
  planner.independent = true;
  const h = await roleHarness(planner);
  try {
    await h.runtime.run(h.mission.id, 'fake');
    assert.equal(
      (await h.runtime.state(h.mission.id)).work['review-beta'],
      'completed',
    );
    const report = (await h.executions()).find(
      (e) => e.workItemId === 'review-beta',
    )?.result;
    assert.ok(report);
    await h.restart();
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(planner.calls.get('review-beta'), 1);
    assert.equal(planner.calls.get(planner.itemId), 2);
    assert.deepEqual(
      (await h.executions()).find((e) => e.workItemId === 'review-beta')
        ?.result,
      report,
    );
  } finally {
    await h.close();
  }
});

for (const code of ['refused', 'invalid-output', 'scope', 'approval']) {
  test(`P1-B: ${code} requires human revision; resume does not approve or replay`, async () => {
    const planner = new RolePlanner();
    planner.error = new FactoryError(code, 'Test rejection');
    const h = await roleHarness(planner);
    try {
      await h.runtime.run(h.mission.id, 'fake');
      await h.restart();
      assert.equal(
        (await h.runtime.resume(h.mission.id, 'fake')).status,
        'waiting',
      );
      assert.equal(planner.calls.get(planner.itemId), 1);
      const [execution] = await h.executions();
      assert.equal(execution?.retryable, false);
      if (code === 'approval') assert.equal(execution?.state, 'waiting');
      else assert.equal(execution?.state, 'failed');
      assert.match(
        execution?.waiting?.resumeCondition ?? '',
        /new mission revision/,
      );
      assert.equal(execution?.waiting?.owner, 'operator');
    } finally {
      await h.close();
    }
  });
}

for (const error of [
  new Error('unknown exception'),
  new FactoryError('unrecognized-provider-code', 'Unclassified failure'),
  new FactoryError('uncertain', 'lost outcome'),
]) {
  test(`P1-B: ${error.name}/${error.message} is uncertain, charged and never automatically resent`, async () => {
    const planner = new RolePlanner();
    planner.error = error;
    const h = await roleHarness(planner);
    try {
      await h.runtime.run(h.mission.id, 'fake');
      await h.restart();
      await h.runtime.resume(h.mission.id, 'fake');
      assert.equal(planner.calls.get(planner.itemId), 1);
      assert.equal((await h.executions())[0]?.state, 'uncertain');
      assert.deepEqual(await h.store.balance(h.mission.id), {
        reserved: 0,
        spent: 0.1,
        unknown: 1,
      });
      assert.equal((await h.runtime.state(h.mission.id)).status, 'waiting');
    } finally {
      await h.close();
    }
  });
}

test('P1-B: cancel is terminal for run, resume and recovery', async () => {
  const h = await roleHarness();
  try {
    await h.runtime.run(h.mission.id, 'fake');
    await h.runtime.cancel(h.mission.id);
    await h.restart();
    assert.equal((await h.runtime.recover(h.mission.id)).status, 'cancelled');
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'cancelled',
    );
    assert.equal(h.planner.calls.get(h.planner.itemId), 1);
  } finally {
    await h.close();
  }
});

test('P1-B: saved bounded-read response is reused when only the followup failed', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  planner.reads = true;
  planner.followupFailures = 1;
  const h = await roleHarness(planner);
  try {
    assert.equal((await h.runtime.run(h.mission.id, 'fake')).status, 'waiting');
    await h.restart();
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(planner.calls.get(planner.itemId), 1);
    assert.equal(planner.calls.get(planner.itemId + ':read'), 2);
    const [execution] = await h.executions();
    assert.equal(execution?.calls.length, 3);
    assert.equal(execution?.result?.reads.paths.length, 0);
    assert.ok(
      Math.abs((await h.store.balance(h.mission.id)).spent - 0.14) < 1e-9,
    );
  } finally {
    await h.close();
  }
});

test('P1-B: atomic completion failure never exposes completed without a report', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const h = await roleHarness(planner);
  try {
    const commit = h.store.commit.bind(h.store);
    let injected = false;
    h.store.commit = async (...args) => {
      if (args[1].topic === 'role.completed' && !injected) {
        injected = true;
        // Fail after SQLite has processed earlier writes in this same transaction.
        const writes = [
          ...args[0],
          { kind: 'state', id: h.mission.id, expectedVersion: -1, value: {} },
        ];
        return commit(writes, args[1], args[2], args[3]);
      }
      return commit(...args);
    };
    assert.equal((await h.runtime.run(h.mission.id, 'fake')).status, 'waiting');
    assert.equal(injected, true);
    assert.notEqual(
      (await h.runtime.state(h.mission.id)).work[planner.itemId],
      'completed',
    );
    assert.equal((await h.executions())[0]?.result, null);
    await h.restart();
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(planner.calls.get(planner.itemId), 1);
    assert.ok((await h.executions())[0]?.result);
  } finally {
    await h.close();
  }
});

test('P1-B: lost commit replies reuse both response and atomic completion', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const h = await roleHarness(planner);
  try {
    const commit = h.store.commit.bind(h.store);
    let lost = 0;
    h.store.commit = async (...args) => {
      const result = await commit(...args);
      if (args[1].topic.startsWith('role.')) {
        lost++;
        throw Error('lost persistence reply');
      }
      return result;
    };
    assert.equal(
      (await h.runtime.run(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(lost, 3);
    assert.equal(planner.calls.get(planner.itemId), 1);
    await h.restart();
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(planner.calls.get(planner.itemId), 1);
  } finally {
    await h.close();
  }
});

for (const legacyWork of [
  'pending',
  'running',
  'waiting',
  'completed',
] as const) {
  test(`P1-B: ambiguous legacy ${legacyWork} is held without fabricated completion`, async () => {
    const h = await roleHarness();
    try {
      await h.runtime.run(h.mission.id, 'fake');
      const row = await h.store.get<MissionState>('state', h.mission.id);
      assert.ok(row?.value.plan);
      // A different legacy ID has no role execution record.
      const item = row.value.plan.items.find((i) => i.role !== 'builder');
      assert.ok(item);
      const oldId = item.id;
      item.id = 'legacy-missing-history';
      delete row.value.work[oldId];
      row.value.work[item.id] = legacyWork;
      for (const work of row.value.plan.items)
        work.dependsOn = work.dependsOn.map((dep) => {
          if (dep === oldId) return item.id;
          return dep;
        });
      delete row.value.roleJournalVersion;
      await h.store.commit(
        [
          {
            kind: 'state',
            id: h.mission.id,
            expectedVersion: row.version,
            value: row.value,
          },
        ],
        { id: randomUUID(), topic: 'test.legacy', payload: {} },
      );
      await h.restart();
      await h.runtime.resume(h.mission.id, 'fake');
      const state = await h.runtime.state(h.mission.id);
      assert.equal(state.work[item.id], 'waiting');
      assert.match(state.waiting?.reason ?? '', /legacy/);
      assert.equal(h.planner.calls.get(item.id), undefined);
    } finally {
      await h.close();
    }
  });
}

for (const fault of [
  'admission-before',
  'admission-after',
  'dispatch',
  'response-before',
  'response-after',
  'completion-before',
  'completion-after',
]) {
  test(`P1-B: real process stop at ${fault} preserves replay and accounting boundaries`, async (t) => {
    const planner = new RolePlanner();
    planner.failures = 0;
    const h = await roleHarness(planner);
    try {
      await h.store.close();
      let stopped;
      try {
        stopped = await runProcess(
          process.execPath,
          [
            new URL('./fixtures/role-crash.js', import.meta.url).pathname,
            join(h.config.runtimeRoot, 'runtime.db'),
            join(h.config.guardRoot, 'guard.db'),
            h.mission.id,
            fault,
          ],
          { timeoutMs: 15000 },
        );
      } finally {
        await h.restart(true);
      }
      assert.equal(stopped.code, -1, stopped.stderr);
      assert.equal(
        await readFile(join(h.config.runtimeRoot, 'role-fault.txt'), 'utf8'),
        fault,
      );
      let before = 0;
      if (!fault.startsWith('admission-')) {
        before = (
          await readFile(
            join(h.config.runtimeRoot, 'role-starts.jsonl'),
            'utf8',
          )
        )
          .trim()
          .split('\n').length;
        assert.equal(before, 1);
      }
      const uncertain = [
        'admission-after',
        'dispatch',
        'response-before',
      ].includes(fault);
      const result = await h.runtime.resume(h.mission.id, 'fake');
      const [execution] = await h.executions();
      assert.ok(execution);
      if (uncertain) {
        assert.equal(result.status, 'waiting');
        assert.equal(execution.state, 'uncertain');
        assert.equal(execution.result, null);
        assert.deepEqual(await h.store.balance(h.mission.id), {
          reserved: 0,
          spent: 0.1,
          unknown: 1,
        });
        await h.runtime.resume(h.mission.id, 'fake');
        assert.equal(planner.calls.get(planner.itemId), undefined);
        assert.notEqual(
          (await h.runtime.state(h.mission.id)).work[planner.itemId],
          'completed',
        );
      } else {
        assert.equal(result.status, 'completed');
        assert.equal(execution.state, 'completed');
        assert.ok(execution.result);
        assert.equal(before + (planner.calls.get(planner.itemId) ?? 0), 1);
        assert.deepEqual(await h.store.balance(h.mission.id), {
          reserved: 0,
          spent: 0.02,
          unknown: 0,
        });
      }
      t.diagnostic(
        JSON.stringify({
          fault,
          before,
          after: planner.calls.get(planner.itemId) ?? 0,
          status: result.status,
          budget: await h.store.balance(h.mission.id),
        }),
      );
    } finally {
      await h.close();
    }
  });
}

for (const code of ['auth-expired', 'binding']) {
  test(`P1-B: ${code} can resume after operator correction, never during automatic recovery`, async () => {
    const planner = new RolePlanner();
    planner.error = new FactoryError(code, 'Provider access unavailable');
    planner.failures = Infinity;
    const h = await roleHarness(planner);
    try {
      await h.runtime.run(h.mission.id, 'fake');
      await h.restart();
      await h.runtime.recover(h.mission.id);
      await h.runtime.run(h.mission.id, 'fake');
      assert.equal(planner.calls.get(planner.itemId), 1);
      assert.equal((await h.executions())[0]?.failureCode, code);
      planner.failures = 0; // The external provider now accepts the corrected credentials/configuration.
      assert.equal(
        (await h.runtime.resume(h.mission.id, 'fake')).status,
        'completed',
      );
      assert.equal(planner.calls.get(planner.itemId), 2);
    } finally {
      await h.close();
    }
  });
}

test('P1-B: expired grant is rechecked before any resumed provider call', async () => {
  const h = await roleHarness();
  try {
    await h.runtime.run(h.mission.id, 'fake');
    const row = await h.guardStore.get<AuthorityGrant>(
      'grant',
      h.grantValue.id,
    );
    assert.ok(row);
    await h.guardStore.commit(
      [
        {
          kind: 'grant',
          id: row.id,
          expectedVersion: row.version,
          value: { ...row.value, expiresAt: '2000-01-01T00:00:00.000Z' },
        },
      ],
      { id: randomUUID(), topic: 'test.expired-grant', payload: {} },
    );
    await h.restart();
    await h.runtime.resume(h.mission.id, 'fake');
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(h.planner.calls.get(h.planner.itemId), 1);
    assert.equal((await h.executions())[0]?.failureCode, 'grant');
    assert.equal((await h.runtime.state(h.mission.id)).status, 'waiting');
    assert.deepEqual(await h.store.balance(h.mission.id), {
      reserved: 0,
      spent: 0.1,
      unknown: 1,
    });
    // Use the existing operator revision/grant path, not a fabricated renewal API.
    const revision = await h.runtime.revise(
      h.mission.id,
      'Operator renewed authorization after expiry',
    );
    const grantId = (await h.runtime.state(h.mission.id)).grantId;
    await h.guard.operator('grant', {
      mission: revision,
      grant: { ...h.grantValue, id: grantId, missionDigest: digest(revision) },
    });
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(h.planner.calls.get(h.planner.itemId), 2);
  } finally {
    await h.close();
  }
});

test('P1-B: revoked release blocks resumed roles at the real Guard boundary', async () => {
  const h = await roleHarness();
  try {
    await h.runtime.run(h.mission.id, 'fake');
    const row = await h.guardStore.get<FactoryRelease>(
      'release',
      h.mission.factoryRelease,
    );
    assert.ok(row);
    await h.guardStore.commit(
      [
        {
          kind: 'release',
          id: row.id,
          expectedVersion: row.version,
          value: { ...row.value, stage: 'revoked' },
        },
      ],
      { id: randomUUID(), topic: 'test.revoked-release', payload: {} },
    );
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(h.planner.calls.get(h.planner.itemId), 1);
    assert.equal((await h.executions())[0]?.failureCode, 'revoked');
    assert.equal((await h.runtime.state(h.mission.id)).status, 'waiting');
  } finally {
    await h.close();
  }
});

test('P1-B: budget denial creates no provider call/reservation and resumes after a known unused hold is released', async () => {
  const h = await roleHarness();
  try {
    await h.runtime.run(h.mission.id, 'fake');
    await h.store.reserve('test-known-unused-hold', h.mission.id, 9.85, 10);
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'waiting',
    );
    assert.equal(h.planner.calls.get(h.planner.itemId), 1);
    const [blocked] = await h.executions();
    assert.equal(blocked?.failureCode, 'budget');
    assert.equal(blocked?.calls.length, 1);
    assert.equal((await h.store.balance(h.mission.id)).reserved, 9.85);
    await h.store.settle('test-known-unused-hold', 0);
    await h.restart();
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(h.planner.calls.get(h.planner.itemId), 2);
    assert.deepEqual(await h.store.balance(h.mission.id), {
      reserved: 0,
      spent: 0.1 + 0.02,
      unknown: 1,
    });
  } finally {
    await h.close();
  }
});

test('P1-B: elapsed mission time cannot be reset by role resume', async () => {
  const h = await roleHarness();
  try {
    await h.runtime.run(h.mission.id, 'fake');
    const row = await h.store.get<MissionState>('state', h.mission.id);
    assert.ok(row);
    row.value.startedAt = '2000-01-01T00:00:00.000Z';
    await h.store.commit(
      [
        {
          kind: 'state',
          id: row.id,
          expectedVersion: row.version,
          value: row.value,
        },
      ],
      { id: randomUUID(), topic: 'test.elapsed', payload: {} },
    );
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(h.planner.calls.get(h.planner.itemId), 1);
    assert.match(
      (await h.runtime.state(h.mission.id)).waiting?.reason ?? '',
      /time budget/,
    );
  } finally {
    await h.close();
  }
});

test('P1-B: approval hold advances only through human revision and a fresh matching grant', async () => {
  const planner = new RolePlanner();
  planner.error = new FactoryError('approval', 'Human decision required');
  const h = await roleHarness(planner);
  try {
    await h.runtime.run(h.mission.id, 'fake');
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(planner.calls.get(planner.itemId), 1);
    const revision = await h.runtime.revise(
      h.mission.id,
      'Human supplied the missing decision',
    );
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(planner.calls.get(planner.itemId), 1);
    await h.guard.operator('grant', {
      mission: revision,
      grant: {
        ...h.grantValue,
        id: (await h.runtime.state(h.mission.id)).grantId,
        missionDigest: digest(revision),
      },
    });
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    const executions = await h.executions();
    assert.equal(
      executions.find((e) => e.missionRevision === 1)?.state,
      'waiting',
    );
    assert.equal(
      executions.find((e) => e.missionRevision === 2)?.state,
      'completed',
    );
    assert.equal(planner.calls.get(planner.itemId), 2);
  } finally {
    await h.close();
  }
});

test('P1-B: never-started legacy ready plan is safe to execute', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const h = await roleHarness(planner);
  try {
    const plan = (
      await planner.plan(h.mission, 0, {}, new AbortController().signal)
    ).value;
    const snapshot = await h.port.operate<{
      tree: import('../src/domain/tree.js').Tree;
    }>({
      id: randomUUID(),
      grantId: h.grantValue.id,
      mission: h.mission,
      type: 'snapshot',
      targetDigest: digest('snapshot'),
      amount: 0.01,
      payload: {},
    });
    const row = await h.store.get<MissionState>('state', h.mission.id);
    assert.ok(row);
    const state: MissionState = {
      ...row.value,
      plan,
      planRevision: 1,
      tree: snapshot.tree,
      work: Object.fromEntries(plan.items.map((item) => [item.id, 'pending'])),
    };
    assert.equal(state.startedAt, null);
    assert.equal(state.roleJournalVersion, undefined);
    await h.store.commit(
      [
        {
          kind: 'state',
          id: row.id,
          expectedVersion: row.version,
          value: state,
        },
        {
          kind: 'plan',
          id: `${h.mission.id}-r1-1`,
          expectedVersion: 0,
          value: plan,
        },
      ],
      { id: randomUUID(), topic: 'test.legacy-ready', payload: {} },
    );
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(planner.calls.get(planner.itemId), 1);
  } finally {
    await h.close();
  }
});

for (const status of [401, 403, 429]) {
  test(`P1-B: actual SDK HTTP ${status} classification permits one corrected explicit retry`, async () => {
    const planner = new RolePlanner();
    planner.error = OpenAI.APIError.generate(
      status,
      { message: 'Provider rejected request' },
      'Provider rejected request',
      new Headers(),
    );
    const h = await roleHarness(planner);
    try {
      await h.runtime.run(h.mission.id, 'fake');
      await h.restart();
      await h.runtime.run(h.mission.id, 'fake');
      assert.equal(planner.calls.get(planner.itemId), 1);
      assert.equal(
        (await h.runtime.resume(h.mission.id, 'fake')).status,
        'completed',
      );
      assert.equal(planner.calls.get(planner.itemId), 2);
    } finally {
      await h.close();
    }
  });
}

test('P1-B: successful response with unknown usage retains the reservation charge across reuse', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const report = planner.report.bind(planner);
  planner.report = async (...args) => {
    const result = await report(...args);
    const input = args[1];
    if (input && typeof input === 'object' && 'item' in input)
      result.usage = {
        certainty: 'unknown',
        inputTokens: null,
        outputTokens: null,
        usd: null,
      };
    return result;
  };
  const h = await roleHarness(planner);
  try {
    assert.equal(
      (await h.runtime.run(h.mission.id, 'fake')).status,
      'completed',
    );
    await h.restart();
    await h.runtime.resume(h.mission.id, 'fake');
    assert.deepEqual(await h.store.balance(h.mission.id), {
      reserved: 0,
      spent: 0.1,
      unknown: 1,
    });
    assert.equal(planner.calls.get(planner.itemId), 1);
  } finally {
    await h.close();
  }
});

test('P1-B: cancellation while provider is active never permits another call', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const entered = deferred();
  const release = deferred();
  const report = planner.report.bind(planner);
  planner.report = async (...args) => {
    const response = await report(...args);
    const input = args[1];
    if (input && typeof input === 'object' && 'item' in input) {
      entered.resolve();
      await release.promise;
      throw new FactoryError(
        'cancelled',
        'Provider cancellation outcome unknown',
      );
    }
    return response;
  };
  const h = await roleHarness(planner);
  try {
    const running = h.runtime.run(h.mission.id, 'fake');
    await entered.promise;
    await h.runtime.cancel(h.mission.id);
    release.resolve();
    assert.equal((await running).status, 'cancelled');
    await h.restart();
    await h.runtime.resume(h.mission.id, 'fake');
    assert.equal(planner.calls.get(planner.itemId), 1);
    assert.equal((await h.executions())[0]?.state, 'uncertain');
  } finally {
    release.resolve();
    await h.close();
  }
});

test('P1-B: a saved final response is reused even if an independent accepted snapshot changed', async () => {
  const planner = new RolePlanner();
  planner.failures = 0;
  const h = await roleHarness(planner);
  try {
    const commit = h.store.commit.bind(h.store);
    let fail = true;
    h.store.commit = async (...args) => {
      if (args[1].topic === 'role.completed' && fail) {
        fail = false;
        throw new FactoryError('store', 'Completion could not be saved');
      }
      return commit(...args);
    };
    await h.runtime.run(h.mission.id, 'fake');
    const row = await h.store.get<MissionState>('state', h.mission.id);
    assert.ok(row?.value.tree);
    const file = row.value.tree['range.ts'];
    assert.ok(file);
    // Simulate a durable independent Builder's merge after the saved role response.
    file.content = Buffer.from(
      Buffer.from(file.content, 'base64').toString('utf8') + '\n',
    ).toString('base64');
    await h.store.commit(
      [
        {
          kind: 'state',
          id: row.id,
          expectedVersion: row.version,
          value: row.value,
        },
      ],
      { id: randomUUID(), topic: 'test.independent-snapshot', payload: {} },
    );
    await h.restart();
    assert.equal(
      (await h.runtime.resume(h.mission.id, 'fake')).status,
      'completed',
    );
    assert.equal(planner.calls.get(planner.itemId), 1);
  } finally {
    await h.close();
  }
});

test('P1-B: independent Builder completion cannot erase a permanent role hold reason', async () => {
  const planner = new RolePlanner();
  planner.independent = true;
  const plan = planner.plan.bind(planner);
  planner.plan = async (...args) => {
    const response = await plan(...args);
    response.value.items.reverse(); // Put the permanent hold last in the batch.
    return response;
  };
  const report = planner.report.bind(planner);
  planner.report = async (...args) => {
    const input = args[1];
    if (
      input &&
      typeof input === 'object' &&
      'item' in input &&
      input.item &&
      typeof input.item === 'object' &&
      'id' in input.item &&
      input.item.id === 'review-beta'
    )
      throw new FactoryError('refused', 'Permanent provider refusal');
    return report(...args);
  };
  const h = await roleHarness(planner);
  try {
    await h.runtime.run(h.mission.id, 'fake');
    await h.runtime.resume(h.mission.id, 'fake');
    const state = await h.runtime.state(h.mission.id);
    assert.equal(state.work[planner.itemId], 'completed');
    assert.equal(state.status, 'waiting');
    assert.match(state.waiting?.reason ?? '', /review-beta: refused/);
    assert.match(state.waiting?.resumeCondition ?? '', /new mission revision/);
  } finally {
    await h.close();
  }
});
