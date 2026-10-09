import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, edits } from './helpers.js';
import { FakeRunner } from '../src/adapters/fake.js';
import type { Experiment, ResultBundle } from '../src/domain/contracts.js';
import { treeDigest } from '../src/adapters/artifacts.js';
async function fixed(
  h: Awaited<ReturnType<typeof harness>>,
): Promise<Experiment> {
  const d = await h.evolution.descriptor('baseline');
  return {
    id: randomUUID(),
    ...d,
    hypothesis: 'boundary examples reduce retries',
    cause: 'unknown',
    evidence: ['recorded protected failure'],
    projectIds: ['repair'],
    taskTypes: ['bugfix'],
    baselineRelease: 'baseline',
    minQuality: 1,
    maxRescue: 0,
    maxUsd: 10,
    maxDurationMs: 100000,
    maxTrials: 1,
    rollbackQuality: 1,
    rollbackRescue: 0,
    minRetryReduction: 1,
    status: 'fixed',
    createdAt: new Date().toISOString(),
  };
}
test('evaluation suite tampering, arbitrary suite references and lineage budget resets fail closed', async () => {
  const h = await harness();
  try {
    const e = await fixed(h);
    await assert.rejects(h.evolution.fix({ ...e, suiteId: '../../attacker' }));
    await h.evolution.fix(e);
    await assert.rejects(
      h.evolution.fix({ ...e, id: randomUUID(), maxTrials: 3 }),
    );
    await h.evolution.propose(e.id, 'Read acceptance examples first');
    await writeFile(join(h.profiles[0]!.repository, 'range.ts'), 'changed');
    await assert.rejects(h.evolution.run(e.id));
  } finally {
    await h.close();
  }
});
test('equal candidate is held, a regressing candidate is rejected, and a new ID cannot bypass trial cap', async () => {
  const h = await harness();
  try {
    const e = await fixed(h);
    await h.evolution.fix(e);
    await h.evolution.propose(
      e.id,
      (await h.guard.release('baseline')).recipe.prompt,
    );
    const result = await h.evolution.run(e.id);
    assert.equal(result.decision, 'held');
    assert.deepEqual(await h.evolution.run(e.id), result);
    const second = { ...e, id: randomUUID() };
    await h.evolution.fix(second);
    await h.evolution.propose(second.id, 'Read acceptance examples');
    await assert.rejects(h.evolution.run(second.id), /trial cap/);
  } finally {
    await h.close();
  }
  const realFake = new FakeRunner(edits, true);
  const h2 = await harness({
    stop: (id) => realFake.stop(id),
    isStopped: (id) => realFake.isStopped(id),
    run: async (...args) => {
      const out = await realFake.run(...args);
      if (args[3].prompt === 'Regression injection')
        for (const file of Object.values(out.tree))
          file.content = Buffer.from('export const broken = true;').toString(
            'base64',
          );
      return out;
    },
  });
  try {
    const e = await fixed(h2);
    await h2.evolution.fix(e);
    await h2.evolution.propose(e.id, 'Regression injection');
    assert.equal((await h2.evolution.run(e.id)).decision, 'rejected');
  } finally {
    await h2.close();
  }
});
test('canary affects only new delegated missions; independent protected failure triggers rollback', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const inFlight = await h.runtime.submit('repair', p);
    const e = await fixed(h);
    await h.evolution.fix(e);
    const release = await h.evolution.propose(
      e.id,
      'Read acceptance examples before editing.',
    );
    assert.equal((await h.evolution.run(e.id)).decision, 'adopted');
    assert.equal(
      (await h.runtime.mission(inFlight.id)).factoryRelease,
      'baseline',
    );
    assert.equal(
      (await h.guard.releaseFor('refactor', 'refactor')).id,
      'baseline',
    );
    const later = await h.runtime.submit('repair', p);
    assert.equal(later.factoryRelease, release.id);
    await h.grant(later);
    const request = {
      id: randomUUID(),
      grantId: `grant-${later.id}`,
      mission: later,
      type: 'snapshot' as const,
      targetDigest: 'a'.repeat(64),
      amount: 0.01,
      payload: {},
    };
    const snap = (await h.guard.operate(request)) as {
      tree: import('../src/domain/tree.js').Tree;
    };
    const checked = (await h.guard.operate({
      ...request,
      id: randomUUID(),
      type: 'check',
      targetDigest: treeDigest(snap.tree),
      payload: { tree: snap.tree },
    })) as { receipts: ResultBundle['checks'] };
    const bundle: ResultBundle = {
      missionId: later.id,
      missionRevision: 1,
      status: 'failed',
      achieved: [],
      artifact: { digest: treeDigest(snap.tree), reference: 'candidate' },
      checks: checked.receipts,
      unmet: ['repair-works'],
      notRun: [],
      decisions: [],
      usage: { certainty: 'measured', inputTokens: 0, outputTokens: 0, usd: 0 },
      factoryRelease: release.id,
      completionSignature: null,
    };
    await h.evolution.followup(bundle);
    assert.equal((await h.guard.release(release.id)).stage, 'revoked');
    assert.equal((await h.guard.releaseFor('repair', 'bugfix')).id, 'baseline');
    await assert.rejects(
      h.guard.operate({ ...request, id: randomUUID() }),
      /revoked/,
    );
    await h.evolution.rollback(release.id);
  } finally {
    await h.close();
  }
});

test('rollback records stop/reconciliation of inflight operations', async () => {
  const h = await harness();
  try {
    const e = await fixed(h);
    await h.evolution.fix(e);
    const release = await h.evolution.propose(e.id, 'Read acceptance examples');
    await h.evolution.run(e.id);
    const p = h.profiles[0];
    assert.ok(p);
    const m = await h.runtime.submit('repair', p);
    await h.grant(m);
    const id = randomUUID();
    await h.guardStore.commit(
      [
        {
          kind: 'operation',
          id,
          expectedVersion: 0,
          value: {
            request: {
              id,
              grantId: `grant-${m.id}`,
              mission: m,
              type: 'build',
              targetDigest: 'a'.repeat(64),
              amount: 0.2,
              payload: {},
            },
            digest: 'a'.repeat(64),
            state: 'uncertain',
            result: null,
          },
        },
      ],
      { id, topic: 'fault-injection', payload: { id } },
    );
    const result = (await h.evolution.rollback(release.id)) as {
      reconciled: { id: string; stopped: boolean }[];
    };
    assert.equal(result.reconciled[0]?.id, id);
    assert.equal(result.reconciled[0]?.stopped, true);
    assert.equal((await h.guard.release(release.id)).stage, 'revoked');
  } finally {
    await h.close();
  }
});
