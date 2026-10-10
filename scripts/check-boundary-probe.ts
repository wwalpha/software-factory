import childProcess, { execFileSync, execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, edits } from '../tests/helpers.js';
import { repairProducts } from '../tests/fixtures/check-products.js';
import { ProtectedChecks } from '../src/adapters/checks.js';

// Observe real starts without substituting results; child test processes are sampled separately.
const spawn = childProcess.spawn;
let started: Set<number> | undefined;
let exits:
  { channel: string; code: number | null; signal: string | null }[] | undefined;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  if (/^(.*\/)?ps$/.test(args[0])) return child;
  if (child.pid) started?.add(child.pid);
  const trace = exits;
  const command = args[0];
  const first = args[1]?.[0] ?? '';
  let channel: string;
  if (command === process.execPath) {
    if (first.endsWith('product-worker.js')) channel = 'product';
    else channel = 'evaluator';
  } else channel = `docker/${first}`;
  child.on('close', (code, signal) => trace?.push({ channel, code, signal }));
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
const f = await fixture();
try {
  const repair = f.profiles[0]!,
    refactor = f.profiles[1]!;
  const image = process.env.PRODUCT_CHECK_IMAGE ?? null;
  const checks = new ProtectedChecks(image);
  const wrongRefactor = await readFile(
    join(refactor.repository, 'names.ts'),
    'utf8',
  );
  let correctRefactor = wrongRefactor;
  for (const edit of edits.filter((e) => e.path === 'names.ts'))
    correctRefactor = correctRefactor.replaceAll(edit.before, edit.after);
  const cases = [
    ...Object.entries(repairProducts).map(([name, source]) => ({
      name,
      source,
      profile: repair,
      module: 'range.ts',
    })),
    {
      name: 'correctRefactor',
      source: correctRefactor,
      profile: refactor,
      module: 'names.ts',
    },
    {
      name: 'wrongRefactor',
      source: wrongRefactor,
      profile: refactor,
      module: 'names.ts',
    },
    {
      name: 'assertRefactor',
      source:
        "import assert from 'node:assert/strict';assert.deepEqual=()=>{};" +
        correctRefactor.replaceAll(
          'names.map(normalizeName)',
          'names.map(()=>"wrong")',
        ),
      profile: refactor,
      module: 'names.ts',
    },
  ];
  const results = [];
  for (const { name, source, profile, module } of cases) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const observed = new Set<number>();
      started = new Set<number>();
      exits = [];
      const pending = new Set<Promise<void>>();
      const samplerPids = new Set<number>();
      let samplingFailure: Error | undefined;
      const poll = setInterval(() => {
        const sample = new Promise<void>((resolve) => {
          const sampler = execFile(
            'ps',
            ['-axo', 'pid=,ppid=,comm='],
            (error, stdout) => {
              if (error) samplingFailure = error;
              else {
                const rows = stdout
                  .trim()
                  .split('\n')
                  .map((row) => row.trim().split(/\s+/));
                const parents = new Set([process.pid]);
                for (let step = 0; step < 5; step++)
                  for (const [pid, parent, command] of rows)
                    if (
                      parents.has(Number(parent)) &&
                      !samplerPids.has(Number(pid)) &&
                      !/^(.*\/)?ps$/.test(command ?? '')
                    ) {
                      parents.add(Number(pid));
                      observed.add(Number(pid));
                    }
              }
              resolve();
            },
          );
          if (sampler.pid) samplerPids.add(sampler.pid);
        });
        pending.add(sample);
        void sample.finally(() => pending.delete(sample));
      }, 10);
      const since = new Date().toISOString();
      const start = performance.now();
      let result: unknown;
      try {
        result = await checks.run(
          {
            [module]: {
              content: Buffer.from(source).toString('base64'),
              executable: false,
            },
          },
          profile,
          AbortSignal.timeout(60000),
        );
      } catch (e) {
        if (e instanceof Error) result = { error: e.message };
        else result = { error: String(e) };
      } finally {
        clearInterval(poll);
      }
      const ms = Math.round(performance.now() - start);
      const until = new Date().toISOString();
      await Promise.all(pending);
      if (samplingFailure) throw samplingFailure;
      const parentStarts = started.size;
      for (const pid of started) observed.add(pid);
      started = undefined;
      const exitCodes = exits;
      exits = undefined;
      let containers = 0;
      if (image) {
        const events = execFileSync(
          'docker',
          [
            'events',
            '--since',
            since,
            '--until',
            until,
            '--filter',
            'type=container',
            '--filter',
            'event=start',
            '--format',
            '{{json .}}',
          ],
          { encoding: 'utf8' },
        ).trim();
        const ids = new Set<string>();
        for (const line of events.split('\n').filter(Boolean)) {
          const event = JSON.parse(line);
          if (/^factory-(check|product)-/.test(event.Actor.Attributes.name))
            ids.add(event.Actor.ID);
        }
        containers = ids.size;
        assert.ok(containers > 0, 'No actual container start events observed');
      }
      assert.ok(parentStarts > 0, 'No actual process starts observed');
      samples.push({
        ms,
        parentStarts,
        observedProcesses: observed.size,
        containers,
        exitCodes,
        result,
      });
    }
    results.push({
      name,
      medianMs: samples.map((s) => s.ms).sort((a, b) => a - b)[1],
      samples,
    });
  }
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      image,
      results,
    }),
  );
} finally {
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  await f.cleanup();
}
