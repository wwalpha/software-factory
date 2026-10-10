import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './helpers.js';
import {
  digest,
  treeDigest,
  readTree,
  mergeTrees,
} from '../src/adapters/artifacts.js';
import type { Tree } from '../src/adapters/artifacts.js';
import type { OperationRequest } from '../src/ports/guard.js';
import type { EvidenceReceipt } from '../src/domain/contracts.js';
import { checkVersion } from '../src/adapters/checks.js';
test('grant expiry, operation conflict, protected scope and forged/stale evidence are denied', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const m = await h.runtime.submit('repair', p);
    const grant = await h.grant(m);
    const request: OperationRequest = {
      id: randomUUID(),
      grantId: grant.id,
      mission: m,
      type: 'snapshot',
      targetDigest: digest('snapshot'),
      amount: 0.01,
      payload: {},
    };
    const snapshot = (await h.guard.operate(request)) as { tree: Tree };
    assert.deepEqual(await h.guard.operate(request), snapshot);
    await assert.rejects(
      h.guard.operate({ ...request, payload: { different: true } }),
    );
    const tree = structuredClone(snapshot.tree);
    tree['outside.ts'] = {
      content: Buffer.from('secret').toString('base64'),
      executable: false,
    };
    await assert.rejects(
      h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'check',
        targetDigest: treeDigest(tree),
        payload: { tree },
      }),
    );
    const fixed = structuredClone(snapshot.tree);
    fixed['range.ts'] = {
      content: Buffer.from(
        'export function clamp(v:number,a:number,b:number){ return Math.max(a,Math.min(b,v)); }',
      ).toString('base64'),
      executable: false,
    };
    const checked = (await h.guard.operate({
      ...request,
      id: randomUUID(),
      type: 'check',
      targetDigest: treeDigest(fixed),
      payload: { tree: fixed },
    })) as { receipts: EvidenceReceipt[] };
    assert.equal(checked.receipts[0]?.result, 'pass');
    const bundle = {
      missionId: m.id,
      missionRevision: 1,
      status: 'completed',
      achieved: m.acceptance.map((a) => a.id),
      artifact: { digest: treeDigest(fixed), reference: 'candidate' },
      checks: checked.receipts,
      unmet: [],
      notRun: [],
      decisions: [],
      usage: { certainty: 'measured', inputTokens: 0, outputTokens: 0, usd: 0 },
      factoryRelease: 'baseline',
      completionSignature: null,
    };
    await assert.rejects(
      h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'seal',
        targetDigest: treeDigest(fixed),
        payload: {
          tree: fixed,
          bundle: {
            ...bundle,
            checks: [{ ...checked.receipts[0], signature: 'forged' }],
          },
        },
      }),
    );
    const changed = {
      ...fixed,
      'range.ts': {
        ...fixed['range.ts']!,
        content: Buffer.from('export const broken=true').toString('base64'),
      },
    };
    await assert.rejects(
      h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'seal',
        targetDigest: treeDigest(changed),
        payload: {
          tree: changed,
          bundle: {
            ...bundle,
            artifact: { digest: treeDigest(changed), reference: 'candidate' },
          },
        },
      }),
    );
    const row = await h.guardStore.get('grant', grant.id);
    assert.ok(row);
    await h.guardStore.commit(
      [
        {
          kind: 'grant',
          id: grant.id,
          expectedVersion: row.version,
          value: { ...grant, expiresAt: '2000-01-01T00:00:00Z' },
        },
      ],
      { id: 'expire', topic: 'test', payload: {} },
    );
    await assert.rejects(h.guard.operate({ ...request, id: randomUUID() }));
  } finally {
    await h.close();
  }
});
test('path links, .git, secrets and special tree changes are rejected', async () => {
  const h = await harness();
  try {
    const dir = join(h.root, 'hostile');
    await mkdir(dir);
    await symlink('/etc/passwd', join(dir, 'out'));
    await assert.rejects(readTree(dir));
    const p = h.profiles[0];
    assert.ok(p);
    await assert.rejects(
      h.runtime.submit('sk-private-canary-secret', p),
      /Secret/,
    );
    assert.equal((await h.runtimeStore.list('mission')).length, 0);
  } finally {
    await h.close();
  }
});
test('exit zero and agent PASS without protected assertions cannot establish acceptance', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    await writeFile(
      join(p.checkRoot, 'empty.mjs'),
      'console.log("PASS"); process.exit(0);',
    );
    const spec = {
      id: 'empty',
      kind: 'node-test' as const,
      files: ['empty.mjs'],
    };
    const checks = [
      { ...spec, version: await checkVersion(p.checkRoot, spec) },
    ];
    const result = await h.checks.run(
      {},
      { ...p, checks },
      AbortSignal.timeout(5000),
    );
    assert.equal(result[0]?.passed, false);
  } finally {
    await h.close();
  }
});
test('merge conflicts and bugs visible only in the integrated tree fail final checks', async () => {
  const h = await harness();
  try {
    const base: Tree = {
      'a.ts': {
        content: Buffer.from('export function readA(){return 0;}').toString(
          'base64',
        ),
        executable: false,
      },
      'b.ts': {
        content: Buffer.from('export function readB(){return 0;}').toString(
          'base64',
        ),
        executable: false,
      },
    };
    const a = {
        ...base,
        'a.ts': {
          ...base['a.ts']!,
          content: Buffer.from('export function readA(){return 1;}').toString(
            'base64',
          ),
        },
      },
      b = {
        ...base,
        'b.ts': {
          ...base['b.ts']!,
          content: Buffer.from('export function readB(){return 1;}').toString(
            'base64',
          ),
        },
      };
    await writeFile(
      join(h.root, 'checks/cross.mjs'),
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('cross invariant',async()=>assert.ok((await callProduct('a.ts','readA',[]))+(await callProduct('b.ts','readB',[]))<=1));`,
    );
    const spec = {
        id: 'cross',
        kind: 'node-test' as const,
        files: ['cross.mjs'],
      },
      p = h.profiles[0];
    assert.ok(p);
    const profile = {
      ...p,
      checks: [{ ...spec, version: await checkVersion(p.checkRoot, spec) }],
    };
    assert.equal(
      (await h.checks.run(a, profile, AbortSignal.timeout(5000)))[0]?.passed,
      true,
    );
    assert.equal(
      (await h.checks.run(b, profile, AbortSignal.timeout(5000)))[0]?.passed,
      true,
    );
    assert.equal(
      (
        await h.checks.run(
          mergeTrees(base, a, b),
          profile,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
    assert.throws(() =>
      mergeTrees(base, a, {
        ...base,
        'a.ts': {
          ...base['a.ts']!,
          content: Buffer.from('conflict').toString('base64'),
        },
      }),
    );
  } finally {
    await h.close();
  }
});

test('binary artifacts preserve bytes and secret values cannot hide inside base64 trees', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0];
    assert.ok(p);
    const { runProcess } = await import('../src/adapters/process.js');
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(join(p.repository, 'binary.dat'), bytes);
    await runProcess('git', ['add', 'binary.dat'], { cwd: p.repository });
    await runProcess(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'binary fixture',
      ],
      { cwd: p.repository },
    );
    const { trackedSnapshot } = await import('../src/adapters/artifacts.js');
    const snapshot = await trackedSnapshot(p.repository);
    assert.deepEqual(
      Buffer.from(snapshot.tree['binary.dat']!.content, 'base64'),
      bytes,
    );
    const m = await h.runtime.submit('repair', p);
    await h.grant(m);
    const request = {
      id: randomUUID(),
      grantId: `grant-${m.id}`,
      mission: m,
      type: 'snapshot' as const,
      targetDigest: digest('snapshot'),
      amount: 0.01,
      payload: {},
    };
    await h.guard.operate(request);
    const tree = {
      ...snapshot.tree,
      'range.ts': {
        content: Buffer.from('sk-private-canary-secret').toString('base64'),
        executable: false,
      },
    };
    await assert.rejects(
      h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'check',
        targetDigest: treeDigest(tree),
        payload: { tree },
      }),
      /Secret/,
    );
  } finally {
    await h.close();
  }
});

test('Trust boundary B/H: shared-assert attack gets no PASS receipt/seal; old method, input, environment and missing mandatory evidence cannot seal', async () => {
  const h = await harness();
  try {
    const p = h.profiles[0]!;
    await writeFile(
      join(p.checkRoot, 'mandatory.mjs'),
      `import test from 'node:test';import assert from 'node:assert/strict';test('mandatory',()=>assert.equal(1,1));`,
    );
    const mandatory = {
      id: 'extra-mandatory',
      kind: 'node-test' as const,
      files: ['mandatory.mjs'],
    };
    p.checks.push({
      ...mandatory,
      version: await checkVersion(p.checkRoot, mandatory),
    });
    const m = await h.runtime.submit('repair', p);
    const grant = await h.grant(m);
    const request: OperationRequest = {
      id: randomUUID(),
      grantId: grant.id,
      mission: m,
      type: 'snapshot',
      targetDigest: digest('snapshot'),
      amount: 0.01,
      payload: {},
    };
    const snapshot = (await h.guard.operate(request)) as { tree: Tree };
    const { repairProducts } = await import('./fixtures/check-products.js');
    const candidate = (source: string): Tree => ({
      ...snapshot.tree,
      'range.ts': {
        content: Buffer.from(source).toString('base64'),
        executable: false,
      },
    });
    const check = async (tree: Tree) =>
      (await h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'check',
        targetDigest: treeDigest(tree),
        payload: { tree },
      })) as { receipts: EvidenceReceipt[] };
    const bundle = (tree: Tree, receipts: EvidenceReceipt[]) => ({
      missionId: m.id,
      missionRevision: m.revision,
      status: 'completed',
      achieved: m.acceptance.map((a) => a.id),
      artifact: { digest: treeDigest(tree), reference: 'candidate' },
      checks: receipts,
      unmet: [],
      notRun: [],
      decisions: [],
      usage: { certainty: 'measured', inputTokens: 0, outputTokens: 0, usd: 0 },
      factoryRelease: m.factoryRelease,
      completionSignature: null,
    });
    const seal = (tree: Tree, receipts: EvidenceReceipt[]) =>
      h.guard.operate({
        ...request,
        id: randomUUID(),
        type: 'seal',
        targetDigest: treeDigest(tree),
        payload: { tree, bundle: bundle(tree, receipts) },
      });
    const hostile = candidate(repairProducts.assertMutation);
    const denied = await check(hostile);
    assert.equal(
      denied.receipts.find((r) => r.checkId === p.checks[0]!.id)?.result,
      'fail',
    );
    assert.equal(
      denied.receipts.some(
        (r) => r.checkId === p.checks[0]!.id && r.result === 'pass',
      ),
      false,
    );
    await assert.rejects(
      seal(hostile, denied.receipts),
      /Missing required evidence/,
    );
    assert.equal(
      (
        await h.guardStore.list<{ request: OperationRequest; state: string }>(
          'operation',
        )
      ).some(
        (r) => r.value.request.type === 'seal' && r.value.state === 'completed',
      ),
      false,
    );
    const fixed = candidate(repairProducts.correct);
    const passed = await check(fixed);
    assert.ok(passed.receipts.every((r) => r.result === 'pass'));
    await assert.rejects(
      seal(
        fixed,
        passed.receipts.filter((r) => r.checkId !== mandatory.id),
      ),
      /Missing required evidence/,
    );
    const original = passed.receipts.find(
      (r) => r.checkId === p.checks[0]!.id,
    )!;
    const historical = async (patch: Partial<EvidenceReceipt>) => {
      const { signature: _signature, ...unsigned } = {
        ...original,
        ...patch,
        id: randomUUID(),
      };
      void _signature;
      const receipt = { ...unsigned, signature: h.guard.signature(unsigned) };
      assert.equal(h.guard.verify(unsigned, receipt.signature), true);
      await h.guardStore.commit(
        [
          {
            kind: 'evidence',
            id: receipt.id,
            expectedVersion: 0,
            value: receipt,
          },
        ],
        { id: randomUUID(), topic: 'historical-fixture', payload: {} },
      );
      return passed.receipts.map((r) => {
        if (r.checkId === receipt.checkId) return receipt;
        return r;
      });
    };
    const { readFile } = await import('node:fs/promises');
    const spec = p.checks[0]!;
    const bytes = await readFile(join(p.checkRoot, spec.files[0]!));
    const legacyVersion = digest({
      kind: spec.kind,
      files: { [spec.files[0]!]: bytes.toString('base64') },
    });
    await assert.rejects(
      seal(fixed, await historical({ checkVersion: legacyVersion })),
      /Check version changed/,
    );
    await assert.rejects(
      seal(fixed, await historical({ inputDigest: digest('old input') })),
      /Stale or forged evidence/,
    );
    await assert.rejects(
      seal(fixed, await historical({ environment: 'docker-isolated' })),
      /Stale or forged evidence/,
    );
    const sealed = (await seal(fixed, passed.receipts)) as {
      bundle: import('../src/domain/contracts.js').ResultBundle;
    };
    const { verifyBundle } = await import('../src/adapters/verification.js');
    verifyBundle(sealed.bundle, fixed, h.guard.publicKey);
    const changed = candidate(repairProducts.wrong);
    await assert.rejects(
      seal(changed, passed.receipts),
      /Stale or forged evidence/,
    );
    await writeFile(
      join(p.checkRoot, spec.files[0]!),
      Buffer.concat([bytes, Buffer.from('\n')]),
    );
    await assert.rejects(seal(fixed, passed.receipts), /Check version changed/);
    // Historical signature verification remains valid after migration; new seal admission is separate.
    verifyBundle(sealed.bundle, fixed, h.guard.publicKey);
    const broken = candidate(
      repairProducts.outputForgery +
        '\nprocess.stdout.write("x".repeat(70000));',
    );
    const invalidOperation = {
      ...request,
      id: randomUUID(),
      type: 'check' as const,
      targetDigest: treeDigest(broken),
      payload: { tree: broken },
    };
    // Restore operator-owned test bytes, without changing the registered expected version.
    await writeFile(join(p.checkRoot, spec.files[0]!), bytes);
    const evidenceCount = (await h.guardStore.list('evidence')).length;
    await assert.rejects(h.guard.operate(invalidOperation), /output exceeded/);
    assert.equal(
      (
        await h.guardStore.get<{ state: string }>(
          'operation',
          invalidOperation.id,
        )
      )?.value.state,
      'uncertain',
    );
    assert.equal((await h.guardStore.list('evidence')).length, evidenceCount);
    const realRun = h.checks.run.bind(h.checks);
    // Cancel after real evaluator/worker completion, before Guard can issue evidence.
    h.checks.run = async (...args) => {
      const results = await realRun(...args);
      await h.guard.call('cancelMission', m.id);
      return results;
    };
    const cancelledOperation = {
      ...invalidOperation,
      id: randomUUID(),
      targetDigest: treeDigest(fixed),
      payload: { tree: fixed },
    };
    await assert.rejects(
      h.guard.operate(cancelledOperation),
      /cancelled before evidence/,
    );
    assert.equal((await h.guardStore.list('evidence')).length, evidenceCount);
    assert.equal(
      (
        await h.guardStore.get<{ state: string }>(
          'operation',
          cancelledOperation.id,
        )
      )?.value.state,
      'uncertain',
    );
  } finally {
    await h.close();
  }
});
