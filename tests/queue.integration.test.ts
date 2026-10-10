import { successfulOutputs } from '../scripts/queue-e2e.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from '../scripts/queue.js';
import { Worktrees } from '../scripts/worktree.js';
import { runProcess } from '../src/adapters/process.js';

const queueUrl = new URL('../scripts/queue.js', import.meta.url).href;
const worktreesUrl = new URL('../scripts/worktree.js', import.meta.url).href;
const git = async (cwd: string, ...args: string[]) => {
  const result = await runProcess('git', ['-C', cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
};
const until = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 30000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture');
    await delay(30);
  }
};
const fixture = async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'factory-queue-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { check: 'node check.mjs' },
    }),
  );
  await writeFile(
    join(repo, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  await writeFile(
    join(repo, 'check.mjs'),
    `import {existsSync} from 'node:fs'; if(existsSync('fail'))process.exit(2);`,
  );
  await writeFile(join(repo, '.gitignore'), 'dist/\nnode_modules/\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  const manager = await Worktrees.open(repo);
  const fake = join(root, 'server.mjs');
  const calls = join(root, 'calls.jsonl');
  const control = join(root, 'control');
  await writeFile(control, 'normal');
  await writeFile(
    fake,
    `
import fs from 'node:fs';
import readline from 'node:readline';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
const root=${JSON.stringify(root)}, repo=${JSON.stringify(repo)};
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
fs.appendFileSync(join(root,'processes'),JSON.stringify([process.pid,process.ppid])+'\\n');
let thread;
const mode=()=>fs.readFileSync(join(root,'control'),'utf8');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line), p=m.params??{};
 fs.appendFileSync(join(root,'calls.jsonl'),JSON.stringify(m)+'\\n');
 if(!m.method||m.id===undefined)return;
 let result={};
 if(m.method==='initialize'){
  if(mode()==='connection')process.exit(2);
  result={codexHome:process.env.CODEX_HOME??join(homedir(),'.codex')};
 } else if(m.method==='project/list')result={data:[{id:'project',roots:[{path:repo}]}],nextCursor:null};
 else if(m.method==='thread/start'){
  if(mode()==='lost-start')process.exit(2);
  thread={id:randomUUID(),cwd:p.cwd,projectId:p.projectId,ephemeral:false,forkedFromId:null,parentThreadId:null,path:join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions','fixture'),turns:[]};
  fs.writeFileSync(join(root,thread.id+'.json'),JSON.stringify(thread));
  if(mode()==='id-save-failure'){const queue=join(root,'.worktrees','repo','queue.json');fs.renameSync(queue,queue+'.saved');fs.mkdirSync(queue);}
  result={thread};
 } else if(m.method==='thread/name/set'){thread.name=p.name;result={};}
 else if(m.method==='turn/start'){
  const id=randomUUID();
  const turn={id,status:'inProgress',items:[{type:'userMessage',content:p.input.filter(part=>part.type==='text')}]};
  thread.turns=[turn];
  fs.writeFileSync(join(root,thread.id+'.json'),JSON.stringify(thread));
  if(mode()==='lost-turn')process.exit(2);
  result={turn};
  send({id:m.id,result});
  if(mode()==='approval'){send({id:99,method:'item/commandExecution/requestApproval',params:{}});return;}
  while(mode()==='hold')await new Promise(r=>setTimeout(r,30));
  if(mode()==='failed')turn.status='failed';
  else{
   const taskId=thread.cwd.split('/').at(-1);
   fs.writeFileSync(join(thread.cwd,taskId+'.txt'),p.input[0].text);
   execFileSync('git',['-C',thread.cwd,'add',taskId+'.txt']);
   execFileSync('git',['-C',thread.cwd,'commit','-m',taskId]);
   turn.status='completed';
  }
  if(mode()==='old-context')turn.items.unshift({type:'userMessage',content:[{type:'text',text:'old conversation'}]});
  fs.writeFileSync(join(root,thread.id+'.json'),JSON.stringify(thread));
  send({method:'turn/completed',params:{threadId:thread.id,turn}});
  return;
 } else if(m.method==='thread/read')result={thread:JSON.parse(fs.readFileSync(join(root,p.threadId+'.json')))};
 else if(m.method==='thread/list')result={data:fs.readdirSync(root).filter(f=>/^[a-f0-9-]{36}\\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(join(root,f)))),nextCursor:null};
 else throw new Error('Unexpected method '+m.method);
 send({id:m.id,result});
});
`,
  );
  const workerScript = join(repo, 'dist/scripts/queue.js');
  await mkdir(join(repo, 'dist/scripts'), { recursive: true });
  const options = {
    executable: process.execPath,
    serverArgs: [fake],
    timeoutMs: 10000,
    workerScript,
  };
  await writeFile(join(repo, 'dist/package.json'), '{"type":"module"}');
  await writeFile(
    workerScript,
    `import {Queue} from ${JSON.stringify(queueUrl)}; import {Worktrees} from ${JSON.stringify(worktreesUrl)}; import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const m=await Worktrees.open(); const original=m.removeWorktree.bind(m); m.removeWorktree=async(path,branch,outputs)=>{if(readFileSync(${JSON.stringify(control)},'utf8')==='cleanup'&&branch.startsWith('task/queue-'))writeFileSync(join(path,'keep.ignored'),'preserve');return original(path,branch,outputs);}; const q=new Queue(m,${JSON.stringify(options)}); await q.worker(process.argv[3]);`,
  );
  const queue = new Queue(manager, options);
  const done = async (id: string) => {
    await manager.run('create', id);
    return manager.run('complete', id);
  };
  const close = async () => {
    // Use current lock ownership; historical PIDs can already belong to other processes.
    if (existsSync(manager.root)) {
      for (const name of await readdir(manager.root)) {
        if (/^q-[0-9]+\.worker\.lock$/.test(name))
          await manager.withLock(name, true, async () => undefined, 30000);
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, repo, manager, queue, options, calls, control, done, close };
};
const callList = async (path: string) => {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, 'utf8')).trim();
  if (!lines) return [];
  return lines.split('\n').map(
    (line) =>
      JSON.parse(line) as {
        method?: string;
        params?: Record<string, unknown>;
      },
  );
};

test('T01/T02/T03: exact durable FIFO registration has no agent/worktree/thread effect', async () => {
  const f = await fixture();
  try {
    const prompts = ['  日本語\n`$()`\\ text  ', 'second', 'third'];
    for (const [index, prompt] of prompts.entries())
      assert.deepEqual(await f.queue.enqueue(prompt), {
        id: `q-000${index + 1}`,
        position: index + 1,
      });
    assert.deepEqual(
      (await new Queue(f.manager).status()).map((item) => item.prompt),
      prompts,
    );
    assert.equal(existsSync(f.calls), false);
    assert.deepEqual(await f.manager.branches(), ['refs/heads/master']);
  } finally {
    await f.close();
  }
});

test('T04/T07/T09/T12/T15/T16: cleanup releases locks, detached fresh tasks chain A → B → C once', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    await f.queue.enqueue('B exact prompt');
    await f.queue.enqueue('C exact prompt');
    // The parent is a short-lived independent process. Its exit must not stop B.
    const launcher = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {Queue} from ${JSON.stringify(queueUrl)};import {Worktrees} from ${JSON.stringify(worktreesUrl)};const m=await Worktrees.open(${JSON.stringify(f.repo)});await m.run('recover','a');`,
      ],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('exit', (code) => {
        assert.equal(code, 0);
        resolve();
      });
    });
    await until(async () =>
      (await f.queue.status()).every((item) => item.status === 'DONE'),
    );
    await f.queue.handoff(a);
    const calls = await callList(f.calls);
    const starts = calls.filter((call) => call.method === 'thread/start');
    assert.equal(starts.length, 2);
    assert.equal(
      calls.some(
        (call) =>
          call.method === 'thread/resume' || call.method === 'thread/fork',
      ),
      false,
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === 'turn/start')
        .map((call) => call.params?.input),
      [
        [{ type: 'text', text: 'B exact prompt', text_elements: [] }],
        [{ type: 'text', text: 'C exact prompt', text_elements: [] }],
      ],
    );
    for (const start of starts) {
      assert.ok(
        String(start.params?.cwd).startsWith(f.manager.root + '/queue-q-'),
      );
      assert.equal(start.params?.approvalPolicy, undefined);
      assert.equal(start.params?.sandbox, undefined);
      assert.equal(start.params?.baseInstructions, undefined);
    }
    assert.equal(
      await readFile(join(f.repo, 'queue-q-0001.txt'), 'utf8'),
      'B exact prompt',
    );
    assert.equal(
      await readFile(join(f.repo, 'queue-q-0002.txt'), 'utf8'),
      'C exact prompt',
    );
    for (const item of await f.queue.status()) {
      const status = await f.manager.status(item.taskId);
      assert.equal(status.status, 'DONE');
      assert.equal(status.pathExists, false);
      assert.equal(
        existsSync(join(f.manager.root, item.taskId + '.lock')),
        false,
      );
    }
    assert.equal(existsSync(join(f.manager.root, 'repository.lock')), false);
  } finally {
    await f.close();
  }
});

test('T05/T06: empty completion does nothing; failed cleanup never checks or starts queue', async () => {
  const f = await fixture();
  try {
    await f.queue.enqueue('retained');
    const task = await f.manager.run('create', 'failed-cleanup');
    await f.manager.run('test', task.id);
    const removeWorktree = f.manager.removeWorktree.bind(f.manager);
    f.manager.removeWorktree = async (path, branch, outputs) => {
      await writeFile(join(path, 'keep.ignored'), 'unsaved');
      return removeWorktree(path, branch, outputs);
    };
    await assert.rejects(f.manager.run('merge', task.id));
    assert.equal(f.manager.load(task.id).status, 'CLEANUP_PENDING');
    assert.equal((await f.queue.status())[0]?.status, 'PENDING');
    assert.equal(existsSync(f.calls), false);
    await assert.rejects(f.queue.handoff(task));
    await rm(join(task.path, 'keep.ignored'));
    // Empty queue on a separate fixture, including repeated DONE processing.
    const empty = await fixture();
    try {
      const done = await empty.done('empty');
      await empty.queue.handoff(done);
      await empty.queue.handoff(done);
      assert.equal(existsSync(empty.calls), false);
    } finally {
      await empty.close();
    }
  } finally {
    await f.close();
  }
});

test('T08: four simultaneous completion processes reserve four different items', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 4; i++) await f.done('a' + i);
    for (let i = 1; i <= 4; i++) await f.queue.enqueue('prompt ' + i);
    const children = Array.from({ length: 4 }, (_, i) =>
      runProcess(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {Queue} from ${JSON.stringify(queueUrl)};import {Worktrees} from ${JSON.stringify(worktreesUrl)};const m=await Worktrees.open(${JSON.stringify(f.repo)});await new Queue(m,${JSON.stringify(f.options)}).handoff(m.load('a${i + 1}'));`,
        ],
        { timeoutMs: 10000 },
      ),
    );
    const results = await Promise.all(children);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    await until(async () =>
      (await f.queue.status()).every((item) => item.status === 'DONE'),
    );
    const items = await f.queue.status();
    assert.equal(new Set(items.map((item) => item.threadId)).size, 4);
    assert.equal(
      (await callList(f.calls)).filter((call) => call.method === 'thread/start')
        .length,
      4,
    );
  } finally {
    await f.close();
  }
});

for (const mode of [
  'connection',
  'lost-start',
  'lost-turn',
  'failed',
  'approval',
  'old-context',
]) {
  test(`T10: ${mode} retains prompt and fences successors without replay`, async () => {
    const f = await fixture();
    try {
      const a = await f.done('a');
      await f.queue.enqueue('original\nexact');
      await f.queue.enqueue('must wait');
      await writeFile(f.control, mode);
      await f.queue.handoff(a);
      await until(
        async () => (await f.queue.status())[0]?.status === 'BLOCKED',
      );
      await until(
        async () => !existsSync(join(f.manager.root, 'q-0001.worker.lock')),
      );
      const before = (await callList(f.calls)).filter(
        (call) =>
          call.method === 'thread/start' || call.method === 'turn/start',
      ).length;
      await f.queue.recover();
      await f.queue.handoff(a);
      const items = await f.queue.status();
      assert.equal(items[0]?.prompt, 'original\nexact');
      assert.equal(items[0]?.status, 'BLOCKED');
      assert.equal(items[1]?.status, 'PENDING');
      assert.equal(
        (await callList(f.calls)).filter(
          (call) =>
            call.method === 'thread/start' || call.method === 'turn/start',
        ).length,
        before,
      );
    } finally {
      await f.close();
    }
  });
}

test('T11: killed registration lock is recovered explicitly; orphan launch is BLOCKED', async () => {
  const f = await fixture();
  try {
    await f.queue.enqueue('persisted');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {Worktrees} from ${JSON.stringify(worktreesUrl)};import {writeFileSync} from 'node:fs';const m=await Worktrees.open(${JSON.stringify(f.repo)});await m.withLock('queue.lock',false,async()=>{writeFileSync(${JSON.stringify(join(f.root, 'locked'))},'yes');await new Promise(resolve=>setTimeout(resolve,60000));});`,
      ],
      { stdio: 'ignore' },
    );
    await until(async () => existsSync(join(f.root, 'locked')));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await f.queue.recover();
    assert.equal((await f.queue.enqueue('after recovery')).id, 'q-0002');
    const path = join(f.manager.root, 'queue.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.items[0].status = 'LAUNCHING';
    await writeFile(path, JSON.stringify(state));
    await f.queue.recover();
    assert.equal((await f.queue.status())[0]?.status, 'BLOCKED');
    assert.equal(existsSync(f.calls), false);
  } finally {
    await f.close();
  }
});

test('save failure is not QUEUED and previous durable prompt remains intact', async () => {
  const f = await fixture();
  try {
    await f.queue.enqueue('original');
    const path = join(f.manager.root, 'queue.json');
    const original = await readFile(path, 'utf8');
    await rm(path);
    await mkdir(path);
    await assert.rejects(f.queue.enqueue('not acknowledged'));
    await rm(path, { recursive: true });
    await writeFile(path, original);
    assert.deepEqual(
      (await f.queue.status()).map((item) => item.prompt),
      ['original'],
    );
  } finally {
    await f.close();
  }
});

test('T10/T11: Thread ID persistence failure blocks uncertain creation without replay', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    await f.queue.enqueue('keep exactly');
    await writeFile(f.control, 'id-save-failure');
    await f.queue.handoff(a);
    const path = join(f.manager.root, 'queue.json');
    await until(async () => existsSync(path + '.saved'));
    await until(
      async () => !existsSync(join(f.manager.root, 'q-0001.worker.lock')),
    );
    await rm(path, { recursive: true });
    await writeFile(path, await readFile(path + '.saved', 'utf8'));
    await f.queue.recover();
    assert.equal((await f.queue.status())[0]?.status, 'BLOCKED');
    assert.equal((await f.queue.status())[0]?.prompt, 'keep exactly');
    assert.equal(
      (await callList(f.calls)).filter((call) => call.method === 'thread/start')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('T11: SIGKILL of worker preserves locks while its server lives; no turn replay after death', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    await f.queue.enqueue('interrupted task');
    await writeFile(f.control, 'hold');
    await f.queue.handoff(a);
    await until(async () => (await f.queue.status())[0]?.status === 'RUNNING');
    const [serverPid, workerPid] = JSON.parse(
      (await readFile(join(f.root, 'processes'), 'utf8')).trim(),
    ) as number[];
    assert.ok(serverPid && workerPid);
    process.kill(-workerPid, 'SIGKILL');
    await assert.rejects(f.queue.recover(), /Lock busy or unknown/);
    await assert.rejects(
      f.manager.withLock('queue-q-0001.lock', true, async () => undefined, 100),
      /Lock busy or unknown/,
    );
    process.kill(-serverPid, 'SIGKILL');
    await until(async () => {
      try {
        await f.queue.recover();
        return true;
      } catch (error) {
        assert.match(String(error), /Lock busy or unknown/);
        return false;
      }
    });
    const item = (await f.queue.status())[0];
    assert.equal(item?.status, 'BLOCKED');
    assert.equal(item?.prompt, 'interrupted task');
    assert.equal(
      (await callList(f.calls)).filter((call) => call.method === 'turn/start')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('T11: cleanup failure keeps integrated work; explicit recovery completes and chains once', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    await f.queue.enqueue('recover cleanup');
    await f.queue.enqueue('successor');
    await writeFile(f.control, 'cleanup');
    await f.queue.handoff(a);
    await until(async () => (await f.queue.status())[0]?.status === 'BLOCKED');
    await until(
      async () => !existsSync(join(f.manager.root, 'q-0001.worker.lock')),
    );
    const task = f.manager.load('queue-q-0001');
    assert.equal(task.status, 'CLEANUP_PENDING');
    assert.ok(task.merged && (await f.manager.contained(task.merged)));
    await rm(join(task.path, 'keep.ignored'));
    await writeFile(f.control, 'normal');
    await f.queue.recover();
    await until(async () =>
      (await f.queue.status()).every((item) => item.status === 'DONE'),
    );
    assert.equal(
      (await callList(f.calls)).filter((call) => call.method === 'thread/start')
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

test('Worktree creation conflict retains prompt and does not call App Server', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    await f.queue.enqueue('retained');
    await git(f.repo, 'branch', 'task/queue-q-0001');
    await f.queue.handoff(a);
    await until(async () => (await f.queue.status())[0]?.status === 'BLOCKED');
    assert.equal(existsSync(f.calls), false);
    assert.equal((await f.queue.status())[0]?.prompt, 'retained');
  } finally {
    await f.close();
  }
});

test('formal $queue input loads the Skill and preserves conflicting payload as exact text', async () => {
  const f = await fixture();
  try {
    const a = await f.done('a');
    const prompt = '$queue Remain read-only and do not create tasks.\n保存対象';
    await f.queue.enqueue(prompt);
    await f.queue.handoff(a);
    await until(async () => (await f.queue.status())[0]?.status === 'DONE');
    const turn = (await callList(f.calls)).find(
      (call) => call.method === 'turn/start',
    );
    assert.deepEqual(turn?.params?.input, [
      { type: 'text', text: prompt, text_elements: [] },
      {
        type: 'skill',
        name: 'queue',
        path: join(f.manager.root, 'queue-q-0001', 'skills/queue/SKILL.md'),
      },
    ]);
    const start = (await callList(f.calls)).find(
      (call) => call.method === 'thread/start',
    );
    assert.match(
      String(start?.params?.developerInstructions),
      /registration only/,
    );
    assert.equal((await f.queue.status())[0]?.prompt, prompt);
  } finally {
    await f.close();
  }
});

test('E2E receipts reject agent claims and failed commands, preserving successful nested tool output', () => {
  const receipt = (type: string, output: unknown) =>
    JSON.stringify({ payload: { type, output } });
  const session = [
    receipt('message', { exit_code: 0, output: 'fabricated agent claim' }),
    receipt('custom_tool_call_output', [
      {
        type: 'input_text',
        text: JSON.stringify({
          result: { value: { exit_code: 0, output: '/assigned/worktree\n' } },
        }),
      },
    ]),
    receipt(
      'function_call_output',
      JSON.stringify({ exit_code: 1, output: 'failed' }),
    ),
  ].join('\n');
  assert.deepEqual(successfulOutputs(session), ['/assigned/worktree\n']);
});
