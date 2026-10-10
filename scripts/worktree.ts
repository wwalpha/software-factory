import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  realpathSync,
  accessSync,
  constants,
  linkSync,
} from 'node:fs';
import { lstat, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../src/adapters/process.js';

type Owner = { pid: number; host: string; token: string; children: number[] };
type Outputs = Record<string, string>;
type Candidate = {
  path: string;
  branch: string;
  base: string;
  commit?: string;
  outputs?: Outputs;
  removing?: string;
  head?: string;
};
export type Task = {
  id: string;
  branch: string;
  path: string;
  base: string;
  status: string;
  tested?: string;
  merged?: string;
  candidate?: Candidate;
  outputs?: Outputs;
  reason?: string;
};
class Waiting extends Error {
  constructor(
    public status: string,
    message: string,
  ) {
    super(message);
  }
}
const requireSafe: (value: unknown, message: string) => asserts value = (
  value,
  message,
) => {
  if (!value) throw new Waiting('WAITING_STATE', message);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
};
const permission = (error: unknown) =>
  /EACCES|EPERM|Permission denied|Operation not permitted|Read-only file system/i.test(
    String(error),
  );

// The short gate serializes acquisition, release and dead-owner recovery of a lock.
// An interrupted/unknown gate fails closed; it is never removed automatically.
class DirectoryLock {
  readonly owner: Owner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    children: [],
  };
  constructor(readonly path: string) {}
  gate<T>(action: () => T): T {
    const gate = `${this.path}.gate`;
    mkdirSync(gate);
    try {
      return action();
    } finally {
      rmdirSync(gate);
    }
  }
  async acquire(recover = false, waitMs = 600000) {
    const until = Date.now() + waitMs;
    while (true) {
      try {
        const acquired = this.gate(() => {
          if (existsSync(this.path)) {
            if (!recover) return false;
            const owner = JSON.parse(
              readFileSync(join(this.path, 'owner.json'), 'utf8'),
            ) as Owner;
            requireSafe(
              owner.host === hostname() &&
                Number.isInteger(owner.pid) &&
                Array.isArray(owner.children),
              `Unknown lock owner: ${this.path}`,
            );
            if ([owner.pid, ...owner.children].some(alive)) return false;
            unlinkSync(join(this.path, 'owner.json'));
            rmdirSync(this.path);
          }
          mkdirSync(this.path);
          writeFileSync(
            join(this.path, 'owner.json'),
            JSON.stringify(this.owner),
            { flag: 'wx' },
          );
          return true;
        });
        if (acquired) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (Date.now() >= until)
        throw new Waiting(
          'WAITING_LOCK',
          `Lock busy or unknown; recover only after owners stop: ${this.path}`,
        );
      await delay(40);
    }
  }
  child(pid: number) {
    this.owner.children.push(pid);
    writeFileSync(join(this.path, 'owner.json'), JSON.stringify(this.owner));
  }
  async release() {
    requireSafe(
      !this.owner.children.some(alive),
      'Child process group is still using the task; lock retained',
    );
    const until = Date.now() + 10000;
    while (true) {
      try {
        this.gate(() => {
          const current = JSON.parse(
            readFileSync(join(this.path, 'owner.json'), 'utf8'),
          ) as Owner;
          requireSafe(
            current.token === this.owner.token,
            'Lock ownership changed',
          );
          unlinkSync(join(this.path, 'owner.json'));
          rmdirSync(this.path);
        });
        return;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          Date.now() >= until
        )
          throw error;
        await delay(10);
      }
    }
  }
}

export class Worktrees {
  private constructor(
    readonly repository: string,
    readonly common: string,
    readonly root: string,
  ) {}
  static async open(repository = process.cwd()) {
    const git = async (args: string[]) => {
      const result = await runProcess('git', ['-C', repository, ...args]);
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const common = realpathSync(
      await git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const listing = await git(['worktree', 'list', '--porcelain']);
    const main = listing.split('\n')[0]?.slice('worktree '.length);
    requireSafe(
      main && common === realpathSync(join(main, '.git')),
      'A non-bare primary repository is required',
    );
    const root = join(dirname(main), '.worktrees', basename(main));
    requireSafe(
      !root.startsWith(`${common}/`),
      'Control directory must be outside Git',
    );
    return new Worktrees(realpathSync(main), common, root);
  }
  async git(args: string[], cwd = this.repository, allowFailure = false) {
    const result = await runProcess('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      cwd,
      ...args,
    ]);
    if (result.code !== 0 && !allowFailure) {
      for (const relative of [
        '',
        'refs',
        'refs/heads',
        'refs/heads/integrate',
        'worktrees',
      ]) {
        const path = join(this.common, relative);
        if (existsSync(path)) accessSync(path, constants.W_OK);
      }
      throw new Error(`git ${args[0]}: ${result.stderr}`);
    }
    return result;
  }
  async sha(ref: string, cwd = this.repository) {
    return (await this.git(['rev-parse', '--verify', ref], cwd)).stdout.trim();
  }
  async branches() {
    return (
      await this.git(['for-each-ref', '--format=%(refname)', 'refs/heads'])
    ).stdout
      .trim()
      .split('\n');
  }
  async worktrees() {
    const result = await this.git(['worktree', 'list', '--porcelain', '-z']);
    return result.stdout
      .split('\0\0')
      .filter(Boolean)
      .map((block) => {
        const fields = block.split('\0');
        return {
          path: fields.find((x) => x.startsWith('worktree '))?.slice(9),
          branch: fields.find((x) => x.startsWith('branch '))?.slice(7),
        };
      });
  }
  initialize() {
    mkdirSync(this.root, { recursive: true });
    requireSafe(
      realpathSync(this.root) === this.root,
      'Symlink control directory rejected',
    );
    const identity = join(this.root, 'repository.json');
    if (!existsSync(identity)) {
      const temporary = `${identity}.${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify({ common: this.common }), {
        flag: 'wx',
      });
      try {
        linkSync(temporary, identity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        unlinkSync(temporary);
      }
    }
    requireSafe(
      JSON.parse(readFileSync(identity, 'utf8')).common === this.common,
      'Control directory belongs to another repository',
    );
    mkdirSync(join(this.root, 'tasks'), { recursive: true });
  }
  validateId(id: string) {
    requireSafe(
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
      'Task ID must be 1-64 lowercase letters, digits or hyphens',
    );
  }
  statePath(id: string) {
    this.validateId(id);
    return join(this.root, 'tasks', `${id}.json`);
  }
  load(id: string): Task {
    const task = JSON.parse(readFileSync(this.statePath(id), 'utf8')) as Task;
    requireSafe(
      task.id === id &&
        task.branch === `task/${id}` &&
        task.path === join(this.root, id) &&
        /^[a-f0-9]{40,64}$/.test(task.base),
      'Invalid task ownership record',
    );
    if (task.candidate)
      requireSafe(
        task.candidate.path ===
          join(this.root, task.candidate.branch.replace('/', '-')) &&
          new RegExp(`^integrate/${id}-[a-f0-9-]+$`).test(
            task.candidate.branch,
          ),
        'Invalid integration ownership record',
      );
    return task;
  }
  save(task: Task) {
    const target = this.statePath(task.id),
      temporary = `${target}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(temporary, target);
  }
  async withLock<T>(
    name: string,
    recover: boolean,
    action: (lock: DirectoryLock) => Promise<T>,
    waitMs = 600000,
  ) {
    const lock = new DirectoryLock(join(this.root, name));
    await lock.acquire(recover, waitMs);
    try {
      return await action(lock);
    } finally {
      await lock.release();
    }
  }
  async owns(path: string, branch: string) {
    const listing = await this.worktrees();
    requireSafe(
      listing.some(
        (x) => x.path === path && x.branch === `refs/heads/${branch}`,
      ),
      `Worktree ownership mismatch: ${path}`,
    );
    requireSafe(
      realpathSync(path) === path &&
        realpathSync(await this.shaPath(path)) === this.common,
      'Worktree identity mismatch',
    );
  }
  async shaPath(path: string) {
    return (
      await this.git(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        path,
      )
    ).stdout.trim();
  }
  async clean(path: string, ignored = false) {
    const args = ['status', '--porcelain=v1', '--untracked-files=all'];
    if (ignored) args.push('--ignored');
    requireSafe(
      !(await this.git(args, path)).stdout,
      `Uncommitted, untracked or ignored files remain: ${path}`,
    );
  }
  async master() {
    const listing = await this.worktrees();
    const matches = listing.filter((x) => x.branch === 'refs/heads/master');
    requireSafe(
      matches.length === 1 && matches[0]?.path,
      'Exactly one checked-out local master is required',
    );
    return matches[0].path;
  }
  async create(id: string) {
    return this.withLock('repository.lock', false, async () => {
      if (existsSync(this.statePath(id))) {
        const task = this.load(id);
        if (task.status === 'DONE') {
          await this.absent(task.path, task.branch);
          return task;
        }
        await this.finishCreate(task);
        return task;
      }
      const base = await this.sha('refs/heads/master');
      const task: Task = {
        id,
        branch: `task/${id}`,
        path: join(this.root, id),
        base,
        status: 'CREATING',
      };
      requireSafe(
        !(await this.branches()).includes(`refs/heads/${task.branch}`) &&
          !existsSync(task.path) &&
          !(await this.worktrees()).some((x) => x.path === task.path),
        'Task branch or path already exists',
      );
      this.save(task);
      await this.finishCreate(task);
      return task;
    });
  }
  async finishCreate(task: Task) {
    if (task.status !== 'CREATING') {
      await this.owns(task.path, task.branch);
      return;
    }
    const worktrees = await this.worktrees(),
      branches = await this.branches();
    if (!worktrees.some((x) => x.path === task.path)) {
      requireSafe(
        !existsSync(task.path),
        'Partial creation path exists; inspect it without deleting data',
      );
      if (branches.includes(`refs/heads/${task.branch}`)) {
        requireSafe(
          (await this.sha(`refs/heads/${task.branch}`)) === task.base,
          'Partial branch no longer matches recorded base',
        );
        await this.git(['worktree', 'add', task.path, task.branch]);
      } else
        await this.git([
          'worktree',
          'add',
          '-b',
          task.branch,
          task.path,
          task.base,
        ]);
    }
    await this.owns(task.path, task.branch);
    requireSafe(
      (await this.sha('HEAD', task.path)) === task.base,
      'Created worktree base differs',
    );
    task.status = 'DEVELOPING';
    this.save(task);
  }
  async command(
    command: string,
    args: string[],
    cwd: string,
    lock: DirectoryLock,
  ) {
    await new Promise<void>((accept, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['inherit', 'inherit', 'pipe'],
        env: process.env,
        detached: true,
      });
      let diagnostic = '';
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        diagnostic = (diagnostic + chunk.toString()).slice(-8192);
      });
      if (child.pid) lock.child(-child.pid);
      child.once('error', reject);
      child.once('close', (code) => {
        if (child.pid && alive(-child.pid))
          reject(
            new Waiting(
              'WAITING_LOCK',
              'Command left a live child process group; lock retained',
            ),
          );
        else if (code === 0) accept();
        else {
          let status = 'TEST_FAILED';
          if (permission(diagnostic)) status = 'WAITING_PERMISSION';
          reject(
            new Waiting(
              status,
              `${command} ${args.join(' ')} exited ${code}: ${diagnostic.trim()}`,
            ),
          );
        }
      });
    });
  }
  async inventory(path: string): Promise<Outputs> {
    const entries: Outputs = {};
    const walk = async (relative: string) => {
      const full = join(path, relative),
        stat = await lstat(full);
      if (stat.isDirectory()) {
        entries[relative] = 'directory';
        for (const name of await readdir(full))
          await walk(join(relative, name));
      } else if (stat.isFile() && stat.nlink === 1)
        entries[relative] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
      else if (stat.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        entries[relative] = `link:${await readlink(full)}`;
      } else
        throw new Waiting(
          'CLEANUP_PENDING',
          `Unsupported generated output: ${full}`,
        );
    };
    for (const name of ['node_modules', 'dist'])
      if (existsSync(join(path, name))) await walk(name);
    return entries;
  }
  async removeOutputs(path: string, outputs: Outputs | undefined) {
    if (!outputs || !Object.keys(outputs).length) return;
    const actual = await this.inventory(path);
    requireSafe(
      Object.entries(actual).every(
        ([path, digest]) => outputs[path] === digest,
      ),
      'Generated outputs changed; preserve them for inspection',
    );
    for (const [relative, digest] of Object.entries(actual).sort(
      ([a], [b]) => b.length - a.length,
    )) {
      requireSafe(
        !relative.split('/').includes('..') &&
          /^(node_modules|dist)(\/|$)/.test(relative),
        'Unsafe output record',
      );
      if (digest === 'directory') await rmdir(join(path, relative));
      else await unlink(join(path, relative));
    }
  }
  async validate(
    task: Task,
    path: string,
    base: string,
    lock: DirectoryLock,
    candidate?: Candidate,
  ) {
    await this.clean(path);
    const before = await this.sha('HEAD', path);
    const existing = await this.inventory(path);
    requireSafe(
      !Object.keys(existing).length,
      'Validation needs node_modules/dist absent, or previously owned outputs removed',
    );
    let failure: unknown;
    try {
      await this.command('npm', ['ci'], path, lock);
      await this.command('npm', ['run', 'check'], path, lock);
      await this.git(['diff', '--check', `${base}...${before}`], path);
      await this.clean(path);
      requireSafe(
        before === (await this.sha('HEAD', path)),
        'Commit changed during validation',
      );
    } catch (error) {
      failure = error;
    }
    const outputs = await this.inventory(path);
    if (candidate) candidate.outputs = outputs;
    else task.outputs = outputs;
    this.save(task);
    await this.removeOutputs(path, outputs);
    if (candidate) delete candidate.outputs;
    else delete task.outputs;
    this.save(task);
    if (failure) throw failure;
    return before;
  }
  async test(task: Task, lock: DirectoryLock) {
    await this.owns(task.path, task.branch);
    await this.removeOutputs(task.path, task.outputs);
    delete task.outputs;
    delete task.tested;
    task.status = 'TESTING';
    this.save(task);
    task.tested = await this.validate(task, task.path, task.base, lock);
    task.status = 'TESTED';
    delete task.reason;
    this.save(task);
  }
  async contained(commit: string) {
    return (
      (
        await this.git(
          ['merge-base', '--is-ancestor', commit, 'refs/heads/master'],
          this.repository,
          true,
        )
      ).code === 0
    );
  }
  async absent(path: string, branch: string) {
    requireSafe(
      !existsSync(path) &&
        !(await this.worktrees()).some((x) => x.path === path) &&
        !(await this.branches()).includes(`refs/heads/${branch}`),
      'Cleanup has remaining resources',
    );
  }
  async removeWorktree(path: string, branch: string, outputs?: Outputs) {
    const listing = await this.worktrees();
    if (listing.some((x) => x.path === path)) {
      await this.owns(path, branch);
      await this.removeOutputs(path, outputs);
      await this.clean(path, true);
      await this.git(['worktree', 'remove', path]);
    }
    requireSafe(!existsSync(path), `Unregistered path retained: ${path}`);
    if ((await this.branches()).includes(`refs/heads/${branch}`)) {
      requireSafe(
        !(await this.worktrees()).some(
          (x) => x.branch === `refs/heads/${branch}`,
        ),
        'Branch is in another worktree',
      );
      // The master worktree provides Git's deletion reachability check.
      await this.git(['branch', '-d', branch], await this.master());
    }
    await this.absent(path, branch);
  }
  async discardCandidate(task: Task) {
    if (!task.candidate) return;
    const c = task.candidate;
    if ((await this.worktrees()).some((x) => x.path === c.path)) {
      if (!c.removing) await this.owns(c.path, c.branch);
      else {
        requireSafe(
          (await this.worktrees()).some(
            (x) =>
              x.path === c.path &&
              (!x.branch || x.branch === `refs/heads/${c.branch}`),
          ),
          'Detached candidate ownership mismatch',
        );
        requireSafe(
          (await this.sha('HEAD', c.path)) === c.removing &&
            realpathSync(await this.shaPath(c.path)) === this.common,
          'Detached candidate commit mismatch',
        );
      }
      const mergeHead = await this.git(
        ['rev-parse', '--verify', 'MERGE_HEAD'],
        c.path,
        true,
      );
      if (mergeHead.code === 0)
        throw new Waiting(
          'WAITING_CONFLICT',
          `Conflict candidate retained at ${c.path}; resolve and transfer its commit to the task before recovery`,
        );
      const head = await this.sha('HEAD', c.path);
      if (!c.head && head !== c.base && task.tested) {
        const parents = (
          await this.git(['rev-list', '--parents', '-n', '1', head], c.path)
        ).stdout.trim();
        if (parents === `${head} ${c.base} ${task.tested}`) {
          const mergedTree = await this.git(
            ['merge-tree', '--write-tree', c.base, task.tested],
            c.path,
            true,
          );
          if (
            mergedTree.code === 0 &&
            mergedTree.stdout.trim() ===
              (await this.sha(`${head}^{tree}`, c.path))
          )
            c.head = head;
        }
      }
      const transferred = await this.git(
        ['merge-base', '--is-ancestor', head, `refs/heads/${task.branch}`],
        this.repository,
        true,
      );
      requireSafe(
        head === (c.head ?? c.base) ||
          head === c.removing ||
          transferred.code === 0,
        'Candidate has new commits; transfer them to the task before cleanup',
      );
      await this.removeOutputs(c.path, c.outputs);
      await this.clean(c.path, true);
      c.removing = await this.sha('HEAD', c.path);
      this.save(task);
      await this.git(['switch', '--detach', c.removing], c.path);
      if ((await this.branches()).includes(`refs/heads/${c.branch}`))
        await this.git(['branch', '-d', c.branch], c.path);
      await this.git(['worktree', 'remove', c.path]);
    }
    if (
      !existsSync(c.path) &&
      (await this.branches()).includes(`refs/heads/${c.branch}`)
    ) {
      requireSafe(
        (await this.sha(`refs/heads/${c.branch}`)) === c.base,
        'Partial candidate branch contains unverified commits',
      );
      await this.git(['branch', '-d', c.branch], await this.master());
    }
    await this.absent(c.path, c.branch);
    delete task.candidate;
    this.save(task);
  }
  async cleanup(task: Task) {
    requireSafe(
      task.merged && (await this.contained(task.merged)),
      'No verified merge result in master',
    );
    requireSafe(
      task.tested && (await this.contained(task.tested)),
      'Tested task is absent from master',
    );
    // A later serialized merge may advance master; the recorded result must remain an ancestor.
    if ((await this.branches()).includes(`refs/heads/${task.branch}`))
      requireSafe(
        (await this.sha(`refs/heads/${task.branch}`)) === task.tested,
        'Task branch changed after merge',
      );
    task.status = 'CLEANUP_PENDING';
    this.save(task);
    await this.discardCandidate(task);
    await this.removeWorktree(task.path, task.branch, task.outputs);
    task.status = 'DONE';
    delete task.reason;
    this.save(task);
  }
  async merge(task: Task, lock: DirectoryLock) {
    await this.withLock('repository.lock', false, async () => {
      if (task.merged) {
        await this.cleanup(task);
        return;
      }
      await this.owns(task.path, task.branch);
      await this.clean(task.path);
      requireSafe(
        task.status === 'TESTED' &&
          task.tested === (await this.sha('HEAD', task.path)),
        'Task must be TESTED at its current commit',
      );
      if (
        task.candidate?.commit &&
        (await this.contained(task.candidate.commit))
      ) {
        task.merged = task.candidate.commit;
        this.save(task);
        await this.cleanup(task);
        return;
      }
      await this.discardCandidate(task);
      for (let attempt = 0; attempt < 3; attempt++) {
        const master = await this.master();
        await this.clean(master);
        await this.owns(master, 'master');
        const base = await this.sha('refs/heads/master');
        const branch = `integrate/${task.id}-${randomUUID()}`;
        const c: Candidate = {
          path: join(this.root, branch.replace('/', '-')),
          branch,
          base,
        };
        task.candidate = c;
        task.status = 'MERGING';
        this.save(task);
        await this.git(['worktree', 'add', '-b', branch, c.path, base]);
        const merged = await this.git(
          ['merge', '--no-ff', '--no-edit', task.tested],
          c.path,
          true,
        );
        if (merged.code !== 0) {
          const conflicts = (
            await this.git(['diff', '--name-only', '--diff-filter=U'], c.path)
          ).stdout.trim();
          if (conflicts)
            throw new Waiting(
              'WAITING_CONFLICT',
              `Conflicts: ${conflicts}\nCandidate: ${c.path}`,
            );
          throw new Error(merged.stderr);
        }
        c.head = await this.sha('HEAD', c.path);
        this.save(task);
        c.commit = await this.validate(task, c.path, base, lock, c);
        this.save(task);
        await this.owns(task.path, task.branch);
        await this.clean(task.path);
        requireSafe(
          task.tested === (await this.sha('HEAD', task.path)),
          'Task changed during integration',
        );
        await this.clean(master);
        if (base !== (await this.sha('refs/heads/master'))) {
          await this.discardCandidate(task);
          continue;
        }
        // ff-only names the tested SHA, not a mutable branch name.
        await this.git(['merge', '--ff-only', c.commit], master);
        requireSafe(
          (await this.sha('refs/heads/master')) === c.commit,
          'master differs from tested integration commit',
        );
        task.merged = c.commit;
        task.status = 'CLEANUP_PENDING';
        this.save(task);
        await this.cleanup(task);
        return;
      }
      throw new Waiting(
        'WAITING_MASTER',
        'master kept changing; retry integration from its latest commit',
      );
    });
  }
  async recover(task: Task) {
    await this.withLock('repository.lock', true, async () => {
      if (task.status === 'CREATING') {
        await this.finishCreate(task);
        return;
      }
      if (task.status === 'DONE') {
        await this.absent(task.path, task.branch);
        return;
      }
      if (
        !task.merged &&
        task.candidate?.commit &&
        (await this.contained(task.candidate.commit))
      ) {
        task.merged = task.candidate.commit;
        this.save(task);
      }
      if (task.merged) {
        await this.cleanup(task);
        return;
      }
      await this.owns(task.path, task.branch);
      await this.git(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        task.path,
      );
      if (task.tested !== (await this.sha('HEAD', task.path)))
        delete task.tested;
      await this.discardCandidate(task);
      task.status = 'DEVELOPING';
      delete task.tested;
      delete task.reason;
      this.save(task);
    });
  }
  async run(operation: string, id: string, args: string[] = []) {
    this.validateId(id);
    this.initialize();
    if (operation === 'create') return this.create(id);
    const result = await this.withLock(
      `${id}.lock`,
      operation === 'recover',
      async (lock) => {
        const task = this.load(id);
        try {
          if (operation === 'recover') await this.recover(task);
          else if (operation === 'exec') {
            await this.owns(task.path, task.branch);
            requireSafe(args[0], 'exec requires a command after --');
            await this.command(args[0], args.slice(1), task.path, lock);
          } else if (task.status === 'DONE')
            await this.absent(task.path, task.branch);
          else if (operation === 'cleanup')
            await this.withLock('repository.lock', false, () =>
              this.cleanup(task),
            );
          else if (operation === 'test') await this.test(task, lock);
          else if (operation === 'merge') await this.merge(task, lock);
          else if (operation === 'complete') {
            if (
              task.merged ||
              (task.candidate?.commit &&
                (await this.contained(task.candidate.commit)))
            )
              await this.recover(task);
            else {
              await this.test(task, lock);
              await this.merge(task, lock);
            }
          } else
            throw new Waiting(
              'WAITING_STATE',
              `Unknown operation: ${operation}`,
            );
          return task;
        } catch (error) {
          if (task.merged) task.status = 'CLEANUP_PENDING';
          else if (permission(error)) task.status = 'WAITING_PERMISSION';
          else if (error instanceof Waiting) task.status = error.status;
          else task.status = 'WAITING_GIT';
          task.reason = String(error);
          this.save(task);
          throw error;
        }
      },
    );
    // Handoff runs only after both usage and repository locks have been released.
    if (
      result.status === 'DONE' &&
      ['complete', 'merge', 'cleanup', 'recover'].includes(operation) &&
      existsSync(join(this.root, 'queue.json'))
    ) {
      const { Queue } = await import('./queue.js');
      await new Queue(this).handoff(result);
    }
    return result;
  }
  async status(id: string) {
    const task = this.load(id);
    const branches = await this.branches(),
      worktrees = await this.worktrees();
    const current = (
      await this.git(
        ['rev-parse', '--verify', `refs/heads/${task.branch}`],
        this.repository,
        true,
      )
    ).stdout.trim();
    let dirty: string | null = null;
    if (existsSync(task.path))
      dirty = (
        await this.git(
          ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'],
          task.path,
          true,
        )
      ).stdout.trim();
    return {
      ...task,
      master: await this.sha('refs/heads/master'),
      actualBranch: branches.includes(`refs/heads/${task.branch}`),
      actualWorktree: worktrees.find((x) => x.path === task.path) ?? null,
      pathExists: existsSync(task.path),
      current,
      testedCurrent: Boolean(task.tested && task.tested === current && !dirty),
      dirty,
    };
  }
}

const main = async () => {
  const [operation, id, ...args] = process.argv.slice(2);
  requireSafe(
    operation &&
      [
        'create',
        'status',
        'list',
        'test',
        'merge',
        'cleanup',
        'recover',
        'complete',
        'exec',
      ].includes(operation),
    'Usage: npm run worktree -- <create|status|list|test|merge|cleanup|recover|complete|exec> [task-id] [-- command args]',
  );
  const manager = await Worktrees.open();
  if (
    operation === 'list' ||
    ((operation === 'status' || operation === 'recover') && !id)
  ) {
    if (!existsSync(join(manager.root, 'tasks'))) {
      console.log('[]');
      return;
    }
    const tasks = (await readdir(join(manager.root, 'tasks'))).filter((x) =>
      /^[a-z0-9-]+\.json$/.test(x),
    );
    const results = [];
    for (const file of tasks) {
      const taskId = file.slice(0, -5);
      if (operation === 'recover') await manager.run('recover', taskId);
      results.push(await manager.status(taskId));
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  requireSafe(id, 'Task ID required');
  let result;
  if (operation === 'status') result = await manager.status(id);
  else {
    if (args[0] === '--') args.shift();
    result = await manager.run(operation, id, args);
  }
  console.log(JSON.stringify(result, null, 2));
};
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    let status = 'WAITING_GIT';
    if (permission(error)) status = 'WAITING_PERMISSION';
    else if (error instanceof Waiting) status = error.status;
    console.error(JSON.stringify({ status, reason: String(error) }));
    process.exitCode = 1;
  });
}
