import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerRunner } from '../src/adapters/docker.js';
import { runProcess } from '../src/adapters/process.js';
import { WORKER_INPUT_BYTES } from '../src/adapters/worker-input.js';
import { workerInput } from '../tests/fixtures/worker-input.js';
import { ensure } from '../src/domain/invariants.js';

const image = process.env.WORKER_INPUT_IMAGE;
ensure(
  image && /^sha256:[a-f0-9]{64}$/.test(image),
  'BLOCKED',
  'Set WORKER_INPUT_IMAGE to the pinned test-only model fixture image',
);
ensure(
  (await runProcess('docker', ['image', 'inspect', image])).code === 0,
  'BLOCKED',
  'Actual Docker and fixture image required; no fallback',
);
const runId = `p1d-${randomUUID()}`;
const noContainer = async (name: string) => {
  const listing = await runProcess('docker', [
    'ps',
    '-a',
    '--format',
    '{{.Names}}',
    '--filter',
    `name=^${name}$`,
  ]);
  assert.equal(listing.code, 0);
  assert.equal(listing.stdout.trim(), '');
};
const running = async (name: string) => {
  for (let n = 0; n < 200; n++) {
    const info = await runProcess('docker', ['inspect', name]);
    if (info.code === 0) {
      const value = JSON.parse(info.stdout)[0];
      if (value.State.Running) return value;
    }
    await delay(25);
  }
  throw Error('Test Worker did not start');
};
const safeLogs = (value: string) => {
  for (const secret of [
    'stdin-private-prompt',
    'stdin-private-secret',
    'stdin-private-key',
  ])
    assert.ok(!value.includes(secret), 'Raw input/credential leaked');
};
const args = (name: string, root: string) => [
  'run',
  '-i',
  '--name',
  name,
  '--label',
  `factory.stdin-test=${runId}`,
  '--init',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '128',
  '--memory',
  '1g',
  '--cpus',
  '1',
  '--user',
  `${process.getuid?.()}:${process.getgid?.()}`,
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=128m',
  '--workdir',
  '/workspace',
  '--mount',
  `type=bind,src=${root},dst=/workspace`,
  image,
  'node',
  '/factory/dist/src/adapters/codex-worker.js',
];
const worker = async (bytes: Buffer, split = false, eof = true) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-p1d-worker-'));
  await chmod(root, 0o755);
  const name = `${runId}-${randomUUID()}`;
  const started = performance.now();
  let stdout = '',
    stderr = '';
  const child = spawn('docker', args(name, root), {
    env: { PATH: process.env.PATH ?? '' },
  });
  child.stdout.on('data', (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 125000);
  try {
    await running(name);
    if (split) {
      // Split inside each Japanese UTF-8 character, with separate pipe writes.
      const at = bytes.indexOf(Buffer.from('東京'));
      assert.ok(at >= 0);
      child.stdin.write(bytes.subarray(0, at + 1));
      await delay(30);
      child.stdin.write(bytes.subarray(at + 1, at + 4));
      await delay(30);
      child.stdin.write(bytes.subarray(at + 4));
    } else child.stdin.write(bytes);
    if (eof) child.stdin.end();
    const [code] = await closed;
    assert.notEqual(code, null, 'Worker must exit itself within its deadline');
    const info = await runProcess('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]);
    assert.equal(info.code, 0);
    assert.equal(info.stdout.trim(), 'false');
    safeLogs(stdout + stderr);
    const files = await readdir(root);
    let received: unknown = null;
    if (files.includes('received.json'))
      received = JSON.parse(
        await readFile(join(root, 'received.json'), 'utf8'),
      );
    return { code, stdout, stderr, received, ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill('SIGKILL');
    assert.equal((await runProcess('docker', ['rm', '--force', name])).code, 0);
    await noContainer(name);
    await rm(root, { recursive: true, force: true });
  }
};

test('DockerRunner -> runProcess -> actual Worker -> fixture model: all fields arrive exactly after EOF', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-p1d-runner-'));
  const input = workerInput();
  input.attempt.operationId = `${runId}-normal`;
  const runner = new DockerRunner(image, root, 'stdin-private-key');
  try {
    const started = performance.now();
    const result = await runner.run(
      input.attempt,
      {},
      input.prompt,
      input.recipe,
      input.binding,
      AbortSignal.timeout(10000),
    );
    assert.equal(result.fact.outcome, 'completed');
    assert.equal(result.fact.stopped, true);
    const received = result.tree['received.json'];
    assert.ok(received);
    assert.deepEqual(
      JSON.parse(Buffer.from(received.content, 'base64').toString()),
      input,
    );
    safeLogs(JSON.stringify(result.fact));
    assert.deepEqual(await readdir(root), []);
    await noContainer(`factory-${input.attempt.operationId}`);
    t.diagnostic(
      `production Runner input + confirmed removal: ${(performance.now() - started).toFixed(1)} ms`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('real Worker split UTF-8, escapes, EOF, malformed inputs and exact byte limit', async (t) => {
  const input = workerInput();
  const split = await worker(Buffer.from(JSON.stringify(input)), true);
  assert.equal(split.code, 0);
  assert.deepEqual(split.received, input);
  t.diagnostic(`split input + EOF: ${split.ms.toFixed(1)} ms`);
  for (const raw of [
    '',
    'stdin-private-secret',
    '{"attempt":',
    JSON.stringify({ ...input, recipe: {} }),
    JSON.stringify({ ...input, binding: {} }),
    JSON.stringify({ ...input, prompt: 42 }),
  ]) {
    const result = await worker(Buffer.from(raw));
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.received, null);
    assert.equal(
      result.stderr,
      'Worker input or startup failed; raw input omitted\n',
    );
    t.diagnostic(
      `invalid ${Buffer.byteLength(raw)} bytes: ${result.ms.toFixed(1)} ms; model calls 0`,
    );
  }
  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ ...input, prompt: '' }),
  );
  const boundary = {
    ...input,
    prompt: 'a'.repeat(WORKER_INPUT_BYTES - emptyBytes),
  };
  const bytes = Buffer.from(JSON.stringify(boundary));
  assert.equal(bytes.length, WORKER_INPUT_BYTES);
  const valid = await worker(bytes);
  assert.equal(valid.code, 0);
  assert.deepEqual(valid.received, boundary);
  const excessive = await worker(Buffer.concat([bytes, Buffer.from(' ')]));
  assert.equal(excessive.code, 2);
  assert.equal(excessive.received, null);
  assert.equal(excessive.stdout, '');
});
test('DockerRunner cancel, timeout, isolation, startup failure; open stdin expires without a model call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-p1d-stop-'));
  const runner = new DockerRunner(image, root, 'stdin-private-key');
  const input = workerInput();
  const stoppedRun = async (cancel: boolean) => {
    const attempt = {
      ...input.attempt,
      operationId: `${runId}-${randomUUID()}`,
    };
    const controller = new AbortController();
    const started = performance.now();
    const pending = runner.run(
      attempt,
      {},
      'fixture-hang',
      input.recipe,
      input.binding,
      controller.signal,
    );
    const name = `factory-${attempt.operationId}`;
    const container = await running(name);
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(container.HostConfig.PidsLimit, 128);
    assert.equal(container.HostConfig.Memory, 1024 ** 3);
    assert.equal(container.HostConfig.NanoCpus, 1e9);
    assert.equal(
      container.Config.User,
      `${process.getuid?.()}:${process.getgid?.()}`,
    );
    assert.ok(!container.Config.User.startsWith('0:'));
    assert.equal(container.Config.OpenStdin, true);
    assert.equal(container.Config.Tty, false);
    assert.equal(container.Config.Labels['factory.builder-worker'], 'true');
    assert.ok(
      !JSON.stringify(container.Config.Env).includes('stdin-private-key'),
    );
    assert.deepEqual(
      container.Mounts.filter((m: { Type: string }) => m.Type === 'bind')
        .map((m: { Destination: string }) => m.Destination)
        .sort(),
      ['/ipc', '/workspace'],
    );
    if (cancel) controller.abort();
    const result = await pending;
    let outcome = 'timeout';
    if (cancel) outcome = 'cancelled';
    assert.equal(result.fact.outcome, outcome);
    assert.equal(result.fact.stopped, true);
    assert.deepEqual(result.tree, {});
    assert.equal(await runner.isStopped(attempt.operationId), true);
    await noContainer(name);
    safeLogs(JSON.stringify(result.fact));
    t.diagnostic(
      `${outcome} + confirmed removal: ${(performance.now() - started).toFixed(1)} ms`,
    );
  };
  try {
    const providerAttempt = {
      ...input.attempt,
      operationId: `${runId}-provider-timeout`,
    };
    const provider = await runner.run(
      providerAttempt,
      {},
      'fixture-provider-timeout',
      input.recipe,
      input.binding,
      AbortSignal.timeout(10000),
    );
    assert.equal(provider.fact.outcome, 'timeout');
    assert.equal(provider.fact.stopped, true);
    assert.deepEqual(provider.tree, {});
    safeLogs(JSON.stringify(provider.fact));
    await noContainer(`factory-${providerAttempt.operationId}`);
    const earlyAttempt = {
      ...input.attempt,
      operationId: `${runId}-early-exit`,
    };
    const early = await runner.run(
      earlyAttempt,
      {},
      'fixture-early-exit',
      input.recipe,
      input.binding,
      AbortSignal.timeout(10000),
    );
    assert.equal(early.fact.outcome, 'failed');
    assert.equal(
      early.fact.detail,
      'Worker exited unsuccessfully; raw output omitted',
    );
    assert.equal(early.fact.stopped, true);
    assert.deepEqual(early.tree, {});
    await noContainer(`factory-${earlyAttempt.operationId}`);
    await stoppedRun(true);
    const [noEof, emptyNoEof] = await Promise.all([
      worker(Buffer.from('{"prompt":"unfinished'), false, false),
      worker(Buffer.alloc(0), false, false),
      stoppedRun(false),
    ]);
    assert.ok(emptyNoEof);
    assert.equal(emptyNoEof.code, 2);
    assert.equal(emptyNoEof.received, null);
    assert.equal(emptyNoEof.stdout, '');
    t.diagnostic(
      `empty input without EOF: ${emptyNoEof.ms.toFixed(1)} ms; model calls 0`,
    );
    assert.equal(noEof.code, 2);
    assert.equal(noEof.received, null);
    assert.equal(noEof.stdout, '');
    t.diagnostic(
      `partial input without EOF: ${noEof.ms.toFixed(1)} ms; model calls 0`,
    );
    const bad = new DockerRunner(
      `sha256:${'0'.repeat(64)}`,
      root,
      'stdin-private-key',
    );
    const attempt = {
      ...input.attempt,
      operationId: `${runId}-startup-failure`,
    };
    const failed = await bad.run(
      attempt,
      {},
      input.prompt,
      input.recipe,
      input.binding,
      AbortSignal.timeout(10000),
    );
    assert.equal(failed.fact.outcome, 'failed');
    assert.equal(
      failed.fact.detail,
      'Docker startup failed; raw output omitted',
    );
    assert.equal(failed.fact.stopped, true);
    assert.deepEqual(failed.tree, {});
    await noContainer(`factory-${attempt.operationId}`);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
