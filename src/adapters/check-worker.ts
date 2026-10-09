import { run } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const payload: { kind: 'node-test' | 'tsc'; files: string[] } = JSON.parse(
  process.argv[2] ?? 'null',
);
const root = process.env.CHECK_ROOT ?? '/checks';
process.env.PRODUCT_ROOT ??= '/workspace';
let passed: boolean;
if (payload.kind === 'node-test') {
  let pass = 0,
    fail = 0,
    skipped = 0,
    tests = 0,
    namedTests = 0;
  const events = run({
    files: payload.files.map((p) => resolve(root, p)),
    isolation: 'process',
    timeout: 45000,
  });
  for await (const event of events) {
    if (event.type === 'test:pass') {
      pass++;
      if (event.data.name !== event.data.file) namedTests++;
      if (event.data.skip || event.data.todo) skipped++;
    }
    if (event.type === 'test:fail') fail++;
    if (event.type === 'test:summary')
      tests = Math.max(tests, event.data.counts.tests);
  }
  passed =
    namedTests > 0 && tests > 0 && pass >= tests && fail === 0 && skipped === 0;
} else {
  const result = spawnSync(
    process.execPath,
    [
      new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)
        .pathname,
      '--noEmit',
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
