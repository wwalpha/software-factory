import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, parseYaml } from '../src/adapters/contracts.js';
import {
  safePath,
  validatePlan,
  validateHandoff,
  mayTakeOver,
  validateRecipeChange,
  evaluateDecision,
} from '../src/domain/invariants.js';
import { FakePlanner } from '../src/adapters/fake.js';
import { harness } from './helpers.js';
import type {
  Attempt,
  Evaluation,
  Experiment,
} from '../src/domain/contracts.js';
test('strict contracts and bounded YAML reject unknown fields, coercion, aliases, tags, duplicates and deep input', () => {
  assert.throws(() =>
    contract('MissionDraft', {
      objective: 'a',
      nonGoals: [],
      ambiguities: [],
      approved: true,
    }),
  );
  assert.throws(() =>
    contract('MissionDraft', { objective: 42, nonGoals: [], ambiguities: [] }),
  );
  for (const input of [
    'a: 1\na: 2',
    'a: &a {b: 1}\nc: *a',
    'a: !unknown x',
    'a: '.repeat(40) + '1',
    'x'.repeat(300000),
  ])
    assert.throws(() => parseYaml(input));
  assert.deepEqual(parseYaml('a: 1'), { a: 1 });
  for (const p of [
    '../outside',
    '/etc/passwd',
    '.git/config',
    '.env',
    'x/.aws/config',
    'x\\y',
    'x//y',
    'key.pem',
    '__proto__',
    'x/constructor',
  ])
    assert.equal(safePath(p), false, p);
});
test('plans reject cycles, missing dependencies, scope, budgets, stale parents and abandoned acceptance', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const m = await h.runtime.submit('repair', p),
      plan = (await new FakePlanner().plan(m, 0, {}, AbortSignal.timeout(1000)))
        .value;
    validatePlan(plan, m, 0);
    for (const change of [
      (v: typeof plan) => {
        v.parentRevision = 9;
      },
      (v: typeof plan) => {
        v.items[0]!.dependsOn = ['missing'];
      },
      (v: typeof plan) => {
        v.items[0]!.dependsOn = [v.items[0]!.id];
      },
      (v: typeof plan) => {
        v.items[0]!.scope = ['outside'];
      },
      (v: typeof plan) => {
        v.estimatedUsd = 100;
      },
      (v: typeof plan) => {
        v.items[0]!.acceptanceIds = [];
      },
    ]) {
      const invalid = structuredClone(plan);
      change(invalid);
      assert.throws(() => validatePlan(invalid, m, 0));
    }
  } finally {
    await h.close();
  }
});
test('expired lease alone never authorizes takeover; stale epochs/base are fenced', () => {
  const a: Attempt = {
    id: 'a',
    missionId: 'm',
    workItemId: 'w',
    epoch: 2,
    leaseUntil: '2000-01-01T00:00:00Z',
    baseDigest: 'a'.repeat(64),
    operationId: 'o',
    state: 'running',
    waiting: null,
    usage: {
      certainty: 'unknown',
      inputTokens: null,
      outputTokens: null,
      usd: null,
    },
    stopped: false,
  };
  assert.throws(() => mayTakeOver(a, false));
  mayTakeOver(a, true);
  const handoff = {
    attemptId: 'a',
    epoch: 1,
    baseDigest: a.baseDigest,
    candidateDigest: 'b'.repeat(64),
    claim: { summary: 'PASS', acceptanceClaims: [], concerns: [] },
  };
  assert.throws(() => validateHandoff(handoff, { ...a, stopped: true }));
  assert.throws(() => validateHandoff({ ...handoff, epoch: 2 }, a));
  validateHandoff({ ...handoff, epoch: 2 }, { ...a, stopped: true });
});
test('recipe capabilities cannot expand and evaluation supports reject and hold', async () => {
  const h = await harness();
  try {
    const base = await h.guard.release('baseline'),
      candidate = { ...base, id: 'c', parent: base.id };
    candidate.recipe = {
      ...base.recipe,
      capabilities: ['read', 'edit-candidate', 'propose'],
    };
    assert.throws(() => validateRecipeChange(base, candidate));
    const experiment: Experiment = {
      id: 'e',
      lineage: 'l',
      hypothesis: 'h',
      cause: 'unknown',
      evidence: ['observed'],
      projectIds: ['repair'],
      taskTypes: ['bugfix'],
      baselineRelease: 'baseline',
      suiteId: 's',
      suiteDigest: 'a'.repeat(64),
      minQuality: 1,
      maxRescue: 0,
      maxUsd: 10,
      maxDurationMs: 10000,
      maxTrials: 2,
      rollbackQuality: 1,
      rollbackRescue: 0,
      minRetryReduction: 1,
      status: 'fixed',
      createdAt: new Date().toISOString(),
    };
    const evaluation: Evaluation = {
      experimentId: 'e',
      releaseId: 'baseline',
      suiteDigest: experiment.suiteDigest,
      quality: 1,
      rescueCount: 0,
      retryCount: 0,
      usd: 1,
      durationMs: 100,
      cases: [{ id: 'separate', partition: 'separate', passed: true }],
      evidenceIds: [],
    };
    assert.equal(
      evaluateDecision(experiment, evaluation, { ...evaluation, usd: null }),
      'held',
    );
    assert.equal(
      evaluateDecision(experiment, evaluation, { ...evaluation, quality: 0 }),
      'rejected',
    );
    assert.equal(evaluateDecision(experiment, evaluation, evaluation), 'held');
  } finally {
    await h.close();
  }
});

test('execution lanes keep concurrency bounded under queued cancellation', async () => {
  const { Lane } = await import('../src/application/lanes.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const lane = new Lane(2);
  let active = 0,
    max = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      lane.run(
        i === 3 ? AbortSignal.abort() : AbortSignal.timeout(1000),
        async () => {
          active++;
          max = Math.max(max, active);
          await delay(2);
          active--;
          return i;
        },
      ),
    ),
  );
  assert.equal(max, 2);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});
