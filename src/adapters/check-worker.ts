import { run } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
const payload: {
  kind: 'node-test' | 'tsc';
  files: string[];
  compiler: string;
} = JSON.parse(process.argv[2] ?? 'null');
const root = process.env.CHECK_ROOT ?? '/checks';
let passed: boolean;
if (payload.kind === 'node-test') {
  let pass = 0,
    fail = 0,
    skipped = 0,
    tests = 0,
    namedTests = 0;
  const testedFiles = new Set<string>();
  const events = run({
    files: payload.files.map((p) => resolve(root, p)),
    isolation: 'process',
    timeout: 45000,
    execArgv: [
      '--import',
      new URL('./evaluator-loader.js', import.meta.url).href,
    ],
  });
  for await (const event of events) {
    if (event.type === 'test:pass') {
      pass++;
      if (event.data.name !== event.data.file) {
        namedTests++;
        if (event.data.file) testedFiles.add(event.data.file);
      }
      if (event.data.skip || event.data.todo) skipped++;
    }
    if (event.type === 'test:fail') fail++;
    if (event.type === 'test:summary')
      tests = Math.max(tests, event.data.counts.tests);
  }
  passed =
    namedTests > 0 &&
    tests > 0 &&
    pass >= tests &&
    fail === 0 &&
    skipped === 0 &&
    payload.files.every((file) =>
      testedFiles.has(realpathSync(resolve(root, file))),
    );
} else {
  const result = spawnSync(
    process.execPath,
    [
      payload.compiler,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--module',
      'nodenext',
      ...payload.files.map((p) =>
        resolve(process.env.PRODUCT_ROOT ?? '/workspace', p),
      ),
    ],
    { timeout: 45000, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
  );
  passed = result.status === 0 && !result.error;
}
process.stdout.write(JSON.stringify({ passed }) + '\n');
process.exitCode = passed ? 0 : 2;
