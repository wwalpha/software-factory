import { Worker } from 'node:worker_threads';
import { mkdir, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  PersistencePort,
  Stored,
  Write,
  Event,
  AttemptAdmission,
  CommitBudget,
} from '../ports/store.js';
import { ensure, FactoryError } from '../domain/invariants.js';
export class SqliteStore implements PersistencePort {
  private failure: Error | null = null;
  private sequence = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  private constructor(private worker: Worker) {
    worker.on(
      'message',
      (m: { id: number; result: unknown; error?: string; code?: string }) => {
        const waiter = this.pendingRequests.get(m.id);
        this.pendingRequests.delete(m.id);
        if (m.error)
          waiter?.reject(new FactoryError(m.code ?? 'store', m.error));
        else waiter?.resolve(m.result);
      },
    );
    worker.on('error', (e) => this.fail(e));
    worker.on('exit', () => this.fail(new Error('Database worker exited')));
  }
  private fail(e: Error) {
    this.failure = e;
    for (const p of this.pendingRequests.values()) p.reject(e);
    this.pendingRequests.clear();
  }
  static async open(path: string): Promise<SqliteStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fs = await statfs(dirname(path));
    ensure(
      [
        0x1a, 0x11, 0xef53, 0x1021994, 0x794c7630, 0x58465342, 0x9123683e,
        0x2fc12fc1,
      ].includes(fs.type),
      'filesystem',
      'Database requires a recognized local filesystem (APFS/HFS/ext/tmpfs/overlay/XFS/Btrfs/ZFS)',
    );
    return new SqliteStore(
      new Worker(new URL('./sqlite-worker.js', import.meta.url), {
        workerData: { path },
      }),
    );
  }
  private request<T>(message: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: (v) => resolve(v as T), reject });
      this.worker.postMessage({ ...message, id });
    });
  }
  async get<T>(kind: string, id: string): Promise<Stored<T> | null> {
    const row = await this.request<Stored<string> | null>({
      op: 'get',
      kind,
      key: id,
    });
    return row ? { ...row, value: JSON.parse(row.value) } : null;
  }
  async list<T>(kind: string): Promise<Stored<T>[]> {
    return (await this.request<Stored<string>[]>({ op: 'list', kind })).map(
      (row) => ({ ...row, value: JSON.parse(row.value) }),
    );
  }
  commit(
    writes: Write[],
    event: Event,
    admission?: AttemptAdmission,
    budget?: CommitBudget,
  ): Promise<{ duplicate: boolean }> {
    return this.request({ op: 'commit', writes, event, admission, budget });
  }
  async faultCommit(
    writes: Write[],
    event: Event,
    fault: 'before' | 'after',
    admission?: AttemptAdmission,
    budget?: CommitBudget,
  ): Promise<void> {
    await this.request({
      op: 'commit',
      writes,
      event,
      fault,
      admission,
      budget,
    });
  }
  async pending(): Promise<Event[]> {
    return (
      await this.request<{ id: string; topic: string; payload: string }[]>({
        op: 'pending',
      })
    ).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  ack(id: string): Promise<void> {
    return this.request({ op: 'ack', key: id });
  }
  reserve(
    id: string,
    account: string,
    amount: number,
    limit: number,
  ): Promise<void> {
    return this.request({ op: 'reserve', key: id, account, amount, limit });
  }
  settle(id: string, actual: number | null): Promise<void> {
    return this.request({ op: 'settle', key: id, actual });
  }
  balance(
    account: string,
  ): Promise<{ reserved: number; spent: number; unknown: number }> {
    return this.request({ op: 'balance', account });
  }
  async close(): Promise<void> {
    await this.request({ op: 'close' });
    await this.worker.terminate();
  }
}
