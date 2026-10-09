#!/usr/bin/env node
import { verifyBundle } from '../adapters/verification.js';
import { contract } from '../adapters/contracts.js';
import { writeTree, readTree } from '../adapters/artifacts.js';
import type { Tree } from '../adapters/artifacts.js';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { loadSettings, token } from '../adapters/config.js';
import { GuardClient } from '../adapters/ipc.js';
import { parseYaml } from '../adapters/contracts.js';
import { doctor } from '../application/doctor.js';
import { FactoryError } from '../domain/invariants.js';
const program = new Command()
  .name('factory')
  .option('--config <file>', 'Settings', 'config/local.json');
const output = (result: unknown) => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result && typeof result === 'object' && 'status' in result) {
    const status = result.status;
    process.exitCode =
      status === 'BLOCKED'
        ? 3
        : status === 'waiting'
          ? 4
          : status === 'failed'
            ? 2
            : status === 'cancelled'
              ? 5
              : 0;
  }
};
async function client() {
  const settings = await loadSettings(
    program.opts<{ config: string }>().config,
  );
  return new GuardClient(
    settings.runtimeSocket,
    await token(settings.runtimeTokenFile),
  );
}
program.command('doctor').action(async () => {
  const s = await loadSettings(program.opts<{ config: string }>().config);
  output(
    await doctor(
      s,
      new GuardClient(s.guardSocket, await token(s.guardTokenFile)),
    ),
  );
});
program
  .command('submit')
  .requiredOption('--requirements <file>')
  .requiredOption('--project <profile>')
  .action(async (o: { requirements: string; project: string }) =>
    output(
      await (
        await client()
      ).call('submit', {
        requirements: await readFile(o.requirements, 'utf8'),
        profile: parseYaml(await readFile(o.project, 'utf8')),
      }),
    ),
  );
program
  .command('run <mission-id>')
  .option('--mode <mode>', 'fake or live', 'fake')
  .action(async (id: string, o: { mode: string }) =>
    output(await (await client()).call('run', { id, mode: o.mode })),
  );
program
  .command('status <mission-id>')
  .option('--json')
  .action(async (id: string) =>
    output(await (await client()).call('status', id)),
  );
program
  .command('resume <mission-id>')
  .option('--mode <mode>', 'fake or live', 'fake')
  .action(async (id: string, o: { mode: string }) =>
    output(await (await client()).call('resume', { id, mode: o.mode })),
  );
program
  .command('cancel <mission-id>')
  .action(async (id: string) =>
    output(await (await client()).call('cancel', id)),
  );
program
  .command('result <mission-id>')
  .option('--output <directory>')
  .action(async (id: string, o: { output?: string }) => {
    const api = await client();
    const result = await api.call('result', id);
    if (o.output) {
      const artifact = await api.call<{ tree: Tree }>('artifact', id);
      await writeTree(o.output, artifact.tree);
    }
    output(result);
  });
program
  .command('revise <mission-id>')
  .requiredOption('--requirements <file>')
  .action(async (id: string, o: { requirements: string }) =>
    output(
      await (
        await client()
      ).call('revise', {
        id,
        clarification: await readFile(o.requirements, 'utf8'),
      }),
    ),
  );
const experiment = program.command('experiment');
experiment
  .command('create <mission-id>')
  .action(async (id: string) =>
    output(await (await client()).call('experimentCreate', id)),
  );
experiment
  .command('run <experiment-id>')
  .option('--mode <mode>', 'fake or live', 'fake')
  .action(async (id: string, o: { mode: string }) =>
    output(await (await client()).call('experimentRun', { id, mode: o.mode })),
  );
const release = program.command('release');
release
  .command('status')
  .action(async () =>
    output(await (await client()).call('releaseStatus', null)),
  );
release
  .command('rollback <release-id>')
  .action(async (id: string) =>
    output(await (await client()).call('rollback', id)),
  );
program
  .command('verify <bundle>')
  .requiredOption('--public-key <file>')
  .requiredOption('--artifact <directory>')
  .action(async (file: string, o: { publicKey: string; artifact: string }) => {
    const bundle = contract(
      'ResultBundle',
      parseYaml(await readFile(file, 'utf8')),
    );
    verifyBundle(
      bundle,
      await readTree(o.artifact),
      await readFile(o.publicKey, 'utf8'),
    );
    output({ status: 'PASS', digest: bundle.artifact?.digest });
  });
await program.parseAsync().catch((e) => {
  output({
    status:
      e instanceof FactoryError && e.code === 'waiting' ? 'waiting' : 'BLOCKED',
    code: e instanceof FactoryError ? e.code : 'connection',
    message:
      e instanceof FactoryError
        ? e.message
        : 'Factory service or configuration unavailable',
  });
  process.exitCode = 3;
});
