// Reproducible offline Before/After probe; only the Runtime source varies.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Runtime } from '../src/application/runtime.js';
import { runProcess } from '../src/adapters/process.js';
import { roleHarness, RolePlanner } from './role-helpers.js';

const revision = process.argv[2] ?? 'current';
const scenario = process.argv[3] ?? 'transient';
assert.ok(['transient', 'success'].includes(scenario));
const planner = new RolePlanner();
if (scenario === 'success') planner.failures = 0;
const h = await roleHarness(planner);
let generated: URL | undefined;
try {
  let RuntimeClass = Runtime;
  if (revision !== 'current') {
    const source = await runProcess('git', [
      'show',
      `${revision}:src/application/runtime.ts`,
    ]);
    assert.equal(source.code, 0, source.stderr);
    generated = new URL(
      `../src/application/runtime-probe-${randomUUID()}.js`,
      import.meta.url,
    );
    await writeFile(
      generated,
      ts.transpileModule(source.stdout, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
      { flag: 'wx' },
    );
    const previous: { Runtime: typeof Runtime } = await import(generated.href);
    RuntimeClass = previous.Runtime;
  }
  const runtime = new RuntimeClass(h.store, planner, h.port, 'fake');
  let recordWrites = 0;
  let rowMutations = 0;
  let transactions = 0;
  let reportCalls = 0;
  const report = planner.report.bind(planner);
  planner.report = async (...args) => {
    reportCalls++;
    return report(...args);
  };
  const commit = h.store.commit.bind(h.store);
  h.store.commit = async (...args) => {
    const out = await commit(...args);
    if (!out.duplicate) {
      transactions++;
      recordWrites += args[0].length;
      rowMutations += args[0].length + 1;
      if (args[2]) rowMutations++;
      if (args[3]?.reservation) rowMutations++;
      rowMutations += args[3]?.settlements?.length ?? 0;
    }
    return out;
  };
  const reserve = h.store.reserve.bind(h.store);
  h.store.reserve = async (...args) => {
    await reserve(...args);
    transactions++;
    rowMutations++;
  };
  const settle = h.store.settle.bind(h.store);
  h.store.settle = async (...args) => {
    await settle(...args);
    transactions++;
    rowMutations++;
  };
  const ack = h.store.ack.bind(h.store);
  h.store.ack = async (...args) => {
    await ack(...args);
    transactions++;
    rowMutations++;
  };
  const samples = [];
  for (const phase of ['first', 'resume']) {
    // Older Runtime maps resume to run. Current Runtime makes the intent explicit.
    let result;
    if (phase === 'resume' && revision === 'current')
      result = await runtime.resume(h.mission.id, 'fake');
    else result = await runtime.run(h.mission.id, 'fake');
    const db = new DatabaseSync(join(h.config.runtimeRoot, 'runtime.db'), {
      readOnly: true,
    });
    let storage;
    try {
      storage = db
        .prepare(
          `
        SELECT (SELECT SUM(length(CAST(value AS BLOB))) FROM records) recordJsonBytes,
          (SELECT SUM(length(CAST(payload AS BLOB))) FROM outbox) outboxJsonBytes
      `,
        )
        .get();
    } finally {
      db.close();
    }
    samples.push({
      phase,
      status: result.status,
      plannedRoleCalls: planner.calls.get(planner.itemId),
      reportCalls,
      recordWrites,
      rowMutations,
      transactions,
      storage,
      budget: await h.store.balance(h.mission.id),
    });
  }
  console.log(JSON.stringify({ revision, scenario, samples }, null, 2));
  if (scenario === 'success' || revision === 'current')
    assert.equal(samples.at(-1)?.status, 'completed');
  else {
    assert.equal(samples.at(-1)?.status, 'waiting');
    assert.equal(planner.calls.get(planner.itemId), 1);
  }
} finally {
  if (generated) await rm(generated);
  await h.close();
}
