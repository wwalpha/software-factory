import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from './queue.js';
import { AppServer, array, object, string } from './codex-app-probe.js';
import { Worktrees } from './worktree.js';

// Legacy history omits nested tool calls from thread/read; inspect actual tool receipts.
export function successfulOutputs(session: string): string[] {
  const outputs: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        visit(JSON.parse(value));
      } catch {
        /* Plain text is not a tool receipt. */
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      const entry = value as Record<string, unknown>;
      if (entry.exit_code === 0 && typeof entry.output === 'string')
        outputs.push(entry.output);
      Object.values(entry).forEach(visit);
    }
  };
  for (const line of session.trim().split('\n')) {
    const entry = object(JSON.parse(line));
    const payload = object(entry.payload);
    if (
      payload.type === 'custom_tool_call_output' ||
      payload.type === 'function_call_output'
    )
      visit(payload.output);
  }
  return outputs;
}

// Explicit opt-in: two real independent Codex tasks, never part of npm test/check.
const main = async () => {
  assert.deepEqual(
    process.argv.slice(2),
    ['--run'],
    'Usage: node dist/scripts/queue-e2e.js --run (creates two real Codex tasks)',
  );
  const manager = await Worktrees.open();
  manager.initialize();
  await manager.withLock('queue-e2e.lock', false, async () => {
    const queue = new Queue(manager);
    assert.ok(
      (await queue.status()).every((item) => item.status === 'DONE'),
      'E2E requires no active, blocked or pending queue entries',
    );
    const id = `queue-e2e-${Date.now()}`;
    await manager.run('create', id);
    await manager.run('exec', id, [
      'git',
      'commit',
      '--allow-empty',
      '-m',
      'Verify Queue cleanup handoff',
    ]);
    const nextPrompt =
      'This is an authorized read-only Queue E2E task. Read AGENTS.md and the Worktree skill. Use a tool to run pwd and git branch --show-current in your assigned Worktree, then reply with QUEUE_E2E_C_OK and the observed directory and branch. Do not change files or create tasks. The Queue Worker handles validation, local integration and Cleanup.';
    const prompt = `$queue ${nextPrompt}`;
    const registered = await queue.enqueue(prompt);
    assert.equal(
      (await queue.status()).find((item) => item.id === registered.id)
        ?.threadId,
      undefined,
      'Registration launched an agent',
    );
    console.log(
      JSON.stringify({ phase: 'QUEUED', id: registered.id, starter: id }),
    );
    await manager.run('complete', id);
    const deadline = Date.now() + 15 * 60 * 1000;
    let items;
    while (true) {
      items = (await queue.status()).filter(
        (item) => Number(item.id.slice(2)) >= Number(registered.id.slice(2)),
      );
      const failed = items.find((item) => item.status === 'BLOCKED');
      assert.ok(!failed, `E2E blocked: ${JSON.stringify(failed)}`);
      assert.ok(
        !(items.length === 1 && items[0]?.status === 'DONE'),
        'B finished without registering C; skill invocation was not verified',
      );
      if (items.length === 2 && items.every((item) => item.status === 'DONE'))
        break;
      assert.ok(
        Date.now() < deadline,
        'E2E deadline reached; preserve state and inspect workers, never blindly replay',
      );
      await delay(1000);
    }
    assert.equal(items[0]?.prompt, prompt);
    assert.equal(
      items[1]?.prompt,
      nextPrompt,
      '$queue changed the registered prompt',
    );
    assert.equal(new Set(items.map((item) => item.threadId)).size, 2);
    const statuses = [];
    for (const item of items) {
      const status = await manager.status(item.taskId);
      assert.equal(status.status, 'DONE');
      assert.equal(status.pathExists, false);
      assert.equal(status.actualBranch, false);
      statuses.push(status);
    }
    const c = items[1];
    assert.ok(c?.threadId);
    const server = new AppServer(
      'codex',
      ['app-server', '--listen', 'stdio://'],
      manager.repository,
      30000,
    );
    let execution;
    try {
      await server.request('initialize', {
        clientInfo: {
          name: 'software_factory_queue_e2e',
          title: 'Queue E2E verification',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      server.initialized();
      const thread = object(
        object(
          await server.request('thread/read', {
            threadId: c.threadId,
            includeTurns: true,
          }),
        ).thread,
      );
      const turn = object(array(thread.turns)[0]);
      const entries = array(turn.items).map(object);
      const commands = entries.filter(
        (item) => item.type === 'commandExecution',
      );
      const receipts = successfulOutputs(
        readFileSync(string(thread.path), 'utf8'),
      );
      assert.ok(
        commands.some(
          (item) => string(item.command).includes('pwd') && item.exitCode === 0,
        ) ||
          receipts.some((output) =>
            output.trim().split('\n').includes(join(manager.root, c.taskId)),
          ),
        'C did not execute pwd successfully',
      );
      assert.ok(
        commands.some(
          (item) =>
            string(item.command).includes('git branch') && item.exitCode === 0,
        ) ||
          receipts.some((output) =>
            output.trim().split('\n').includes(`task/${c.taskId}`),
          ),
        'C did not inspect its branch',
      );
      const replies = entries
        .filter((item) => item.type === 'agentMessage')
        .map((item) => string(item.text));
      assert.ok(
        replies.some(
          (reply) =>
            reply.includes('QUEUE_E2E_C_OK') &&
            reply.includes(join(manager.root, c.taskId)) &&
            reply.includes(`task/${c.taskId}`),
        ),
        'C did not report the observed assigned worktree',
      );
      execution = { commands, receipts, replies };
    } finally {
      await server.close();
    }
    const result = {
      apiAndChain: 'PASS',
      execution,
      gui: 'UNVERIFIED',
      slashQueue: 'UNVERIFIED',
      skillQueue: 'PASS',
      starter: await manager.status(id),
      items,
      statuses,
    };
    const path = join(manager.root, `${id}.e2e.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ ...result, evidence: path }, null, 2));
  });
};
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
