import { spawnSync } from 'node:child_process';
import { readFile, access, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'linux');
assert.equal(process.versions.node, '24.21.0');
const packages = spawnSync('dpkg-query', ['-W', '-f=${Package}\n'], {
  encoding: 'utf8',
});
assert.equal(packages.status, 0);
assert.ok(
  !packages.stdout
    .split('\n')
    .some((n) => /^python(?:\d|$)|^libpython/.test(n)),
  'Python package found',
);
for (const path of ['/usr/bin', '/usr/local/bin', '/bin'])
  assert.ok(
    !(await readdir(path)).some((n) => /^python(?:\d|$)/.test(n)),
    'Python executable found',
  );
for (const path of ['/usr/lib/python3', '/usr/local/lib/python3'])
  await assert.rejects(access(path));
const commands = [
  ['npm', ['ci']],
  ['npm', ['run', 'schema:generate']],
  ['npm', ['run', 'schema:check']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'format:check']],
  ['npm', ['test']],
  ['node', ['dist/src/cli/factory.js', '--help']],
  ['node', ['dist/scripts/demo.js']],
] as const;
for (const [index, [command, args]] of commands.entries()) {
  const path = `/tmp/factory-exec-${index}.trace`;
  const out = spawnSync(
    'strace',
    ['-f', '-e', 'trace=process', '-o', path, command, ...args],
    { stdio: 'inherit', timeout: 240000 },
  );
  assert.equal(out.status, 0, `${command} ${args.join(' ')} failed`);
  const trace = await readFile(path, 'utf8');
  assert.ok(
    !/execve\([^\n]*\/(?:python(?:\d+(?:\.\d+)*)?|pip\d*|node-gyp)(?:"|\s)/i.test(
      trace,
    ),
    'Attempted Python/native fallback',
  );
}
console.log(
  JSON.stringify({
    status: 'PASS',
    proof:
      'Clean Debian image package/executable inventory plus syscall traces of normal install, generation, build, tests and CLI',
  }),
);
