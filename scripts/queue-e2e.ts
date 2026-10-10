import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from './queue.js';
import { AppServer, array, object, string } from './codex-app-probe.js';
import { Worktrees } from './worktree.js';

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
      assert.ok(
        commands.some(
          (item) => string(item.command).includes('pwd') && item.exitCode === 0,
        ),
        'C did not execute pwd successfully',
      );
      assert.ok(
        commands.some(
          (item) =>
            string(item.command).includes('git branch') && item.exitCode === 0,
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
      execution = { commands, replies };
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
main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
