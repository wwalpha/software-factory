import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../src/adapters/process.js';

export const PROBE_NAME = 'Queue GUI Probe';
export const PROBE_REPLY = 'QUEUE_GUI_PROBE_APP_SERVER_OK';
export const PROBE_PROMPT = `This is a read-only connectivity probe. Do not use any tools, read files, modify source code, settings, sessions, or credentials, or create other tasks. Reply with exactly: ${PROBE_REPLY}`;

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected an object',
  );
  // The object check establishes the JSON record boundary; values remain unknown.
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  assert.ok(typeof value === 'string', 'Expected a string');
  return value;
};
const array = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value), 'Expected an array');
  return value;
};

// runProcess closes stdin after one payload; App Server requires an interactive stream.
class AppServer {
  private child;
  private lines;
  private closed;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private completed = new Map<string, unknown>();
  private changed = new EventEmitter();
  private nextId = 0;
  private bytes = 0;
  private failure: Error | undefined;
  private timer;

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) {
    this.child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: 'pipe',
      detached: true,
    });
    this.closed = new Promise<void>((resolve) =>
      this.child.once('close', () => resolve()),
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      try {
        const message = object(JSON.parse(line));
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error)
            pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        } else if (message.id !== undefined) {
          // Reject tool/approval requests; the probe has no tool authority.
          this.send({
            id: message.id,
            error: { code: -32601, message: 'Probe refuses server requests' },
          });
          this.fail(
            new Error(`Unexpected server request: ${String(message.method)}`),
          );
        } else if (message.method === 'turn/completed') {
          const params = object(message.params);
          this.completed.set(string(params.threadId), params.turn);
          this.changed.emit('change');
        }
      } catch (error) {
        this.fail(new Error('Invalid App Server message', { cause: error }));
      }
    });
    const count = (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > 8 * 1024 * 1024)
        this.fail(new Error('App Server output exceeded 8 MiB'));
    };
    this.child.stdout.on('data', count);
    this.child.stderr.on('data', count); // Drain without logging profile data or credentials.
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', () => this.fail(new Error('App Server closed')));
    this.timer = setTimeout(() => {
      this.fail(
        new Error(
          'App Server timed out; uncertain effects must not be replayed',
        ),
      );
    }, timeoutMs);
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.changed.emit('change');
  }
  private send(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  initialized() {
    this.send({ method: 'initialized' });
  }
  async turn(threadId: string): Promise<Record<string, unknown>> {
    while (!this.completed.has(threadId)) {
      if (this.failure) throw this.failure;
      await once(this.changed, 'change');
    }
    return object(this.completed.get(threadId));
  }
  private kill() {
    if (!this.child.pid) return;
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      ))
        throw error;
    }
  }
  async close() {
    clearTimeout(this.timer);
    this.lines.close();
    this.kill(); // Only this short-lived server and its children; never the desktop server.
    await this.closed;
  }
}

type ProbeOptions = {
  create: boolean;
  cwd: string;
  codexHome: string;
  journal: string;
  executable?: string;
  serverArgs?: string[];
  timeoutMs?: number;
};

const verifyThread = (
  value: unknown,
  id: string,
  cwd: string,
  projectId: string,
  codexHome: string,
) => {
  const thread = object(object(value).thread);
  assert.equal(thread.id, id);
  assert.equal(thread.cwd, cwd);
  assert.equal(thread.projectId, projectId);
  assert.equal(thread.name, PROBE_NAME);
  assert.equal(thread.ephemeral, false);
  assert.equal(thread.forkedFromId, null);
  assert.equal(thread.parentThreadId, null);
  const path = string(thread.path);
  assert.ok(
    resolve(path).startsWith(`${resolve(codexHome)}/sessions/`),
    'Unexpected session storage path',
  );
  const turns = array(thread.turns).map(object);
  assert.ok(turns.length >= 1, 'No persisted turns');
  const first = turns[0];
  assert.ok(first);
  assert.equal(first.status, 'completed');
  const items = array(first.items).map(object);
  assert.ok(
    items.every((item) =>
      ['userMessage', 'agentMessage', 'reasoning'].includes(string(item.type)),
    ),
    'Probe used tools',
  );
  const inputs = items.filter((item) => item.type === 'userMessage');
  assert.equal(inputs.length, 1, 'Unexpected prior conversation');
  const input = inputs[0];
  assert.ok(input);
  assert.deepEqual(
    array(input.content).map((part) => string(object(part).text)),
    [PROBE_PROMPT],
  );
  const replies = items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => string(item.text));
  assert.deepEqual(replies, [PROBE_REPLY]);
  return {
    threadId: id,
    cwd,
    projectId,
    path,
    name: thread.name,
    turnCount: turns.length,
    firstTurnStatus: first.status,
    reply: replies[0],
  };
};

export const runProbe = async (options: ProbeOptions) => {
  const cwd = resolve(options.cwd);
  const executable = options.executable ?? 'codex';
  let journal: number | undefined;
  let server: AppServer | undefined;
  const record = (method: string, result: unknown) => {
    if (journal === undefined) return;
    writeSync(
      journal,
      `${JSON.stringify({ at: new Date().toISOString(), method, result })}\n`,
    );
    fsyncSync(journal);
  };
  try {
    let threadId: string | undefined;
    if (options.create) {
      mkdirSync(dirname(options.journal), { recursive: true, mode: 0o700 });
      // Claim before any remote effect. A crash/timeout never authorizes a second creation.
      journal = openSync(options.journal, 'wx', 0o600);
      record('intent', {
        cwd,
        codexHome: options.codexHome,
        verdict: 'UNVERIFIED',
      });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      const version = await runProcess(executable, ['--version'], {
        env,
        timeoutMs: 10000,
      });
      assert.equal(version.code, 0, 'CLI version check failed');
      record('cli/version', version.stdout.trim());
    } else {
      const events = readFileSync(options.journal, 'utf8')
        .trim()
        .split('\n')
        .map((line) => object(JSON.parse(line)));
      const intent = object(
        events.find((event) => event.method === 'intent')?.result,
      );
      assert.equal(intent.cwd, cwd, 'Journal belongs to another repository');
      assert.equal(
        intent.codexHome,
        options.codexHome,
        'Journal belongs to another profile',
      );
      const created = object(
        events.find((event) => event.method === 'thread/start')?.result,
      );
      threadId = string(created.threadId);
    }
    server = new AppServer(
      executable,
      options.serverArgs ?? ['app-server', '--listen', 'stdio://'],
      cwd,
      options.timeoutMs ?? 180000,
    );
    const initialized = object(
      await server.request('initialize', {
        clientInfo: {
          name: 'software_factory_gui_probe',
          title: PROBE_NAME,
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      }),
    );
    assert.equal(
      resolve(string(initialized.codexHome)),
      resolve(options.codexHome),
      'App Server profile mismatch',
    );
    record('initialize', initialized);
    server.initialized();
    record('initialized', {});
    const matches: Record<string, unknown>[] = [];
    let cursor: unknown = null;
    do {
      const result = object(
        await server.request('project/list', { limit: 100, cursor }),
      );
      for (const entry of array(result.data)) {
        const project = object(entry);
        if (array(project.roots).some((root) => object(root).path === cwd))
          matches.push(project);
      }
      cursor = result.nextCursor;
      assert.ok(
        cursor === null || typeof cursor === 'string',
        'Invalid project cursor',
      );
    } while (cursor !== null);
    assert.equal(
      matches.length,
      1,
      'Require exactly one registered project for cwd',
    );
    const project = matches[0];
    assert.ok(project);
    const projectId = string(project.id);
    record('project/list', { id: projectId, name: project.name, cwd });
    if (options.create) {
      const existing = object(
        await server.request('thread/list', {
          cwd,
          searchTerm: PROBE_NAME,
          limit: 100,
          useStateDbOnly: true,
        }),
      );
      assert.equal(
        array(existing.data).length,
        0,
        'A probe already exists; do not create another',
      );
      const result = object(
        await server.request('thread/start', {
          cwd,
          projectId,
          ephemeral: false,
          historyMode: 'legacy',
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }),
      );
      const thread = object(result.thread);
      threadId = string(thread.id);
      record('thread/start', {
        threadId,
        cwd: thread.cwd,
        projectId: thread.projectId,
        path: thread.path,
        ephemeral: thread.ephemeral,
        model: result.model,
        approvalPolicy: result.approvalPolicy,
        sandbox: result.sandbox,
      });
      assert.equal(thread.cwd, cwd);
      assert.equal(thread.projectId, projectId);
      assert.equal(thread.ephemeral, false);
      assert.equal(result.approvalPolicy, 'never');
      assert.equal(object(result.sandbox).type, 'readOnly');
      record(
        'thread/name/set',
        await server.request('thread/name/set', { threadId, name: PROBE_NAME }),
      );
      const started = object(
        await server.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: PROBE_PROMPT, text_elements: [] }],
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
        }),
      );
      record('turn/start', { turnId: object(started.turn).id });
      const completed = await server.turn(threadId);
      record('turn/completed', {
        turnId: completed.id,
        status: completed.status,
        error: completed.error,
      });
      assert.equal(completed.id, object(started.turn).id);
      assert.equal(
        completed.status,
        'completed',
        'Probe turn failed or was interrupted',
      );
    }
    assert.ok(threadId);
    const listed = object(
      await server.request('thread/list', {
        cwd,
        projectId,
        searchTerm: PROBE_NAME,
        limit: 100,
        useStateDbOnly: true,
      }),
    );
    const entries = array(listed.data)
      .map(object)
      .filter((thread) => thread.id === threadId);
    assert.equal(entries.length, 1, 'Thread not saved in project listing');
    record('thread/list', { threadId, found: true, projectId });
    const result = verifyThread(
      await server.request('thread/read', { threadId, includeTurns: true }),
      threadId,
      cwd,
      projectId,
      options.codexHome,
    );
    record('thread/read', result);
    const report = {
      ...result,
      api: 'PASS',
      gui: 'UNVERIFIED',
      verdict: 'UNVERIFIED',
      journal: options.journal,
    };
    record('result', report);
    return report;
  } catch (error) {
    record('error', { message: String(error), verdict: 'FAIL' });
    throw error;
  } finally {
    try {
      await server?.close();
    } finally {
      if (journal !== undefined) closeSync(journal);
    }
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const main = async () => {
    assert.ok(
      ['--create', '--verify'].includes(args[0] ?? '') &&
        (args.length === 1 || (args.length === 3 && args[1] === '--cwd')),
      'Usage: node dist/scripts/codex-app-probe.js <--create|--verify> [--cwd /registered/repository]',
    );
    const codexHome = resolve(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    );
    assert.notEqual(
      codexHome,
      '/tmp/codex-home',
      'Do not use the Factory adapter profile',
    );
    console.log(
      JSON.stringify(
        await runProbe({
          create: args[0] === '--create',
          cwd: args[2] ?? process.cwd(),
          codexHome,
          journal: join(
            homedir(),
            '.local/state/software-factory/codex-app-probe.jsonl',
          ),
        }),
        null,
        2,
      ),
    );
  };
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ verdict: 'FAIL', error: String(error) }));
    process.exitCode = 1;
  });
}
