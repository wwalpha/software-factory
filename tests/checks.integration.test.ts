import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, edits } from './helpers.js';
import { repairProducts } from './fixtures/check-products.js';
import { ProtectedChecks, checkVersion } from '../src/adapters/checks.js';
import { digest, type Tree } from '../src/adapters/artifacts.js';
import { runProcess } from '../src/adapters/process.js';
import type { ProjectProfile } from '../src/domain/contracts.js';

const productTree = (source: string, module = 'range.ts'): Tree => {
  return {
    [module]: {
      content: Buffer.from(source).toString('base64'),
      executable: false,
    },
  };
};
const registeredTest = async (
  profile: ProjectProfile,
  source: string,
  file = 'probe.test.mjs',
) => {
  await writeFile(join(profile.checkRoot, file), source);
  const spec = { id: 'probe', kind: 'node-test' as const, files: [file] };
  return {
    ...profile,
    checks: [{ ...spec, version: await checkVersion(profile.checkRoot, spec) }],
  };
};
const invocationTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import {callProduct} from 'factory:product'; test('observation', async()=>assert.equal(await callProduct('range.ts','clamp',[-5,0,10]),0));`;

// These host fixtures attempt only JavaScript mutations/pipe output, never filesystem/process attacks.
test('A/B/C: correct repair/refactor pass; wrong products, shared assert mutation and forged output fail', async () => {
  const f = await fixture();
  try {
    const repair = f.profiles[0]!,
      refactor = f.profiles[1]!;
    const checks = new ProtectedChecks();
    for (const [name, source] of Object.entries(repairProducts)) {
      if (name === 'earlyExit' || name === 'importError') continue;
      const result = await checks.run(
        productTree(source),
        repair,
        AbortSignal.timeout(5000),
      );
      assert.equal(result[0]?.passed, name === 'correct', name);
    }
    let source = await readFile(join(refactor.repository, 'names.ts'), 'utf8');
    assert.equal(
      (
        await checks.run(
          productTree(source, 'names.ts'),
          refactor,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
    for (const edit of edits.filter((edit) => edit.path === 'names.ts'))
      source = source.replaceAll(edit.before, edit.after);
    assert.equal(
      (
        await checks.run(
          productTree(source, 'names.ts'),
          refactor,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      true,
    );
    const hostile = `import assert from 'node:assert/strict';assert.deepEqual=()=>{};${source.replaceAll('names.map(normalizeName)', 'names.map(()=>"wrong")')}`;
    assert.equal(
      (
        await checks.run(
          productTree(hostile, 'names.ts'),
          refactor,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
    const duplicated =
      source + '\nconst unused=(s:string)=>s.trim().toLowerCase();';
    assert.equal(
      (
        await checks.run(
          productTree(duplicated, 'names.ts'),
          refactor,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('D: empty, skip/todo, early exit, and import/function exceptions never pass', async () => {
  const f = await fixture();
  try {
    const checks = new ProtectedChecks(),
      base = f.profiles[0]!;
    for (const source of [
      '',
      'console.log("PASS");process.exit(0);',
      `import test from 'node:test'; test.skip('skip',()=>{});`,
      `import test from 'node:test'; test.todo('todo');`,
      `import test from 'node:test';test('real',()=>{});process.exit(0);`,
    ]) {
      const profile = await registeredTest(base, source);
      assert.equal(
        (await checks.run({}, profile, AbortSignal.timeout(5000)))[0]?.passed,
        false,
        source,
      );
    }
    await assert.rejects(
      checks.run(
        productTree(repairProducts.earlyExit),
        base,
        AbortSignal.timeout(5000),
      ),
    );
    await assert.rejects(
      checks.run(
        productTree('process.exit(7);'),
        base,
        AbortSignal.timeout(5000),
      ),
      /exited abnormally/,
    );
    for (const source of [
      repairProducts.importError,
      'export function clamp(){throw Error("call failed");}',
    ])
      assert.equal(
        (
          await checks.run(productTree(source), base, AbortSignal.timeout(5000))
        )[0]?.passed,
        false,
      );
    const profile = await registeredTest(
      base,
      `import test from 'node:test'; import assert from 'node:assert/strict'; import {callProduct} from 'factory:product'; test('caught product error',async()=>{await assert.rejects(callProduct('range.ts','clamp',[]));});`,
    );
    assert.equal(
      (
        await checks.run(
          productTree(repairProducts.importError),
          profile,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('E: malformed, extra, duplicate, missing, other-ID responses and excessive output are rejected through real workers', async () => {
  const f = await fixture();
  try {
    const checks = new ProtectedChecks(),
      profile = f.profiles[0]!;
    const mutations = [
      'return encode({passed:true})',
      'return ""',
      'return encode(v)+encode(v)',
      'return encode({...v,id:"00000000-0000-0000-0000-000000000000"})',
      'return encode({...v,passed:true})',
      `return encode(v).replace('"value":-5','"value":1e999')`,
      'return encode(v).replace("{",\'{"id":"00000000-0000-0000-0000-000000000000",\')',
    ];
    for (const mutation of mutations) {
      const source = `const encode=JSON.stringify; JSON.stringify=(v)=>{${mutation}}; ${repairProducts.wrong}`;
      await assert.rejects(
        checks.run(productTree(source), profile, AbortSignal.timeout(5000)),
        Error,
        mutation,
      );
    }
    for (const stream of ['stdout', 'stderr'])
      await assert.rejects(
        checks.run(
          productTree(
            `process.${stream}.write('x'.repeat(70000));${repairProducts.wrong}`,
          ),
          profile,
          AbortSignal.timeout(5000),
        ),
        /output exceeded/,
      );
    const profileLimit = await registeredTest(
      profile,
      `import test from 'node:test';import{callProduct,readProductSource}from'factory:product';test('limit',async()=>{await callProduct('range.ts','clamp',[0,0,10]);for(let i=0;i<128;i++)await readProductSource('range.ts');});`,
    );
    await assert.rejects(
      checks.run(
        productTree(repairProducts.correct),
        profileLimit,
        AbortSignal.timeout(5000),
      ),
      /excessive/,
    );
  } finally {
    await f.cleanup();
  }
});

test('F: timeout and cancel await product termination; partial response followed by exit is refused', async () => {
  const f = await fixture();
  try {
    const profile = await registeredTest(f.profiles[0]!, invocationTest);
    const checks = new ProtectedChecks();
    const source =
      'setInterval(()=>{},1000);export async function clamp(){await new Promise(()=>{});}';
    await assert.rejects(
      checks.run(productTree(source), profile, new AbortController().signal),
      /timed out/,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(
      checks.run(productTree(source), profile, controller.signal),
      /cancelled/,
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      checks.run(productTree(source), profile, preAborted.signal),
      /cancelled/,
    );
    await assert.rejects(
      checks.run(
        productTree(
          `import{writeSync}from'node:fs';writeSync(3,'{"protocol":');process.exit(0);`,
        ),
        profile,
        AbortSignal.timeout(5000),
      ),
    );
    // Existing process regression also proves whole descendant groups die. Here observe actual worker exits.
    const children = await runProcess('ps', ['-axo', 'command=']);
    assert.equal(
      children.stdout
        .split('\n')
        .some((line) => /factory-check-.*product-worker\.js/.test(line)),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('H: fixed snapshots, legacy versions/imports, unsafe paths and symlink checks are refused', async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!,
      checks = new ProtectedChecks();
    const spec = profile.checks[0]!;
    const snapshotProfile = await registeredTest(
      profile,
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct,readProductSource}from'factory:product';test('same snapshot',async()=>{assert.equal(await callProduct('range.ts','clamp',[-5,0,10]),0);assert.ok((await readProductSource('range.ts')).includes('Math.max'));});`,
    );
    const mutable = productTree(repairProducts.correct);
    const executing = checks.run(
      mutable,
      snapshotProfile,
      AbortSignal.timeout(5000),
    );
    mutable['range.ts']!.content = Buffer.from(repairProducts.wrong).toString(
      'base64',
    );
    assert.equal((await executing)[0]?.passed, true);
    const bytes = await readFile(join(profile.checkRoot, spec.files[0]!));
    const legacy = digest({
      kind: spec.kind,
      files: { [spec.files[0]!]: bytes.toString('base64') },
    });
    assert.notEqual(legacy, spec.version);
    await assert.rejects(
      checks.run(
        productTree(repairProducts.correct),
        { ...profile, checks: [{ ...spec, version: legacy }] },
        AbortSignal.timeout(5000),
      ),
      /migration/,
    );
    await writeFile(
      join(profile.checkRoot, spec.files[0]!),
      Buffer.concat([bytes, Buffer.from('\n')]),
    );
    await assert.rejects(
      checks.run(
        productTree(repairProducts.correct),
        profile,
        AbortSignal.timeout(5000),
      ),
      /changed/,
    );
    const legacyProfile = await registeredTest(
      profile,
      `import test from 'node:test';import{pathToFileURL}from'node:url';const product=await import(pathToFileURL(process.env.PRODUCT_ROOT+'/range.ts'));test('legacy',()=>{});`,
    );
    assert.equal(
      (
        await checks.run(
          productTree(repairProducts.correct),
          legacyProfile,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
    const graphProfile = await registeredTest(
      profile,
      `import '${new URL('../fixtures/check-products.js', import.meta.url).href}';import test from 'node:test';test('outside snapshot',()=>{});`,
    );
    assert.equal(
      (
        await checks.run(
          productTree(repairProducts.correct),
          graphProfile,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
    await symlink('/etc/passwd', join(profile.checkRoot, 'link.mjs'));
    await assert.rejects(
      checkVersion(profile.checkRoot, {
        kind: 'node-test',
        files: ['link.mjs'],
      }),
      /Links/,
    );
  } finally {
    await f.cleanup();
  }
});

test('I: unrelated modules/exports, async finite data and business passed properties; state is fresh per invocation', async () => {
  const f = await fixture();
  try {
    const profile = await registeredTest(
      f.profiles[0]!,
      `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('independent values',async()=>{assert.equal(await callProduct('nested/arithmetic.mjs','double',[9]),18);assert.equal(await callProduct('labels.ts','decorate',['東京']),'[東京]');assert.deepEqual(await callProduct('labels.ts','reverse',[[1,'hello',true,null]]),[null,true,'hello',1]);assert.deepEqual(await callProduct('labels.ts','status',[]),{passed:true,message:'PASS'});assert.equal(await callProduct('labels.ts','counter',[]),1);assert.equal(await callProduct('labels.ts','counter',[]),1);});`,
    );
    const tree = {
      ...productTree(
        'export async function double(n){return n*2;}',
        'nested/arithmetic.mjs',
      ),
      ...productTree(
        "export async function decorate(s:string){return '['+s+']';}export function reverse(a:unknown[]){return a.toReversed();}export function status(){return {passed:true,message:'PASS'};}let count=0;export function counter(){return ++count;}",
        'labels.ts',
      ),
    };
    const checks = new ProtectedChecks();
    assert.equal(
      (await checks.run(tree, profile, AbortSignal.timeout(5000)))[0]?.passed,
      true,
    );
    for (const value of [
      'undefined',
      'NaN',
      'Infinity',
      '-0',
      '1n',
      'new Date()',
      'new Map()',
      '[,1]',
      '(()=>{const a={};a.self=a;return a;})()',
      '({get v(){return 1;}})',
      '({[Symbol("s")]:1})',
    ])
      assert.equal(
        (
          await checks.run(
            productTree(`export function clamp(){return ${value};}`),
            f.profiles[0]!,
            AbortSignal.timeout(5000),
          )
        )[0]?.passed,
        false,
        value,
      );
    for (const [value, coerced] of [
      ['undefined', 'null'],
      ['NaN', 'null'],
      ['Infinity', 'null'],
      ['({v:undefined})', '{}'],
      ['Object.defineProperty([],"0",{value:undefined})', '[null]'],
      ['Object.defineProperty([],"0",{get(){return null;}})', '[null]'],
    ]) {
      const nonLossy = await registeredTest(
        f.profiles[0]!,
        `import test from 'node:test';import assert from 'node:assert/strict';import{callProduct}from'factory:product';test('no silent coercion',async()=>assert.deepEqual(await callProduct('range.ts','clamp',[]),${coerced}));`,
      );
      assert.equal(
        (
          await checks.run(
            productTree(`export function clamp(){return ${value};}`),
            nonLossy,
            AbortSignal.timeout(5000),
          )
        )[0]?.passed,
        false,
        value,
      );
    }
    for (const module of [
      '/etc/passwd',
      '../range.ts',
      'file:///etc/passwd',
      'https://invalid/product.mjs',
      'a/../range.ts',
    ]) {
      const invalid = await registeredTest(
        f.profiles[0]!,
        `import test from 'node:test';import{callProduct}from'factory:product';test('path',async()=>{await callProduct(${JSON.stringify(module)},'clamp',[]);});`,
      );
      assert.equal(
        (
          await checks.run(
            productTree(repairProducts.correct),
            invalid,
            AbortSignal.timeout(5000),
          )
        )[0]?.passed,
        false,
      );
    }
    const invalid = await registeredTest(
      f.profiles[0]!,
      `import test from 'node:test';import{callProduct}from'factory:product';test('export',async()=>{await callProduct('range.ts','clamp.call',[]);});`,
    );
    assert.equal(
      (
        await checks.run(
          productTree(repairProducts.correct),
          invalid,
          AbortSignal.timeout(5000),
        )
      )[0]?.passed,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('J: independent tsc remains a distinct check and rejects a type error', async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    await writeFile(
      join(profile.checkRoot, 'range.ts'),
      repairProducts.correct,
    );
    const spec = { id: 'typecheck', kind: 'tsc' as const, files: ['range.ts'] };
    const registered = {
      ...profile,
      checks: [
        { ...spec, version: await checkVersion(profile.checkRoot, spec) },
      ],
    };
    const checks = new ProtectedChecks();
    assert.equal(
      (
        await checks.run(
          productTree(repairProducts.correct),
          registered,
          AbortSignal.timeout(10000),
        )
      )[0]?.passed,
      true,
    );
    assert.equal(
      (
        await checks.run(
          productTree('const value: number = "wrong";'),
          registered,
          AbortSignal.timeout(10000),
        )
      )[0]?.passed,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
