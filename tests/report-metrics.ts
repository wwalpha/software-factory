// Same controlled inputs and real SQLite/Guard/Runner, varying only Runtime source.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import ts from 'typescript';
import { Runtime } from '../src/application/runtime.js';
import { runProcess } from '../src/adapters/process.js';
import { setup, metrics, HandoffPlanner } from './report-helpers.js';
const revision = process.argv[2] ?? 'current';
const scenario = process.argv[3] ?? 'dependencies';
assert.ok(['dependencies', 'diagnosis'].includes(scenario));
let generated: URL | undefined;
let RuntimeClass = Runtime;
try {
  if (revision !== 'current') {
    const source = await runProcess('git', [
      'show',
      `${revision}:src/application/runtime.ts`,
    ]);
    assert.equal(source.code, 0, source.stderr);
    generated = new URL(
      `../src/application/runtime-report-probe-${randomUUID()}.js`,
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
  const planner = new HandoffPlanner();
  planner.pausePlan = scenario === 'diagnosis';
  const h = await setup(planner, scenario === 'diagnosis', [], RuntimeClass);
  try {
    const result = await h.runtime.run(h.mission.id, 'fake');
    console.log(
      JSON.stringify({
        revision,
        scenario,
        status: result.status,
        ...(await metrics(h)),
      }),
    );
    if (scenario === 'dependencies') assert.equal(result.status, 'completed');
    else assert.equal(result.status, 'waiting');
  } finally {
    await h.close();
  }
} finally {
  if (generated) await rm(generated);
}
