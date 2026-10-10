import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Write, Event, AttemptAdmission } from '../ports/store.js';
import type { Attempt, MissionRevision } from '../domain/contracts.js';
import type { OperationRequest } from '../ports/guard.js';
import { ensure, FactoryError } from '../domain/invariants.js';
type Request = { id: number } & (
  | { op: 'get'; kind: string; key: string }
  | { op: 'list'; kind: string }
  | {
      op: 'commit';
      writes: Write[];
      event: Event;
      fault?: 'before' | 'after';
      admission?: AttemptAdmission;
    }
  | { op: 'pending' }
  | { op: 'ack'; key: string }
  | { op: 'close' }
  | {
      op: 'reserve';
      key: string;
      account: string;
      amount: number;
      limit: number;
    }
  | { op: 'settle'; key: string; actual: number | null }
  | { op: 'balance'; account: string }
);
const data: { path: string } = workerData;
const db = new DatabaseSync(data.path);
ensure(
  Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) <= 1,
  'migration',
  'Database is newer than this Factory release',
);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;',
);
db.exec(
  readFileSync(new URL('../../../migrations/001.sql', import.meta.url), 'utf8'),
);
function balance(account: string) {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(CASE WHEN settled=0 THEN amount ELSE 0 END),0) reserved, COALESCE(SUM(CASE WHEN settled=1 THEN COALESCE(actual,amount) ELSE 0 END),0) spent, COALESCE(SUM(unknown),0) unknown FROM reservations WHERE account=?',
    )
    .get(account);
  return row;
}
const reserve = (
  id: string,
  account: string,
  amount: number,
  limit: number,
): void => {
  ensure(
    Number.isFinite(amount) && amount > 0 && Number.isFinite(limit),
    'budget',
    'Invalid reservation',
  );
  const old = db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
  if (old) {
    ensure(
      old.account === account && old.amount === amount,
      'duplicate-conflict',
      'Reservation changed',
    );
    return;
  }
  const b = balance(account);
  ensure(
    b && Number(b.reserved) + Number(b.spent) + amount <= limit,
    'budget',
    'Budget exhausted',
  );
  db.prepare('INSERT INTO reservations(id,account,amount) VALUES(?,?,?)').run(
    id,
    account,
    amount,
  );
};
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function execute(r: Request): unknown {
  switch (r.op) {
    case 'get':
      return (
        db
          .prepare('SELECT * FROM records WHERE kind=? AND id=?')
          .get(r.kind, r.key) ?? null
      );
    case 'list':
      return db
        .prepare('SELECT * FROM records WHERE kind=? ORDER BY id')
        .all(r.kind);
    case 'commit': {
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            writes: r.writes,
            event: r.event,
            admission: r.admission,
          }),
        )
        .digest('hex');
      const result = transaction(() => {
        const seen = db
          .prepare('SELECT digest FROM outbox WHERE id=?')
          .get(r.event.id);
        if (seen) {
          ensure(
            seen.digest === hash,
            'duplicate-conflict',
            'Event ID reused with different request',
          );
          return { duplicate: true };
        }
        if (r.admission) {
          const { attemptId, missionId } = r.admission;
          const missionRow = db
            .prepare('SELECT value FROM records WHERE kind=? AND id=?')
            .get('mission', missionId);
          ensure(missionRow, 'mission', 'Mission not found');
          const mission = JSON.parse(
            String(missionRow.value),
          ) as MissionRevision;
          const attempt = r.writes.find(
            (w) => w.kind === 'attempt' && w.id === attemptId,
          )?.value as Attempt | undefined;
          const state = r.writes.find(
            (w) => w.kind === 'state' && w.id === missionId,
          )?.value as
            { attempts: string[]; work: Record<string, string> } | undefined;
          const dispatch = r.writes.find(
            (w) => w.kind === 'dispatch' && w.id === attempt?.operationId,
          )?.value as OperationRequest | undefined;
          ensure(
            attempt &&
              state &&
              dispatch &&
              attempt.missionId === missionId &&
              dispatch.type === 'build' &&
              dispatch.mission.id === missionId &&
              JSON.stringify(dispatch.mission) === JSON.stringify(mission) &&
              JSON.stringify(
                (dispatch.payload as { attempt: Attempt }).attempt,
              ) === JSON.stringify(attempt) &&
              state.attempts.includes(attemptId) &&
              state.work[attempt.workItemId] === 'running',
            'admission',
            'Incomplete attempt admission',
          );
          const count = db
            .prepare(
              "SELECT COUNT(*) count FROM records WHERE kind='attempt' AND json_extract(value,'$.missionId')=?",
            )
            .get(missionId);
          ensure(
            Number(count?.count) < mission.budget.maxAttempts,
            'budget',
            'Attempt budget exhausted',
          );
          reserve(attemptId, missionId, dispatch.amount, mission.budget.maxUsd);
        }
        for (const w of r.writes) {
          const old = db
            .prepare('SELECT version FROM records WHERE kind=? AND id=?')
            .get(w.kind, w.id);
          ensure(
            (old?.version ?? 0) === w.expectedVersion,
            'version',
            'Optimistic version conflict',
          );
          db.prepare(
            'INSERT INTO records(kind,id,version,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,value=excluded.value',
          ).run(w.kind, w.id, w.expectedVersion + 1, JSON.stringify(w.value));
        }
        db.prepare(
          'INSERT INTO outbox(id,digest,topic,payload) VALUES(?,?,?,?)',
        ).run(r.event.id, hash, r.event.topic, JSON.stringify(r.event.payload));
        if (r.fault === 'before') {
          process.kill(process.pid, 'SIGKILL');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return { duplicate: false };
      });
      if (r.fault === 'after') process.kill(process.pid, 'SIGKILL');
      return result;
    }
    case 'pending':
      return db
        .prepare(
          'SELECT id,topic,payload FROM outbox WHERE dispatched=0 ORDER BY rowid',
        )
        .all();
    case 'ack':
      db.prepare('UPDATE outbox SET dispatched=1 WHERE id=?').run(r.key);
      return null;
    case 'reserve':
      return transaction(() => {
        reserve(r.key, r.account, r.amount, r.limit);
        return null;
      });
    case 'settle':
      return transaction(() => {
        const old = db
          .prepare('SELECT * FROM reservations WHERE id=?')
          .get(r.key);
        ensure(old, 'budget', 'No reservation');
        ensure(
          r.actual === null || (Number.isFinite(r.actual) && r.actual >= 0),
          'budget',
          'Invalid usage',
        );
        if (old.settled) {
          ensure(
            old.actual === r.actual,
            'duplicate-conflict',
            'Settlement changed',
          );
          return null;
        }
        db.prepare(
          'UPDATE reservations SET actual=?, settled=1, unknown=? WHERE id=?',
        ).run(r.actual, r.actual === null ? 1 : 0, r.key);
        return null;
      });
    case 'balance':
      return balance(r.account);
    case 'close':
      db.close();
      return null;
  }
}
parentPort?.on('message', (r: Request) => {
  try {
    parentPort?.postMessage({ id: r.id, result: execute(r) });
  } catch (e) {
    parentPort?.postMessage({
      id: r.id,
      error: e instanceof Error ? e.message : 'Database failure',
      code: e instanceof FactoryError ? e.code : 'store',
    });
  }
});
