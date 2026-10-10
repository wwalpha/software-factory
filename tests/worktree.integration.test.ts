import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worktrees } from '../scripts/worktree.js';
import { runProcess } from '../src/adapters/process.js';

const moduleUrl = new URL('../scripts/worktree.js', import.meta.url).href;
const git = async (cwd: string, ...args: string[]) => {
  const r = await runProcess('git', ['-C', cwd, ...args]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-worktree-')),
    repo = join(root, 'software-factory');
  await mkdir(repo);
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.name', 'Worktree test');
  await git(repo, 'config', 'user.email', 'worktree@example.invalid');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      private: true,
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
    join(repo, '.gitignore'),
    'node_modules/\ndist/\n*.ignored\n',
  );
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await writeFile(
    join(repo, 'check.mjs'),
    `import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
const controlPath=${JSON.stringify(join(root, 'control.json'))};
let control={}; if(fs.existsSync(controlPath))control=JSON.parse(fs.readFileSync(controlPath));
if(branch.startsWith('integrate/')){
 fs.appendFileSync(${JSON.stringify(join(root, 'timeline'))}, 'start '+branch+'\\n');
 if(control.advance && !fs.existsSync(${JSON.stringify(join(root, 'advanced'))})){
  fs.writeFileSync(${JSON.stringify(join(root, 'advanced'))},'yes');
  execFileSync('git',['-C',${JSON.stringify(repo)},'commit','--allow-empty','-m','outside update']);
 }
 await new Promise(r=>setTimeout(r,control.delay??10));
 fs.appendFileSync(${JSON.stringify(join(root, 'timeline'))}, 'end '+branch+'\\n');
}
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/check-output','owned');
if(fs.existsSync('always-fail')||(fs.existsSync('left')&&fs.existsSync('right')))process.exit(2);
`,
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  const manager = await Worktrees.open(repo);
  return {
    root,
    repo,
    manager,
    close: () => rm(root, { recursive: true, force: true }),
  };
};
const commit = async (path: string, file: string, value = 'changed\n') => {
  await writeFile(join(path, file), value);
  await git(path, 'add', file);
  await git(path, 'commit', '-m', file);
};
const processRun = (repo: string, code: string) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {Worktrees} from ${JSON.stringify(moduleUrl)}; const m=await Worktrees.open(${JSON.stringify(repo)}); ${code}`,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (x) => {
    output += String(x);
  });
  child.stderr.on('data', (x) => {
    output += String(x);
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => accept({ code, signal, output }));
  });
  return { child, done };
};

test('T01/T02/T03/T12: four isolated tasks, parallel development, sequential complete and idempotency', async () => {
  const f = await fixture();
  try {
    const ids = ['task-001', 'task-002', 'task-003', 'task-004'];
    const tasks = await Promise.all(
      ids.map((id) => f.manager.run('create', id)),
    );
    assert.equal(new Set(tasks.map((x) => x.branch)).size, 4);
    assert.equal(new Set(tasks.map((x) => x.path)).size, 4);
    assert.equal((await f.manager.run('create', ids[0]!)).base, tasks[0]?.base);
    await Promise.all(tasks.map((t) => commit(t.path, `${t.id}.txt`)));
    for (const task of tasks) {
      assert.deepEqual(
        (await readdir(task.path)).filter((x) => x.startsWith('task-')),
        [`${task.id}.txt`],
      );
      assert.equal((await f.manager.run('complete', task.id)).status, 'DONE');
      const head = await git(f.repo, 'rev-parse', 'HEAD');
      assert.equal((await f.manager.run('complete', task.id)).status, 'DONE');
      assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
      assert.equal((await f.manager.run('create', task.id)).status, 'DONE');
      assert.equal(existsSync(task.path), false);
      assert.equal(await git(f.repo, 'branch', '--list', task.branch), '');
    }
    for (const id of ids)
      assert.equal(
        await readFile(join(f.repo, `${id}.txt`), 'utf8'),
        'changed\n',
      );
    assert.equal((await f.manager.worktrees()).length, 1);
  } finally {
    await f.close();
  }
});

test('T04: conflicting task keeps master and both task and conflict candidate', async () => {
  const f = await fixture();
  try {
    const a = await f.manager.run('create', 'a'),
      b = await f.manager.run('create', 'b');
    await commit(a.path, 'shared.txt', 'a\n');
    await commit(b.path, 'shared.txt', 'b\n');
    await f.manager.run('complete', 'a');
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      f.manager.run('complete', 'b'),
      /Conflicts: shared.txt/,
    );
    assert.equal(f.manager.load('b').status, 'WAITING_CONFLICT');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.ok(existsSync(b.path));
    const candidate = f.manager.load('b').candidate!;
    assert.equal(
      await git(candidate.path, 'diff', '--name-only', '--diff-filter=U'),
      'shared.txt',
    );
    // Resolve explicitly, then recover; a new task commit requires a new validation.
    await writeFile(join(candidate.path, 'shared.txt'), 'resolved\n');
    await git(candidate.path, 'add', 'shared.txt');
    await git(candidate.path, 'commit', '-m', 'resolve for inspection');
    await git(b.path, 'merge', candidate.branch);
    await f.manager.run('recover', 'b');
    assert.equal(f.manager.load('b').status, 'DEVELOPING');
  } finally {
    await f.close();
  }
});

test('T05: individually passing task fails only after integration; master stays intact', async () => {
  const f = await fixture();
  try {
    const a = await f.manager.run('create', 'a'),
      b = await f.manager.run('create', 'b');
    await commit(a.path, 'left');
    await commit(b.path, 'right');
    await f.manager.run('complete', 'a');
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    await f.manager.run('test', 'b');
    assert.equal(f.manager.load('b').status, 'TESTED');
    await assert.rejects(f.manager.run('merge', 'b'), /exited/);
    assert.equal(f.manager.load('b').status, 'TEST_FAILED');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.ok(existsSync(b.path));
    assert.ok(await git(f.repo, 'branch', '--list', 'task/b'));
    await f.manager.run('recover', 'b');
    assert.equal(f.manager.load('b').status, 'DEVELOPING');
  } finally {
    await f.close();
  }
});

test('T06: death immediately after ff, before state save, recovers cleanup without another merge', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'stop');
    await commit(t.path, 'stop.txt');
    await f.manager.run('test', 'stop');
    const child = processRun(
      f.repo,
      `const original=m.git.bind(m);m.git=async(args,...rest)=>{const r=await original(args,...rest);if(args[0]==='merge'&&args[1]==='--ff-only')process.kill(process.pid,'SIGKILL');return r;};await m.run('merge','stop');`,
    );
    assert.equal((await child.done).signal, 'SIGKILL');
    const head = await git(f.repo, 'rev-parse', 'HEAD');
    assert.equal(f.manager.load('stop').merged, undefined);
    assert.equal((await f.manager.run('recover', 'stop')).status, 'DONE');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(existsSync(t.path), false);
  } finally {
    await f.close();
  }
});

test('T07: dirty, untracked and ignored data refuse cleanup, then cleanup alone resumes', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'dirty');
    await commit(t.path, 'dirty.txt');
    await f.manager.run('test', 'dirty');
    const original = f.manager.cleanup.bind(f.manager);
    f.manager.cleanup = async (task) => {
      await writeFile(join(t.path, 'precious.ignored'), 'keep');
      await original(task);
    };
    await assert.rejects(f.manager.run('merge', 'dirty'), /files remain/);
    assert.equal(f.manager.load('dirty').status, 'CLEANUP_PENDING');
    assert.equal(
      await readFile(join(t.path, 'precious.ignored'), 'utf8'),
      'keep',
    );
    f.manager.cleanup = original;
    await writeFile(join(t.path, 'dirty.txt'), 'uncommitted');
    await writeFile(join(t.path, 'untracked'), 'keep');
    await assert.rejects(f.manager.run('cleanup', 'dirty'));
    await writeFile(join(t.path, 'dirty.txt'), 'changed\n');
    await rm(join(t.path, 'untracked'));
    await rm(join(t.path, 'precious.ignored'));
    assert.equal((await f.manager.run('cleanup', 'dirty')).status, 'DONE');
  } finally {
    await f.close();
  }
});

test('T08: filesystem permission failure stops without modifying permissions', async () => {
  const f = await fixture();
  try {
    f.manager.initialize();
    await chmod(join(f.manager.root, 'tasks'), 0o500);
    await assert.rejects(f.manager.run('create', 'denied'), /EACCES|EPERM/);
    assert.equal(await git(f.repo, 'branch', '--list', 'task/denied'), '');
    await chmod(join(f.manager.root, 'tasks'), 0o700);
    const t = await f.manager.run('create', 'denied');
    await commit(t.path, 'denied.txt');
    await f.manager.run('test', 'denied');
    await chmod(join(f.repo, '.git', 'refs', 'heads'), 0o500);
    await assert.rejects(
      f.manager.run('merge', 'denied'),
      /Permission denied|EACCES|EPERM/,
    );
    assert.equal(f.manager.load('denied').status, 'WAITING_PERMISSION');
  } finally {
    await chmod(join(f.repo, '.git', 'refs', 'heads'), 0o700);
    await chmod(join(f.manager.root, 'tasks'), 0o700);
    await f.close();
  }
});

test('T09: death after task worktree removal resumes branch deletion', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'partial');
    await commit(t.path, 'partial.txt');
    await f.manager.run('test', 'partial');
    const child = processRun(
      f.repo,
      `const original=m.git.bind(m);m.git=async(args,...rest)=>{const r=await original(args,...rest);if(args[0]==='worktree'&&args[1]==='remove'&&args[2]===${JSON.stringify(t.path)})process.kill(process.pid,'SIGKILL');return r;};await m.run('merge','partial');`,
    );
    assert.equal((await child.done).signal, 'SIGKILL');
    assert.equal(existsSync(t.path), false);
    assert.ok(await git(f.repo, 'branch', '--list', t.branch));
    assert.equal((await f.manager.run('recover', 'partial')).status, 'DONE');
    assert.equal(await git(f.repo, 'branch', '--list', t.branch), '');
  } finally {
    await f.close();
  }
});

test('T10: two OS processes serialize integration tests and master updates', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two']) {
      const t = await f.manager.run('create', id);
      await commit(t.path, `${id}.txt`);
      await f.manager.run('test', id);
    }
    await writeFile(
      join(f.root, 'control.json'),
      JSON.stringify({ delay: 200 }),
    );
    const results = await Promise.all(
      ['one', 'two'].map(
        (id) =>
          processRun(f.repo, `await m.run('merge',${JSON.stringify(id)});`)
            .done,
      ),
    );
    for (const result of results) assert.equal(result.code, 0, result.output);
    const lines = (await readFile(join(f.root, 'timeline'), 'utf8'))
      .trim()
      .split('\n');
    assert.deepEqual(
      lines.map((x) => x.split(' ')[0]),
      ['start', 'end', 'start', 'end'],
    );
    for (const id of ['one', 'two']) {
      assert.equal(f.manager.load(id).status, 'DONE');
      assert.ok(existsSync(join(f.repo, `${id}.txt`)));
    }
  } finally {
    await f.close();
  }
});

test('T11: master changes during candidate validation; candidate is rebuilt and retested', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'advance');
    await commit(t.path, 'advance.txt');
    await writeFile(
      join(f.root, 'control.json'),
      JSON.stringify({ advance: true }),
    );
    assert.equal((await f.manager.run('complete', 'advance')).status, 'DONE');
    const timeline = await readFile(join(f.root, 'timeline'), 'utf8');
    assert.equal(
      timeline.split('\n').filter((x) => x.startsWith('start')).length,
      2,
    );
    assert.match(await git(f.repo, 'log', '--format=%s'), /outside update/);
  } finally {
    await f.close();
  }
});

test('recovery of partial create, changed tested SHA, traversal, collision and active task lease', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.run('create', '../escape'));
    await git(f.repo, 'branch', 'task/collision');
    await assert.rejects(f.manager.run('create', 'collision'));
    const child = processRun(
      f.repo,
      `const original=m.git.bind(m);m.git=async(args,...rest)=>{const r=await original(args,...rest);if(args[0]==='worktree'&&args[1]==='add')process.kill(process.pid,'SIGKILL');return r;};await m.run('create','create-stop');`,
    );
    assert.equal((await child.done).signal, 'SIGKILL');
    assert.equal(
      (await f.manager.run('recover', 'create-stop')).status,
      'DEVELOPING',
    );
    const t = await f.manager.run('create', 'sha');
    await commit(t.path, 'sha.txt');
    await f.manager.run('test', 'sha');
    await commit(t.path, 'sha.txt', 'later\n');
    await assert.rejects(f.manager.run('merge', 'sha'), /TESTED/);
    const lock = join(f.manager.root, 'busy.lock');
    await mkdir(lock);
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: 'live',
        children: [],
      }),
    );
    await assert.rejects(
      f.manager.withLock('busy.lock', true, async () => {}, 50),
      /busy/,
    );
    assert.ok(existsSync(lock));
    // Test termination keeps the lease until the spawned process group has exited.
    const active = processRun(
      f.repo,
      `await m.run('exec','sha',[process.execPath,'-e','setTimeout(()=>{},300)']);`,
    );
    while (!existsSync(join(f.manager.root, 'sha.lock'))) await delay(10);
    await assert.rejects(
      f.manager.withLock('sha.lock', false, async () => {}, 50),
      /busy/,
    );
    assert.equal((await active.done).code, 0);
  } finally {
    await f.close();
  }
});

test('parallel OS-process create and duplicate complete requests remain idempotent', async () => {
  const f = await fixture();
  try {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const created = await Promise.all(
      ids.map(
        (id) =>
          processRun(f.repo, `await m.run('create',${JSON.stringify(id)});`)
            .done,
      ),
    );
    for (const result of created) assert.equal(result.code, 0, result.output);
    assert.equal((await f.manager.worktrees()).length, 5);
    const t = f.manager.load('p1');
    await commit(t.path, 'p1.txt');
    const completed = await Promise.all(
      [1, 2].map(
        () => processRun(f.repo, `await m.run('complete','p1');`).done,
      ),
    );
    for (const result of completed) assert.equal(result.code, 0, result.output);
    assert.equal(f.manager.load('p1').status, 'DONE');
    assert.equal(
      (await git(f.repo, 'log', '--merges', '--format=%H')).split('\n').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('interrupted integration merge before head record is reconciled without losing task changes', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'merge-stop');
    await commit(t.path, 'merge-stop.txt');
    await f.manager.run('test', t.id);
    const child = processRun(
      f.repo,
      `const original=m.git.bind(m);m.git=async(args,...rest)=>{const r=await original(args,...rest);if(args[0]==='merge'&&args[1]==='--no-ff')process.kill(process.pid,'SIGKILL');return r;};await m.run('merge','merge-stop');`,
    );
    assert.equal((await child.done).signal, 'SIGKILL');
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    assert.equal((await f.manager.run('recover', t.id)).status, 'DEVELOPING');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.ok(existsSync(t.path));
    assert.equal((await f.manager.run('complete', t.id)).status, 'DONE');
  } finally {
    await f.close();
  }
});

test('partial generated-output deletion resumes, changed outputs are preserved', async () => {
  const f = await fixture();
  try {
    const t = await f.manager.run('create', 'outputs');
    await mkdir(join(t.path, 'dist'));
    await writeFile(join(t.path, 'dist', 'first'), 'one');
    await writeFile(join(t.path, 'dist', 'second'), 'two');
    const owned = await f.manager.inventory(t.path);
    await rm(join(t.path, 'dist', 'first'));
    await writeFile(join(t.path, 'dist', 'second'), 'changed');
    await assert.rejects(f.manager.removeOutputs(t.path, owned), /changed/);
    assert.equal(
      await readFile(join(t.path, 'dist', 'second'), 'utf8'),
      'changed',
    );
    await writeFile(join(t.path, 'dist', 'second'), 'two');
    await f.manager.removeOutputs(t.path, owned);
    assert.equal(existsSync(join(t.path, 'dist')), false);
  } finally {
    await f.close();
  }
});

test('Git internal lock is retained and recovery succeeds after its owner releases it', async () => {
  const f = await fixture();
  try {
    f.manager.initialize();
    await mkdir(join(f.repo, '.git', 'refs', 'heads', 'task'));
    const lock = join(f.repo, '.git', 'refs', 'heads', 'task', 'git-lock.lock');
    await writeFile(lock, 'owned elsewhere');
    await assert.rejects(f.manager.run('create', 'git-lock'), /git-lock.lock/);
    assert.equal(await readFile(lock, 'utf8'), 'owned elsewhere');
    await rm(lock);
    assert.equal(
      (await f.manager.run('recover', 'git-lock')).status,
      'DEVELOPING',
    );
  } finally {
    await f.close();
  }
});
