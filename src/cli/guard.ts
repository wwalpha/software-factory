#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SqliteStore } from '../adapters/sqlite.js';
import { loadSettings, ownerLock, token } from '../adapters/config.js';
import { GuardClient, serve } from '../adapters/ipc.js';
import { FakeRunner } from '../adapters/fake.js';
import { DockerRunner } from '../adapters/docker.js';
import { ProtectedChecks } from '../adapters/checks.js';
import { GuardService } from '../guard/service.js';
import { EvolutionService } from '../guard/evolution.js';
import { contract, parseYaml } from '../adapters/contracts.js';
import { ensure } from '../domain/invariants.js';
import { logger } from '../adapters/logging.js';
import { digest } from '../adapters/artifacts.js';
const program = new Command().option(
  '--config <file>',
  'Factory deployment settings',
  'config/local.json',
);
program.command('start').action(async () => {
  const config = await loadSettings(program.opts<{ config: string }>().config);
  const unlock = await ownerLock(config.guardRoot);
  const store = await SqliteStore.open(join(config.guardRoot, 'guard.db'));
  const runner =
    config.mode === 'fake'
      ? new FakeRunner(config.fakeEdits, config.fakeOmitFirst)
      : new DockerRunner(
          config.workerImage ?? '',
          join(config.guardRoot, 'work'),
          process.env.CODEX_PROVIDER_API_KEY ?? '',
        );
  const checks = new ProtectedChecks(
    config.mode === 'live' ? config.workerImage : null,
  );
  const service = new GuardService(
    {
      root: config.guardRoot,
      policyFile: resolve(program.opts<{ config: string }>().config),
      runtimeRoot: config.runtimeRoot,
      development: config.mode === 'fake',
      caller: 'factoryd',
      projects: config.profiles,
      models: config.models,
      secrets: [
        process.env.OPENAI_API_KEY ?? '',
        process.env.CODEX_PROVIDER_API_KEY ?? '',
        await token(config.operatorTokenFile),
        await token(config.guardTokenFile),
      ],
    },
    store,
    runner,
    checks,
  );
  await service.initialize();
  const evolution = new EvolutionService(service, checks, config.suite);
  await mkdir(dirname(config.guardSocket), { recursive: true });
  await mkdir(dirname(config.operatorSocket), { recursive: true });
  const socket = await serve(
    config.guardSocket,
    await token(config.guardTokenFile),
    async (method, params) => {
      if (method === 'experimentDescriptor') {
        ensure(typeof params === 'string', 'schema', 'Release ID required');
        return evolution.descriptor(params);
      }
      if (method === 'experimentFix') return evolution.fix(params);
      if (method === 'experimentPropose') {
        ensure(
          params &&
            typeof params === 'object' &&
            'id' in params &&
            'prompt' in params &&
            typeof params.id === 'string' &&
            typeof params.prompt === 'string',
          'schema',
          'Invalid recipe proposal',
        );
        return evolution.propose(params.id, params.prompt);
      }
      if (method === 'experimentRun') {
        ensure(typeof params === 'string', 'schema', 'Experiment ID required');
        return evolution.run(params);
      }
      if (method === 'followup') return evolution.followup(params);
      if (method === 'rollback') {
        ensure(typeof params === 'string', 'schema', 'Release ID required');
        return evolution.rollback(params);
      }
      return service.call(method, params);
    },
    config.mode === 'live' ? 0o660 : 0o600,
  );
  const operator = await serve(
    config.operatorSocket,
    await token(config.operatorTokenFile),
    (method, params) => service.operator(method, params),
  );
  logger.info({ mode: config.mode }, 'Guard ready');
  const close = async () => {
    socket.close();
    operator.close();
    await store.close();
    await unlock();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
});
program
  .command('grant')
  .requiredOption('--mission <file>')
  .option('--expires-minutes <n>', 'Grant lifetime', '60')
  .action(async (options: { mission: string; expiresMinutes: string }) => {
    const config = await loadSettings(
      program.opts<{ config: string }>().config,
    );
    const mission = contract(
      'MissionRevision',
      parseYaml(await readFile(options.mission, 'utf8')),
    );
    const grant = {
      id: `grant-${mission.id}${mission.revision > 1 ? `-r${mission.revision}` : ''}`,
      caller: 'factoryd',
      projectId: mission.projectId,
      missionId: mission.id,
      operations: mission.delegation.operations,
      scope: mission.scope,
      expiresAt: new Date(
        Date.now() + Number(options.expiresMinutes) * 60000,
      ).toISOString(),
      maxUsd: mission.budget.maxUsd,
      missionDigest: digest(mission),
      releaseId: mission.factoryRelease,
    };
    const result = await new GuardClient(
      config.operatorSocket,
      await token(config.operatorTokenFile),
    ).call('grant', { mission, grant });
    process.stdout.write(JSON.stringify(result) + '\n');
  });
program.command('authorize-retry <operation-id>').action(async (id: string) => {
  const config = await loadSettings(program.opts<{ config: string }>().config);
  process.stdout.write(
    JSON.stringify(
      await new GuardClient(
        config.operatorSocket,
        await token(config.operatorTokenFile),
      ).call('authorize-retry', id),
    ) + '\n',
  );
});
program
  .command('public-key')
  .requiredOption('--output <file>')
  .action(async (options: { output: string }) => {
    const config = await loadSettings(
      program.opts<{ config: string }>().config,
    );
    const result = await new GuardClient(
      config.operatorSocket,
      await token(config.operatorTokenFile),
    ).call<{ publicKey: string }>('public-key', null);
    await writeFile(options.output, result.publicKey, {
      flag: 'wx',
      mode: 0o644,
    });
    process.stdout.write(
      JSON.stringify({ status: 'PASS', output: options.output }) + '\n',
    );
  });
await program.parseAsync().catch((e) => {
  logger.error(
    { code: e instanceof Error ? e.name : 'error' },
    'Guard command failed',
  );
  process.exit(3);
});
