import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServer, array, object, string } from './codex-app-probe.js';
import { Worktrees } from './worktree.js';
import type { Task } from './worktree.js';

type Status =
  'PENDING' | 'RESERVED' | 'LAUNCHING' | 'RUNNING' | 'DONE' | 'BLOCKED';
export type QueueItem = {
  id: string;
  prompt: string;
  status: Status;
  taskId: string;
  event?: string;
  threadId?: string;
  turnId?: string;
  turnIntent?: boolean;
  turnCompleted?: boolean;
  projectId?: string;
  sessionPath?: string;
  listed?: boolean;
  gui: 'UNVERIFIED';
  reason?: string;
};
type State = {
  version: 1;
  common: string;
  sequence: number;
  items: QueueItem[];
  events: Record<string, string | null>;
};
type Options = {
  executable?: string;
  serverArgs?: string[];
  timeoutMs?: number;
  workerScript?: string;
};

export class Queue {
  constructor(
    readonly worktrees: Worktrees,
    private options: Options = {},
  ) {}
  private get path() {
    return join(this.worktrees.root, 'queue.json');
  }
  private load(): State {
    if (!existsSync(this.path))
      return {
        version: 1,
        common: this.worktrees.common,
        sequence: 0,
        items: [],
        events: {},
      };
    const stat = lstatSync(this.path);
    assert.ok(
      stat.isFile() && stat.size <= 64 * 1024 * 1024,
      'Invalid queue file',
    );
    const value = object(JSON.parse(readFileSync(this.path, 'utf8')));
    assert.equal(value.version, 1);
    assert.equal(
      value.common,
      this.worktrees.common,
      'Queue repository mismatch',
    );
    assert.ok(
      Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0,
    );
    const ids = new Set<string>();
    for (const entry of array(value.items)) {
      const item = object(entry);
      const id = string(item.id);
      assert.match(id, /^q-[0-9]{4,}$/);
      assert.ok(!ids.has(id), 'Duplicate queue ID');
      ids.add(id);
      assert.equal(item.taskId, `queue-${id}`);
      assert.ok(Number(id.slice(2)) <= Number(value.sequence));
      assert.ok(string(item.prompt).trim().length > 0);
      assert.ok(
        [
          'PENDING',
          'RESERVED',
          'LAUNCHING',
          'RUNNING',
          'DONE',
          'BLOCKED',
        ].includes(string(item.status)),
      );
      assert.equal(item.gui, 'UNVERIFIED');
      for (const key of [
        'event',
        'threadId',
        'turnId',
        'projectId',
        'sessionPath',
        'reason',
      ]) {
        if (item[key] !== undefined) string(item[key]);
      }
      for (const key of ['turnIntent', 'turnCompleted', 'listed']) {
        if (item[key] !== undefined) assert.equal(typeof item[key], 'boolean');
      }
    }
    for (const id of Object.values(object(value.events))) {
      assert.ok(
        id === null || (typeof id === 'string' && ids.has(id)),
        'Invalid event reservation',
      );
    }
    // All persisted fields used below were validated at this boundary.
    return value as State;
  }
  private save(state: State) {
    const temporary = `${this.path}.${randomUUID()}`;
    const data = `${JSON.stringify(state, null, 2)}\n`;
    assert.ok(
      Buffer.byteLength(data) <= 64 * 1024 * 1024,
      'Queue storage exceeds 64 MiB; nothing changed',
    );
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    const directory = openSync(this.worktrees.root, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private async update<T>(
    action: (state: State) => T,
    recover = false,
  ): Promise<T> {
    this.worktrees.initialize();
    return this.worktrees.withLock('queue.lock', recover, async () => {
      const state = this.load();
      const result = action(state);
      this.save(state);
      return result;
    });
  }
  async enqueue(prompt: string): Promise<{ id: string; position: number }> {
    assert.ok(prompt.trim().length > 0, 'Prompt is empty');
    assert.ok(
      Buffer.byteLength(prompt) <= 1024 * 1024,
      'Prompt exceeds 1 MiB; nothing queued',
    );
    return this.update((state) => {
      assert.ok(state.sequence < Number.MAX_SAFE_INTEGER);
      const id = `q-${String(++state.sequence).padStart(4, '0')}`;
      state.items.push({
        id,
        prompt,
        status: 'PENDING',
        taskId: `queue-${id}`,
        gui: 'UNVERIFIED',
      });
      return {
        id,
        position: state.items.filter((item) => item.status !== 'DONE').length,
      };
    });
  }
  async status(): Promise<QueueItem[]> {
    this.worktrees.initialize();
    return this.worktrees.withLock(
      'queue.lock',
      false,
      async () => this.load().items,
    );
  }
  private async patch(id: string, patch: Partial<QueueItem>) {
    return this.update((state) => {
      const item = state.items.find((item) => item.id === id);
      assert.ok(item, 'Queue item missing');
      Object.assign(item, patch);
      return item;
    });
  }
  private async block(id: string, error: unknown) {
    const item = (await this.status()).find((entry) => entry.id === id);
    if (item?.status !== 'DONE')
      await this.patch(id, { status: 'BLOCKED', reason: String(error) });
  }
  async handoff(task: Task): Promise<QueueItem | undefined> {
    assert.equal(task.status, 'DONE');
    assert.deepEqual(
      this.worktrees.load(task.id),
      task,
      'DONE event differs from persisted ownership record',
    );
    await this.worktrees.absent(task.path, task.branch);
    assert.ok(!task.candidate, 'Candidate still recorded');
    assert.ok(
      task.tested &&
        task.merged &&
        (await this.worktrees.contained(task.tested)) &&
        (await this.worktrees.contained(task.merged)),
      'DONE lacks verified integration',
    );
    const event = `${task.id}:${task.tested}:${task.merged}`;
    const reserved = await this.update((state) => {
      if (Object.hasOwn(state.events, event)) return;
      const previous = state.items.find((item) => item.taskId === task.id);
      if (previous) {
        assert.ok(
          previous.status === 'RUNNING' && previous.turnCompleted,
          'Queue predecessor has no successful turn',
        );
        previous.status = 'DONE';
      }
      state.events[event] = null;
      // A failed item fences later FIFO entries, including unrelated completion events.
      const next = state.items.find(
        (item) => item.status === 'PENDING' || item.status === 'BLOCKED',
      );
      if (!next || next.status === 'BLOCKED') return;
      next.status = 'RESERVED';
      next.event = event;
      state.events[event] = next.id;
      return next;
    });
    if (reserved) await this.dispatch(reserved.id);
    return reserved;
  }
  private async dispatch(id: string) {
    const script =
      this.options.workerScript ??
      join(this.worktrees.repository, 'dist/scripts/queue.js');
    assert.ok(
      existsSync(script),
      'Queue Worker is not built in the primary checkout; recover after building',
    );
    const log = openSync(
      join(this.worktrees.root, `${id}.worker.log`),
      'a',
      0o600,
    );
    try {
      const child = spawn(process.execPath, [script, 'worker', id], {
        cwd: this.worktrees.repository,
        env: process.env,
        detached: true,
        stdio: ['ignore', log, log],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } catch (error) {
      await this.patch(id, {
        status: 'BLOCKED',
        reason: `Worker launch failed: ${String(error)}`,
      });
      throw error;
    } finally {
      closeSync(log);
    }
  }
  private async server(register?: (pid: number) => void) {
    const server = new AppServer(
      this.options.executable ?? 'codex',
      this.options.serverArgs ?? ['app-server', '--listen', 'stdio://'],
      this.worktrees.repository,
      this.options.timeoutMs ?? 24 * 60 * 60 * 1000,
      'Queue requires operator approval; no automatic approval is granted',
    );
    try {
      if (server.pid) register?.(-server.pid);
      const initialized = object(
        await server.request('initialize', {
          clientInfo: {
            name: 'software_factory_queue',
            title: 'Software Factory Queue',
            version: '0.1.0',
          },
          capabilities: { experimentalApi: true },
        }),
      );
      assert.equal(
        resolve(string(initialized.codexHome)),
        resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
        'App Server profile mismatch',
      );
      server.initialized();
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }
  private async project(server: AppServer): Promise<string> {
    const matches: string[] = [];
    let cursor: unknown = null;
    do {
      const result = object(
        await server.request('project/list', { limit: 100, cursor }),
      );
      for (const entry of array(result.data)) {
        const project = object(entry);
        if (
          array(project.roots).some(
            (root) => object(root).path === this.worktrees.repository,
          )
        )
          matches.push(string(project.id));
      }
      cursor = result.nextCursor;
      assert.ok(cursor === null || typeof cursor === 'string');
    } while (cursor !== null);
    assert.equal(matches.length, 1, 'Require one registered primary project');
    return string(matches[0]);
  }
  private async verify(server: AppServer, item: QueueItem, cwd: string) {
    assert.ok(item.threadId && item.turnId && item.projectId);
    const thread = object(
      object(
        await server.request('thread/read', {
          threadId: item.threadId,
          includeTurns: true,
        }),
      ).thread,
    );
    assert.equal(thread.id, item.threadId);
    assert.equal(thread.cwd, cwd);
    assert.equal(thread.projectId, item.projectId);
    assert.equal(thread.ephemeral, false);
    assert.equal(thread.forkedFromId, null);
    assert.equal(thread.parentThreadId, null);
    const turns = array(thread.turns).map(object);
    assert.equal(
      turns.length,
      1,
      'Unexpected prior or concurrent conversation',
    );
    const turn = object(turns[0]);
    assert.equal(turn.id, item.turnId);
    assert.equal(
      turn.status,
      'completed',
      'Task turn failed, interrupted or still running',
    );
    const users = array(turn.items)
      .map(object)
      .filter((entry) => entry.type === 'userMessage');
    assert.equal(users.length, 1);
    const input = object(users[0]);
    assert.deepEqual(
      array(input.content).map((part) => string(object(part).text)),
      [item.prompt],
      'Prompt changed or old context inherited',
    );
    return thread;
  }
  async worker(id: string): Promise<void> {
    this.worktrees.validateId(id);
    this.worktrees.initialize();
    await this.worktrees.withLock(
      `${id}.worker.lock`,
      false,
      async (workerLock) => {
        let item = (await this.status()).find((item) => item.id === id);
        assert.ok(item, 'Queue item missing');
        if (item.status !== 'RESERVED') return;
        let server: AppServer | undefined;
        try {
          const task = await this.worktrees.run('create', item.taskId);
          await this.worktrees.withLock(
            `${task.id}.lock`,
            false,
            async (taskLock) => {
              try {
                await this.worktrees.owns(task.path, task.branch);
                server = await this.server((pid) => {
                  workerLock.child(pid);
                  taskLock.child(pid);
                });
                const projectId = await this.project(server);
                item = await this.patch(id, { status: 'LAUNCHING', projectId });
                const result = object(
                  await server.request('thread/start', {
                    cwd: task.path,
                    projectId,
                    ephemeral: false,
                    historyMode: 'legacy',
                    developerInstructions: `This is a Software Factory queued task. Your assigned Worktree is ${task.path}, task ID ${task.id}, branch ${task.branch}. Read AGENTS.md and skills/worktree/SKILL.md. A dedicated Queue Worker already created this Worktree and holds its usage lock for your entire turn. Develop and commit only here. Do not create another Worktree, acquire exec, or run test/merge/complete/cleanup/recover yourself. The Worker will release the usage lock after your successful turn, then run the existing complete lifecycle (checks, local master integration, Cleanup and Queue Handoff). Preserve unrelated work. Do not push. If blocked or unable to finish, report it and leave changes uncommitted so independent completion fails.`,
                  }),
                );
                const thread = object(result.thread);
                const threadId = string(thread.id);
                // Persist identity before validation/name/turn requests; a lost response never replays start.
                item = await this.patch(id, {
                  threadId,
                  sessionPath: string(thread.path),
                });
                assert.equal(thread.cwd, task.path);
                assert.equal(thread.projectId, projectId);
                assert.equal(thread.ephemeral, false);
                assert.equal(thread.forkedFromId, null);
                assert.equal(thread.parentThreadId, null);
                const codexHome = resolve(
                  process.env.CODEX_HOME ?? join(homedir(), '.codex'),
                );
                assert.ok(
                  resolve(string(thread.path)).startsWith(
                    `${codexHome}/sessions/`,
                  ),
                );
                await server.request('thread/name/set', {
                  threadId,
                  name: `Queue ${id}`,
                });
                await this.patch(id, { turnIntent: true });
                const started = object(
                  await server.request('turn/start', {
                    threadId,
                    input: [
                      { type: 'text', text: item.prompt, text_elements: [] },
                    ],
                  }),
                );
                item = await this.patch(id, {
                  status: 'RUNNING',
                  turnId: string(object(started.turn).id),
                });
                const completed = await server.turn(threadId);
                assert.equal(completed.id, item.turnId);
                assert.equal(
                  completed.status,
                  'completed',
                  'Task turn did not complete successfully',
                );
                await this.verify(server, item, task.path);
                const listed = object(
                  await server.request('thread/list', {
                    projectId,
                    limit: 100,
                    useStateDbOnly: true,
                  }),
                );
                assert.ok(
                  array(listed.data).some(
                    (entry) => object(entry).id === threadId,
                  ),
                  'Task absent from project list; GUI remains unverified',
                );
                await this.patch(id, { turnCompleted: true, listed: true });
              } finally {
                await server?.close();
                server = undefined;
              }
            },
          );
          await this.worktrees.run('complete', item.taskId);
        } catch (error) {
          await this.block(id, error);
          throw error;
        } finally {
          await server?.close();
        }
      },
    );
  }
  async recover(): Promise<QueueItem[]> {
    // Explicit recovery alone may reclaim confirmed-dead same-host lock owners.
    await this.update(() => undefined, true);
    for (const current of await this.status()) {
      if (current.status === 'PENDING' || current.status === 'DONE') continue;
      await this.worktrees.withLock(
        `${current.id}.worker.lock`,
        true,
        async (workerLock) => {
          if (current.status === 'RESERVED') {
            await this.worktrees
              .run('recover', current.taskId)
              .catch((error: unknown) => {
                if (!existsSync(this.worktrees.statePath(current.taskId)))
                  return;
                throw error;
              });
            await this.dispatch(current.id);
            return;
          }
          let server: AppServer | undefined;
          try {
            assert.ok(
              current.threadId && current.turnId,
              'Launch outcome uncertain; never replay thread/start or turn/start',
            );
            server = await this.server((pid) => workerLock.child(pid));
            const task = this.worktrees.load(current.taskId);
            await this.verify(server, current, task.path);
            await this.patch(current.id, {
              status: 'RUNNING',
              turnCompleted: true,
            });
            await server.close();
            server = undefined;
            await this.worktrees.run('recover', task.id);
            if (this.worktrees.load(task.id).status !== 'DONE')
              await this.worktrees.run('complete', task.id);
          } catch (error) {
            await this.block(current.id, error);
          } finally {
            await server?.close();
          }
        },
        100,
      );
    }
    return this.status();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const main = async () => {
    const [operation, id] = process.argv.slice(2);
    const queue = new Queue(await Worktrees.open());
    if (operation === 'enqueue') {
      assert.equal(id, undefined, 'Usage: queue enqueue < prompt on stdin');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk);
        assert.ok(bytes <= 1024 * 1024, 'Prompt exceeds 1 MiB');
        chunks.push(Buffer.from(chunk));
      }
      const result = await queue.enqueue(
        Buffer.concat(chunks).toString('utf8'),
      );
      console.log(`QUEUED\nID: ${result.id}\nPosition: ${result.position}`);
    } else if (operation === 'status')
      console.log(JSON.stringify(await queue.status(), null, 2));
    else if (operation === 'recover')
      console.log(JSON.stringify(await queue.recover(), null, 2));
    else if (operation === 'worker' && id) await queue.worker(id);
    else
      throw new Error(
        'Usage: queue <enqueue|status|recover>; worker is internal',
      );
  };
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
