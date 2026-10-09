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
        content: Buffer.from('export const a=0').toString('base64'),
        executable: false,
      },
      'b.ts': {
        content: Buffer.from('export const b=0').toString('base64'),
        executable: false,
      },
    };
    const a = {
        ...base,
        'a.ts': {
          ...base['a.ts']!,
          content: Buffer.from('export const a=1').toString('base64'),
        },
      },
      b = {
        ...base,
        'b.ts': {
          ...base['b.ts']!,
          content: Buffer.from('export const b=1').toString('base64'),
        },
      };
    await writeFile(
      join(h.root, 'checks/cross.mjs'),
      `import test from 'node:test';import assert from 'node:assert/strict';import{pathToFileURL}from'node:url';const root=process.env.PRODUCT_ROOT;const {a}=await import(pathToFileURL(root+'/a.ts'));const {b}=await import(pathToFileURL(root+'/b.ts'));test('cross invariant',()=>assert.ok(a+b<=1));`,
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
