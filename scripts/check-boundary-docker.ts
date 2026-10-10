import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fixture, edits } from '../tests/helpers.js';
import { service } from '../tests/services.js';
import { repairProducts } from '../tests/fixtures/check-products.js';
import { ProtectedChecks, checkVersion } from '../src/adapters/checks.js';
import { runProcess } from '../src/adapters/process.js';
import { ensure } from '../src/domain/invariants.js';
import type { Tree } from '../src/domain/tree.js';
import type { ProjectProfile } from '../src/domain/contracts.js';

const image = process.env.PRODUCT_CHECK_IMAGE;
ensure(
  image && /^sha256:[a-f0-9]{64}$/.test(image),
  'BLOCKED',
  'Set PRODUCT_CHECK_IMAGE to an actual pinned worker image ID; no fake fallback',
);
const available = await runProcess('docker', ['image', 'inspect', image]);
ensure(
  available.code === 0,
  'BLOCKED',
  'Actual Docker and pinned image required',
);
const checks = new ProtectedChecks(image);
const tree = (source: string, module = 'range.ts'): Tree => {
  return {
    [module]: {
      content: Buffer.from(source).toString('base64'),
      executable: false,
    },
  };
};
const registered = async (base: ProjectProfile, source: string) => {
  await writeFile(join(base.checkRoot, 'docker.test.mjs'), source);
  const spec = {
    id: 'docker-probe',
    kind: 'node-test' as const,
    files: ['docker.test.mjs'],
  };
  return {
    ...base,
    checks: [{ ...spec, version: await checkVersion(base.checkRoot, spec) }],
  };
};
const noProducts = async () => {
  const remaining = await runProcess('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    'label=factory.product-check=product',
  ]);
  assert.equal(remaining.code, 0);
  assert.equal(
    remaining.stdout.trim(),
    '',
    'All product containers must be removed',
  );
};
const runningProduct = async () => {
  for (let n = 0; n < 100; n++) {
    const listing = await runProcess('docker', [
      'ps',
      '--quiet',
      '--filter',
      'label=factory.product-check=product',
    ]);
    assert.equal(listing.code, 0);
    const id = listing.stdout.trim();
    if (id)
      return JSON.parse(
        (await runProcess('docker', ['inspect', id])).stdout,
      )[0];
    await delay(25);
  }
  throw Error('Product container never became running');
};

test('Docker A/B/C/I: repair/refactor acceptance survives real container isolation and mutations cannot fake PASS', async () => {
  const f = await fixture();
  try {
    for (const [name, source] of Object.entries(repairProducts)) {
      if (name === 'earlyExit' || name === 'importError') continue;
      assert.equal(
        (
          await checks.run(
            tree(source),
            f.profiles[0]!,
            AbortSignal.timeout(60000),
          )
        )[0]?.passed,
        name === 'correct',
        name,
      );
      await noProducts();
    }
    const profile = f.profiles[1]!;
    let source = await readFile(join(profile.repository, 'names.ts'), 'utf8');
    assert.equal(
      (
        await checks.run(
          tree(source, 'names.ts'),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      false,
    );
    for (const edit of edits.filter((e) => e.path === 'names.ts'))
      source = source.replaceAll(edit.before, edit.after);
    assert.equal(
      (
        await checks.run(
          tree(source, 'names.ts'),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      true,
    );
    assert.equal(
      (
        await checks.run(
          tree(
            "import assert from 'node:assert/strict';assert.deepEqual=()=>{};" +
              source.replaceAll(
                'names.map(normalizeName)',
                'names.map(()=>"wrong")',
              ),
            'names.ts',
          ),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      false,
    );
    const independent = await registered(
      f.profiles[0]!,
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('generic API',async()=>{assert.equal(await callProduct('other.mjs','number',[11]),22);assert.equal(await callProduct('other.mjs','label',['東京']),'東京!');assert.deepEqual(await callProduct('other.mjs','items',[[1,2]]),[2,1]);assert.deepEqual(await callProduct('other.mjs','business',[]),{passed:true});});`,
    );
    assert.equal(
      (
        await checks.run(
          tree(
            "export async function number(n){return n*2;}export function label(s){return s+'!';}export function items(a){return a.toReversed();}export function business(){return {passed:true};}",
            'other.mjs',
          ),
          independent,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      true,
    );
    const nonLossy = await registered(
      f.profiles[0]!,
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('no silent array coercion',async()=>assert.deepEqual(await callProduct('range.ts','clamp',[]),[null]));`,
    );
    for (const value of [
      'Object.defineProperty([],"0",{value:undefined})',
      'Object.defineProperty([],"0",{get(){return null;}})',
    ])
      assert.equal(
        (
          await checks.run(
            tree(`export function clamp(){return ${value};}`),
            nonLossy,
            AbortSignal.timeout(60000),
          )
        )[0]?.passed,
        false,
      );
    await noProducts();
  } finally {
    await f.cleanup();
  }
});

test('Docker D/E: exit, import errors, forged/duplicate/missing responses and floods never pass', async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    await assert.rejects(
      checks.run(
        tree(repairProducts.earlyExit),
        profile,
        AbortSignal.timeout(60000),
      ),
    );
    assert.equal(
      (
        await checks.run(
          tree(repairProducts.importError),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      false,
    );
    for (const mutation of [
      'return encode({passed:true})',
      'return ""',
      'return encode(v)+encode(v)',
      'return encode({...v,id:"00000000-0000-0000-0000-000000000000"})',
      'return encode({...v,extra:true})',
    ]) {
      await assert.rejects(
        checks.run(
          tree(
            `const encode=JSON.stringify;JSON.stringify=(v)=>{${mutation}};${repairProducts.wrong}`,
          ),
          profile,
          AbortSignal.timeout(60000),
        ),
      );
      await noProducts();
    }
    await assert.rejects(
      checks.run(
        tree(`process.stdout.write('x'.repeat(70000));${repairProducts.wrong}`),
        profile,
        AbortSignal.timeout(60000),
      ),
      /output exceeded/,
    );
    // A product may deliberately target its observation FD; that pipe still never carries a verdict.
    await assert.rejects(
      checks.run(
        tree(
          `import{writeSync}from'node:fs';writeSync(3,'{"passed":true}');process.exit(0);`,
        ),
        profile,
        AbortSignal.timeout(60000),
      ),
    );
    for (const source of [
      '',
      `import test from 'node:test';test.skip('skip',()=>{});test.todo('todo');`,
      'process.exit(0);',
    ]) {
      const p = await registered(profile, source);
      assert.equal(
        (await checks.run({}, p, AbortSignal.timeout(60000)))[0]?.passed,
        false,
      );
    }
    await noProducts();
  } finally {
    await f.cleanup();
  }
});

test('Docker F: timeout, cancellation and orphaned descendants end with confirmed container removal', async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    const pending = tree(
      'setInterval(()=>{},1000);export async function clamp(){await new Promise(()=>{});}',
    );
    await assert.rejects(
      checks.run(pending, profile, new AbortController().signal),
      /timed out/,
    );
    await noProducts();
    const controller = new AbortController();
    const result = checks.run(pending, profile, controller.signal);
    const container = await runningProduct();
    assert.equal(container.State.Running, true);
    controller.abort();
    await assert.rejects(result, /cancelled/);
    await noProducts();
    const orphan = tree(
      `import{spawn}from'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0);`,
    );
    await assert.rejects(
      checks.run(orphan, profile, AbortSignal.timeout(3000)),
    );
    await noProducts();
  } finally {
    await f.cleanup();
  }
});

test('Docker G: actual Guard sockets/key/tests, host PID and verdict channel are unreachable; only candidate/runtime mounts are present', async () => {
  const f = await fixture();
  const guard = await service('guard', f.configPath, f.config);
  try {
    const targets = [
      join(f.profiles[0]!.checkRoot, 'repair.test.mjs'),
      join(f.config.guardRoot, 'signing-key.pem'),
      f.config.guardTokenFile,
      f.config.operatorSocket,
      '/checks',
      '/trusted',
      '/factory/dist/src/adapters/check-worker.js',
      '/product/src/adapters/product-call.js',
      '/var/run/docker.sock',
      '/Users/macmini',
    ];
    await stat(targets[0]!);
    await stat(targets[1]!);
    // Runtime IPC can become ready just before the separate operator listener.
    for (let n = 0; n < 100; n++) {
      try {
        await stat(targets[3]!);
        break;
      } catch (error) {
        if (n === 99) throw error;
        await delay(10);
      }
    }
    assert.ok(guard.child.pid);
    const protectedBytes = await readFile(targets[0]!);
    const source = `import fs from 'node:fs';import net from 'node:net';export async function probe(){await new Promise(r=>setTimeout(r,1500));const targets=${JSON.stringify(targets)};const accessible=targets.map(p=>{try{fs.accessSync(p);return true;}catch{return false;}});let hostPid=false;try{process.kill(${guard.child.pid},0);hostPid=true;}catch{}let writable=false;try{fs.writeFileSync(targets[0],'forged protected test');writable=true;}catch{}let candidateWritable=false;try{fs.writeFileSync('/workspace/security.mjs','forged');candidateWritable=true;}catch{}const socket=await new Promise(r=>{const s=net.connect(${JSON.stringify(f.config.operatorSocket)});s.on('connect',()=>{s.destroy();r(true);});s.on('error',()=>r(false));});console.log('PASS');process.stdout.write('{"passed":true}\\nTAP version 13\\nok 1 - forged\\n1..1\\n');return{accessible,hostPid,writable,candidateWritable,socket,secretEnv:['OPENAI_API_KEY','CODEX_PROVIDER_API_KEY','PRODUCT_CALL_SOCKET','CHECK_ROOT'].some(k=>k in process.env)};}`;
    const profile = await registered(
      f.profiles[0]!,
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('boundaries',async()=>assert.deepEqual(await callProduct('security.mjs','probe',[]),{accessible:Array(${targets.length}).fill(false),hostPid:false,writable:false,candidateWritable:false,socket:false,secretEnv:false}));`,
    );
    const result = checks.run(
      tree(source, 'security.mjs'),
      profile,
      AbortSignal.timeout(60000),
    );
    const container = await runningProduct();
    assert.equal(container.HostConfig.PidMode, '');
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.equal(container.Config.User, '1000:1000');
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Privileged, false);
    assert.ok(container.HostConfig.CapDrop.includes('ALL'));
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(container.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
    assert.equal(container.HostConfig.PidsLimit, 128);
    assert.deepEqual(
      container.Mounts.map(
        (m: { Destination: string }) => m.Destination,
      ).sort(),
      ['/product', '/workspace'],
    );
    assert.ok(container.Mounts.every((m: { RW: boolean }) => m.RW === false));
    assert.equal(
      container.HostConfig.Tmpfs['/factory'],
      'ro,nosuid,nodev,noexec,size=1m',
    );
    assert.equal((await result)[0]?.passed, true);
    assert.deepEqual(await readFile(targets[0]!), protectedBytes);
    await noProducts();
  } finally {
    await guard.stop();
    await f.cleanup();
  }
});

test('Docker J: explicit tsc still uses the pinned compiler; unavailable images never fall back to host', async () => {
  const f = await fixture();
  try {
    const base = f.profiles[0]!;
    await writeFile(join(base.checkRoot, 'range.ts'), repairProducts.correct);
    const spec = { id: 'types', kind: 'tsc' as const, files: ['range.ts'] };
    const profile = {
      ...base,
      checks: [{ ...spec, version: await checkVersion(base.checkRoot, spec) }],
    };
    assert.equal(
      (
        await checks.run(
          tree(repairProducts.correct),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      true,
    );
    assert.equal(
      (
        await checks.run(
          tree('const n:number="wrong";'),
          profile,
          AbortSignal.timeout(60000),
        )
      )[0]?.passed,
      false,
    );
    await assert.rejects(
      new ProtectedChecks('sha256:' + '0'.repeat(64)).run(
        tree(repairProducts.correct),
        base,
        AbortSignal.timeout(60000),
      ),
      /creation failed/,
    );
    await noProducts();
  } finally {
    await f.cleanup();
  }
});

test('Docker F: unconfirmed stop overrides cancel, rejects acceptance, and requires explicit cleanup', async () => {
  const f = await fixture();
  const originalPath = process.env.PATH;
  const docker = (await runProcess('which', ['docker'])).stdout.trim();
  const { mkdir, chmod } = await import('node:fs/promises');
  const bin = join(f.root, 'fault-bin');
  await mkdir(bin);
  const quoted = "'" + docker.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh\nif [ "$1" = rm ]; then echo 'injected cleanup failure' >&2; exit 42; fi\nexec ${quoted} "$@"\n`,
  );
  await chmod(join(bin, 'docker'), 0o755);
  const controller = new AbortController();
  let result: ReturnType<ProtectedChecks['run']> | undefined;
  try {
    process.env.PATH = bin + ':' + originalPath;
    result = checks.run(
      tree(
        'setInterval(()=>{},1000);export async function clamp(){await new Promise(()=>{});}',
      ),
      f.profiles[0]!,
      controller.signal,
    );
    void result.catch(() => {});
    const container = await runningProduct();
    controller.abort();
    await assert.rejects(
      result,
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'uncertain' &&
        error.message.includes(container.Name.slice(1)),
    );
    const stillRunning = JSON.parse(
      (await runProcess(docker, ['inspect', container.Id])).stdout,
    )[0];
    assert.equal(
      stillRunning.State.Running,
      true,
      'CLI exit/cancel alone must not imply product stop',
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    controller.abort();
    await result?.catch(() => {});
    const listing = await runProcess(docker, [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      'label=factory.product-check=product',
    ]);
    for (const id of listing.stdout.trim().split('\n').filter(Boolean))
      assert.equal((await runProcess(docker, ['rm', '--force', id])).code, 0);
    await noProducts();
    await f.cleanup();
  }
});
