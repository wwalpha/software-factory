#!/usr/bin/env node
import { Command } from 'commander';
import { join, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadSettings, ownerLock, token } from '../adapters/config.js';
import { SqliteStore } from '../adapters/sqlite.js';
import { serve, GuardClient } from '../adapters/ipc.js';
import { FakePlanner } from '../adapters/fake.js';
import { ResponsesPlanner } from '../adapters/responses.js';
import { Runtime } from '../application/runtime.js';
import { doctor } from '../application/doctor.js';
import { ensure, FactoryError } from '../domain/invariants.js';
import { contract } from '../adapters/contracts.js';
import { logger } from '../adapters/logging.js';
const program = new Command().option(
  '--config <file>',
  'Settings',
  'config/local.json',
);
program.parse();
try {
  const settings = await loadSettings(
    program.opts<{ config: string }>().config,
  );
  const guard = new GuardClient(
    settings.guardSocket,
    await token(settings.guardTokenFile),
  );
  if (settings.mode === 'live') {
    const report = await doctor(settings, guard);
    ensure(
      report.status === 'READY',
      'BLOCKED',
      'Live prerequisites failed; run factory doctor',
    );
  }
  const unlock = await ownerLock(settings.runtimeRoot),
    store = await SqliteStore.open(join(settings.runtimeRoot, 'runtime.db'));
  const runtime = new Runtime(
    store,
    settings.mode === 'fake'
      ? new FakePlanner()
      : new ResponsesPlanner(settings.models, process.env.OPENAI_API_KEY ?? ''),
    guard,
    settings.mode,
    [
      process.env.OPENAI_API_KEY ?? '',
      await token(settings.guardTokenFile),
      await token(settings.runtimeTokenFile),
    ],
  );
  for (const row of await store.list<
    import('../application/runtime.js').MissionState
  >('state'))
    if (row.value.status === 'running') {
      const recovered = await runtime.recover(row.id);
      if (recovered.status === 'running')
        void runtime
          .run(row.id, settings.mode)
          .catch(() =>
            logger.error(
              { missionId: row.id },
              'Recovery requires operator attention',
            ),
          );
    }
  await mkdir(dirname(settings.runtimeSocket), { recursive: true });
  const server = await serve(
    settings.runtimeSocket,
    await token(settings.runtimeTokenFile),
    async (method, params) => {
      if (method === 'doctor') return doctor(settings, guard);
      if (method === 'submit') {
        ensure(
          params &&
            typeof params === 'object' &&
            'requirements' in params &&
            'profile' in params &&
            typeof params.requirements === 'string',
          'schema',
          'Invalid submission',
        );
        return runtime.submit(
          params.requirements,
          contract('ProjectProfile', params.profile),
        );
      }
      if (
        method === 'run' ||
        method === 'resume' ||
        method === 'experimentRun'
      ) {
        ensure(
          params &&
            typeof params === 'object' &&
            'id' in params &&
            'mode' in params &&
            typeof params.id === 'string' &&
            (params.mode === 'fake' || params.mode === 'live'),
          'schema',
          'Invalid run',
        );
        if (method === 'experimentRun')
          return runtime.runExperiment(params.id, params.mode);
        if (method === 'resume') return runtime.resume(params.id, params.mode);
        return runtime.run(params.id, params.mode);
      }
      if (method === 'revise') {
        ensure(
          params &&
            typeof params === 'object' &&
            'id' in params &&
            'clarification' in params &&
            typeof params.id === 'string' &&
            typeof params.clarification === 'string',
          'schema',
          'Invalid revision',
        );
        return runtime.revise(params.id, params.clarification);
      }
      if (method === 'artifact') return guard.call('artifact', params);
      if (method === 'releaseStatus') return guard.call('releaseStatus', null);
      if (method === 'rollback') return guard.call('rollback', params);
      ensure(typeof params === 'string', 'schema', 'Mission ID required');
      if (method === 'status') return runtime.status(params);
      if (method === 'result') return runtime.result(params);
      if (method === 'cancel') return runtime.cancel(params);
      if (method === 'experimentCreate')
        return runtime.createExperiment(params);
      throw new FactoryError('operation', 'Unknown runtime command');
    },
  );
  logger.info({ mode: settings.mode }, 'Factory runtime ready');
  const close = async () => {
    server.close();
    await store.close();
    await unlock();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
} catch (e) {
  logger.error(
    { code: e instanceof FactoryError ? e.code : 'startup' },
    'Factory runtime blocked',
  );
  process.exit(3);
}
