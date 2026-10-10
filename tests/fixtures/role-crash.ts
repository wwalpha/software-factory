import { SqliteStore } from '../../src/adapters/sqlite.js';
import { Runtime } from '../../src/application/runtime.js';
import { FakeRunner } from '../../src/adapters/fake.js';
import { GuardService } from '../../src/guard/service.js';
import { ProtectedChecks } from '../../src/adapters/checks.js';
import { models, edits } from '../helpers.js';
import { RolePlanner } from '../role-helpers.js';
import { readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Settings } from '../../src/adapters/config.js';
import type { RoleExecution } from '../../src/ports/role-execution.js';
import type { OperationRequest } from '../../src/ports/guard.js';

const [path, guardPath, missionId, fault] = process.argv.slice(2);
if (!path || !guardPath || !missionId || !fault)
  throw Error('fixture arguments');
const config = JSON.parse(
  await readFile(join(dirname(dirname(path)), 'config.json'), 'utf8'),
) as Settings;
const store = await SqliteStore.open(path);
const guardStore = await SqliteStore.open(guardPath);
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
  new FakeRunner(edits),
  new ProtectedChecks(),
);
await guard.initialize();
const planner = new RolePlanner();
planner.failures = 0;
const report = planner.report.bind(planner);
planner.report = async (...args) => {
  const input = args[1];
  if (input && typeof input === 'object' && 'item' in input) {
    await appendFile(
      join(dirname(path), 'role-starts.jsonl'),
      JSON.stringify(input.item) + '\n',
    );
    if (fault === 'dispatch') {
      await appendFile(join(dirname(path), 'role-fault.txt'), fault);
      // Only this fixture dies, after invocation and before any response is durable.
      process.kill(process.pid, 'SIGKILL');
    }
  }
  return report(...args);
};
const commit = store.commit.bind(store);
store.commit = async (writes, event, admission, budget) => {
  const execution = writes.find((w) => w.kind === 'role-execution')?.value as
    RoleExecution | undefined;
  let target = false;
  if (fault.startsWith('admission-')) target = Boolean(budget?.reservation);
  if (fault.startsWith('response-'))
    target = Boolean(
      budget?.settlements?.length &&
      execution?.calls.at(-1)?.state === 'completed',
    );
  if (fault.startsWith('completion-'))
    target = event.topic === 'role.completed';
  if (target) {
    let side: 'before' | 'after' = 'before';
    if (fault.endsWith('-after')) side = 'after';
    await appendFile(join(dirname(path), 'role-fault.txt'), fault);
    await store.faultCommit(writes, event, side, admission, budget);
    throw Error('fault did not terminate fixture');
  }
  return commit(writes, event, admission, budget);
};
const runtime = new Runtime(
  store,
  planner,
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
