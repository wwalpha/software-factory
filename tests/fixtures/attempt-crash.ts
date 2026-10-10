import { SqliteStore } from '../../src/adapters/sqlite.js';
import { Runtime } from '../../src/application/runtime.js';
import { FakePlanner, FakeRunner } from '../../src/adapters/fake.js';
import { GuardService } from '../../src/guard/service.js';
import { ProtectedChecks } from '../../src/adapters/checks.js';
import { models } from '../helpers.js';
import { readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Settings } from '../../src/adapters/config.js';
import type { OperationRequest } from '../../src/ports/guard.js';

const [path, guardPath, missionId, fault] = process.argv.slice(2);
if (
  !path ||
  !guardPath ||
  !missionId ||
  !['before', 'after', 'dispatch'].includes(fault ?? '')
)
  throw Error('fixture arguments');
const config = JSON.parse(
  await readFile(join(dirname(dirname(path)), 'config.json'), 'utf8'),
) as Settings;
const store = await SqliteStore.open(path);
const guardStore = await SqliteStore.open(guardPath);
const runner = new FakeRunner([]);
const guard = new GuardService(
  {
    root: config.guardRoot,
    development: true,
    caller: 'factoryd',
    projects: config.profiles,
    models,
    secrets: [],
  },
  guardStore,
  {
    stop: async () => true,
    isStopped: async () => true,
    run: async (...args) => {
      const out = await runner.run(...args);
      await appendFile(
        join(dirname(path), 'runner-starts.jsonl'),
        JSON.stringify({ attemptId: args[0].id }) + '\n',
      );
      await appendFile(join(dirname(path), 'fault-point.txt'), 'dispatch');
      // Stop only this dedicated fixture after a Runner effect and before Guard result persistence.
      process.kill(process.pid, 'SIGKILL');
      return out;
    },
  },
  new ProtectedChecks(),
);
await guard.initialize();
const commit = store.commit.bind(store);
store.commit = async (writes, event, admission) => {
  if (admission && (fault === 'before' || fault === 'after')) {
    await appendFile(join(dirname(path), 'fault-point.txt'), fault);
    await store.faultCommit(writes, event, fault, admission);
    throw Error('fault did not terminate fixture');
  }
  return commit(writes, event, admission);
};
const runtime = new Runtime(
  store,
  new FakePlanner(),
  {
    call: async <T>(method: string, params: unknown) =>
      (await guard.call(method, params)) as T,
    operate: async <T>(request: OperationRequest) =>
      (await guard.operate(request)) as T,
  },
  'fake',
);
await runtime.run(missionId, 'fake');
throw Error('expected fault point was not reached');
