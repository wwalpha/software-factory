import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRunner } from '../src/adapters/docker.js';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { runProcess } from '../src/adapters/process.js';
import {
  readWorkerInput,
  WORKER_INPUT_BYTES,
} from '../src/adapters/worker-input.js';
import { workerInput } from './fixtures/worker-input.js';

const rejected = async (bytes: Buffer, code = 'invalid-input') => {
  await assert.rejects(
    readWorkerInput(Readable.from([bytes]), AbortSignal.timeout(1000)),
    { code },
  );
};
test('Worker input preserves every field, byte-split UTF-8 and EOF', async (t) => {
  const input = workerInput(),
    bytes = Buffer.from(JSON.stringify(input));
  const stream = new PassThrough();
  const started = performance.now();
  let settled = false;
  const result = readWorkerInput(stream, AbortSignal.timeout(3000)).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  for (const byte of bytes) {
    stream.write(Buffer.from([byte]));
    await delay(0);
  }
  assert.equal(settled, false);
  stream.end();
  assert.deepEqual(await result, input);
  t.diagnostic(
    `byte-split read + EOF: ${(performance.now() - started).toFixed(1)} ms`,
  );
});
test('Worker rejects empty, malformed, truncated, invalid UTF-8 and each invalid contract without raw input', async () => {
  for (const value of [
    '',
    'stdin-private-secret',
    '{"prompt":"stdin-private-secret"',
    'null',
    '[]',
  ])
    await rejected(Buffer.from(value));
  await rejected(Buffer.from([0x22, 0xe6, 0x22]));
  const input = workerInput();
  for (const changed of [
    { attempt: { ...input.attempt, epoch: '1' } },
    { prompt: 7 },
    { prompt: '' },
    { recipe: { ...input.recipe, budgetUsd: '1' } },
    { binding: { ...input.binding, enabled: 'yes' } },
    { extra: 'stdin-private-secret' },
  ]) {
    await rejected(Buffer.from(JSON.stringify({ ...input, ...changed })));
  }
  await assert.rejects(
    readWorkerInput(
      Readable.from([Buffer.from('stdin-private-secret')]),
      AbortSignal.timeout(1000),
    ),
    (error) =>
      error instanceof Error && !error.message.includes('stdin-private-secret'),
  );
});
test('Worker accepts exactly the byte limit and rejects one byte over', async () => {
  const input = workerInput();
  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ ...input, prompt: '' }),
  );
  const boundary = {
    ...input,
    prompt: 'a'.repeat(WORKER_INPUT_BYTES - emptyBytes),
  };
  const bytes = Buffer.from(JSON.stringify(boundary));
  assert.equal(bytes.length, WORKER_INPUT_BYTES);
  assert.deepEqual(
    await readWorkerInput(Readable.from([bytes]), AbortSignal.timeout(1000)),
    boundary,
  );
  await rejected(Buffer.concat([bytes, Buffer.from(' ')]), 'input-limit');
});
test('Worker input waiting and partial streams terminate on deadline or cancellation', async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  for (const partial of ['', '{"prompt":"unfinished']) {
    const stream = new PassThrough();
    stream.write(partial);
    const started = performance.now();
    await assert.rejects(readWorkerInput(stream, AbortSignal.timeout(40)), {
      code: 'timeout',
    });
    assert.equal(stream.destroyed, true);
    t.diagnostic(
      `no EOF ${partial.length} bytes: ${(performance.now() - started).toFixed(1)} ms`,
    );
  }
  const stream = new PassThrough(),
    controller = new AbortController();
  const pending = readWorkerInput(stream, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(stream.destroyed, true);
});
test('process helper writes complete JSON and closes stdin; Worker rejects before model startup', async () => {
  const echo = await runProcess(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const b=[];for await(const c of process.stdin)b.push(c);process.stdout.write(Buffer.concat(b));',
    ],
    { input: JSON.stringify(workerInput()) },
  );
  assert.deepEqual(JSON.parse(echo.stdout), workerInput());
  for (const input of [
    '',
    'stdin-private-secret',
    '{"attempt":',
    JSON.stringify({ ...workerInput(), binding: {} }),
    'a'.repeat(WORKER_INPUT_BYTES + 1),
  ]) {
    const result = await runProcess(
      process.execPath,
      ['dist/src/adapters/codex-worker.js'],
      { input, timeoutMs: 3000 },
    );
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'Worker input or startup failed; raw input omitted\n',
    );
  }
});

test('Docker daemon/stop errors remain uncertain and preserve the attempt directory without fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p1d-'));
  const previousPath = process.env.PATH;
  await writeFile(
    join(root, 'docker'),
    `#!${process.execPath}\nprocess.exit(1);\n`,
  );
  await chmod(join(root, 'docker'), 0o700);
  const input = workerInput();
  const runner = new DockerRunner(
    `sha256:${'a'.repeat(64)}`,
    join(root, 'attempts'),
    'stdin-private-key',
  );
  try {
    process.env.PATH = root;
    assert.equal(await runner.stop(input.attempt.operationId), false);
    assert.equal(await runner.isStopped(input.attempt.operationId), false);
    const result = await runner.run(
      input.attempt,
      {},
      input.prompt,
      input.recipe,
      input.binding,
      AbortSignal.timeout(3000),
    );
    assert.equal(result.fact.outcome, 'uncertain');
    assert.equal(result.fact.stopped, false);
    assert.deepEqual(result.tree, {});
    assert.equal((await readdir(join(root, 'attempts'))).length, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
