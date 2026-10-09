import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { ensure } from '../src/domain/invariants.js';
test('dynamic repair, protected final verification, signed delivery and recipe evolution', async () => {
  const h = await harness();
  try {
    const profile = h.profiles[0];
    ensure(profile, 'test', 'profile');
    const mission = await h.runtime.submit('Fix clamp bounds', profile);
    await h.grant(mission);
    const result = await h.runtime.run(mission.id, 'fake');
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.ok(result.completionSignature);
    assert.equal(result.checks[0]?.result, 'pass');
    assert.ok((await h.runtime.state(mission.id)).planRevision >= 2);
    assert.deepEqual(await h.runtime.result(mission.id), result);
    const experiment = await h.runtime.createExperiment(mission.id);
    const evaluated = (await h.runtime.runExperiment(
      experiment.id,
      'fake',
    )) as { decision: string };
    assert.equal(evaluated.decision, 'adopted');
    const later = await h.runtime.submit('Fix clamp bounds', profile);
    assert.notEqual(later.factoryRelease, mission.factoryRelease);
    assert.equal(
      (await h.runtime.mission(mission.id)).factoryRelease,
      'baseline',
    );
    await h.evolution.rollback(later.factoryRelease);
    assert.equal(
      (await h.guard.releaseFor(profile.id, profile.taskType)).id,
      'baseline',
    );
  } finally {
    await h.close();
  }
});

test('one waiting task does not stop independent work and a mission revision preserves immutable contracts', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const { writeFile } = await import('node:fs/promises'),
      { join } = await import('node:path');
    const { runProcess } = await import('../src/adapters/process.js');
    await writeFile(join(p.repository, 'extra.ts'), 'export const extra=1;');
    await runProcess('git', ['add', 'extra.ts'], { cwd: p.repository });
    await runProcess(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'additional independent module',
      ],
      { cwd: p.repository },
    );
    p.scope.push('extra.ts');
    const { Runtime } = await import('../src/application/runtime.js'),
      { FakePlanner } = await import('../src/adapters/fake.js'),
      { FactoryError } = await import('../src/domain/invariants.js');
    const runtime = new Runtime(
      h.runtimeStore,
      new FakePlanner(),
      {
        ...h.port,
        operate: async <T>(
          request: import('../src/ports/guard.js').OperationRequest,
        ): Promise<T> => {
          if (
            request.type === 'build' &&
            JSON.stringify(request.payload).includes('work-1-0')
          )
            throw new FactoryError('grant', 'Task-specific grant missing');
          return h.port.operate<T>(request);
        },
      },
      'fake',
    );
    const m = await runtime.submit('two independent modules', p);
    await h.grant(m);
    const result = await runtime.run(m.id, 'fake');
    assert.equal(result.status, 'waiting');
    const state = await runtime.state(m.id);
    assert.equal(state.work['work-1-1'], 'completed');
    assert.equal(state.work['work-1-0'], 'waiting');
    await assert.rejects(runtime.revise(m.id, 'clarification'), /stopped/);
    const fresh = await runtime.submit('needs clarification', p);
    const revision = await runtime.revise(
      fresh.id,
      'Preserve existing behavior',
    );
    assert.equal(revision.revision, 2);
    assert.deepEqual(revision.acceptance, fresh.acceptance);
    assert.ok(await h.runtimeStore.get('mission-revision', `${fresh.id}-1`));
  } finally {
    await h.close();
  }
});

test('cancel revokes future mission operations and exported byte tampering invalidates proof', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const m = await h.runtime.submit('repair', p);
    await h.grant(m);
    await h.runtime.cancel(m.id);
    assert.equal((await h.runtime.run(m.id, 'fake')).status, 'cancelled');
    const { randomUUID } = await import('node:crypto'),
      { digest } = await import('../src/adapters/artifacts.js');
    await assert.rejects(
      h.guard.operate({
        id: randomUUID(),
        grantId: `grant-${m.id}`,
        mission: m,
        type: 'snapshot',
        targetDigest: digest('snapshot'),
        amount: 0.01,
        payload: {},
      }),
      /cancelled/,
    );
    const other = await h.runtime.submit('repair', p);
    await h.grant(other);
    const result = await h.runtime.run(other.id, 'fake');
    assert.equal(result.status, 'completed');
    const artifact = (await h.guard.call('artifact', other.id)) as {
      tree: import('../src/domain/tree.js').Tree;
    };
    const { verifyBundle } = await import('../src/adapters/verification.js');
    verifyBundle(result, artifact.tree, h.guard.publicKey);
    assert.throws(() =>
      verifyBundle(
        { ...result, completionSignature: 'forged' },
        artifact.tree,
        h.guard.publicKey,
      ),
    );
    const { join } = await import('node:path'),
      { chmod, writeFile } = await import('node:fs/promises');
    const path = join(
      h.config.guardRoot,
      'artifacts',
      result.artifact!.digest,
      'range.ts',
    );
    await chmod(path, 0o600);
    await writeFile(path, 'changed');
    await assert.rejects(h.guard.call('artifact', other.id), /changed/);
  } finally {
    await h.close();
  }
});
