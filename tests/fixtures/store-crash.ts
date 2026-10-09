import { SqliteStore } from '../../src/adapters/sqlite.js';
const db = await SqliteStore.open(process.argv[2] ?? '');
const fault = process.argv[3];
if (fault !== 'before' && fault !== 'after') throw Error('fault');
await db.faultCommit(
  [
    {
      kind: 'mission',
      id: 'm',
      expectedVersion: 0,
      value: { state: 'running' },
    },
  ],
  { id: 'e', topic: 'started', payload: { id: 'm' } },
  fault,
);
