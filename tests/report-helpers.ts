import assert from 'node:assert/strict';
import { join } from 'node:path';
import { harness, edits } from './helpers.js';
import { FakePlanner, FakeRunner } from '../src/adapters/fake.js';
import { Runtime } from '../src/application/runtime.js';
import { SqliteStore } from '../src/adapters/sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { FactoryError } from '../src/domain/invariants.js';
import type {
  MissionRevision,
  WorkItem,
  RoleReport,
} from '../src/domain/contracts.js';
import type { RoleExecution } from '../src/ports/role-execution.js';

export class HandoffPlanner extends FakePlanner {
  facts: unknown[] = [];
  planInputs: unknown[] = [];
  inputs: { role: unknown; input: unknown }[] = [];
  sourceId = 'survey-limits';
  nextId = 'design-negative-case';
  sourceRole: WorkItem['role'] = 'explorer';
  fact = 'Lower bounds are absent from the implementation.';
  diagnosis =
    'The protected negative-input observation still violates the lower bound.';
  reportValue: Partial<RoleReport> = {};
  pausePlan = false;
  override async plan(
    m: MissionRevision,
    r: number,
    facts: unknown,
    signal: AbortSignal,
  ) {
    this.facts.push(structuredClone(facts));
    this.planInputs.push(structuredClone({ mission: m, revision: r, facts }));
    if (r > 0 && this.pausePlan)
      throw new FactoryError('rate-limited', 'Controlled planner pause');
    const response = await super.plan(m, r, facts, signal);
    const builder = response.value.items[0];
    assert.ok(builder);
    builder.instruction = 'Repair the function within the accepted scope.';
    if (r === 0) {
      const source: WorkItem = {
        ...builder,
        id: this.sourceId,
        role: this.sourceRole,
        dependsOn: [],
      };
      const next: WorkItem = {
        ...builder,
        id: this.nextId,
        role: 'test-designer',
        dependsOn: [source.id],
      };
      const unrelated: WorkItem = { ...source, id: 'unrelated-survey' };
      builder.dependsOn = [next.id];
      response.value.items.unshift(source, unrelated, next);
      response.value.estimatedUsd += 0.6;
    }
    return response;
  }
  override async report(role: unknown, input: unknown, signal: AbortSignal) {
    this.inputs.push({ role, input: structuredClone(input) });
    const response = await super.report(role, input, signal);
    if (input && typeof input === 'object' && 'item' in input) {
      const item = input.item as WorkItem;
      response.value.facts = [`Output of ${item.id}`];
      if (item.id === this.sourceId)
        response.value = {
          ...response.value,
          facts: [this.fact],
          ...this.reportValue,
        };
      if (item.id === 'unrelated-survey')
        response.value.facts = ['UNRELATED OUTPUT'];
    } else if (role === 'failure-analyst')
      response.value.facts = [this.diagnosis];
    else
      response.value.facts = [`Initial or final ${String(role)} observations`];
    return response;
  }
}

export const setup = async (
  planner = new HandoffPlanner(),
  omitFirst = false,
  secrets: string[] = [],
  RuntimeClass = Runtime,
) => {
  const runner = new FakeRunner(edits, omitFirst);
  const prompts: string[] = [];
  const run = runner.run.bind(runner);
  runner.run = async (...args) => {
    prompts.push(args[2]);
    return run(...args);
  };
  const h = await harness(runner);
  let store = h.runtimeStore;
  let runtime = new RuntimeClass(store, planner, h.port, 'fake', secrets);
  const profile = h.profiles[0];
  assert.ok(profile);
  const mission = await runtime.submit(
    'Repair numeric bounds with prior research',
    profile,
  );
  await h.grant(mission);
  return {
    ...h,
    planner,
    prompts,
    mission,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    restart: async () => {
      await store.close();
      store = await SqliteStore.open(join(h.config.runtimeRoot, 'runtime.db'));
      runtime = new RuntimeClass(store, planner, h.port, 'fake', secrets);
    },
    close: async () => {
      await store.close();
      await h.guardStore.close();
      await h.cleanup();
    },
  };
};

export const metrics = async (h: Awaited<ReturnType<typeof setup>>) => {
  const rows = await h.store.list<RoleExecution>('role-execution');
  const db = new DatabaseSync(join(h.config.runtimeRoot, 'runtime.db'), {
    readOnly: true,
  });
  let storage;
  try {
    storage = db
      .prepare(
        `SELECT (SELECT SUM(length(CAST(value AS BLOB))) FROM records) recordJsonBytes, (SELECT SUM(length(CAST(payload AS BLOB))) FROM outbox) outboxJsonBytes`,
      )
      .get();
  } finally {
    db.close();
  }
  return {
    storage,
    reportStorageBytes: Buffer.byteLength(
      JSON.stringify(rows.map((r) => r.value)),
    ),
    builderInputBytes: h.prompts.map((p) => Buffer.byteLength(p)),
    plannerFactsBytes: h.planner.facts.map((f) =>
      Buffer.byteLength(JSON.stringify(f)),
    ),
    plannerInputBytes: h.planner.planInputs.map((input) =>
      Buffer.byteLength(JSON.stringify(input)),
    ),
    plannerInheritedReports: h.planner.facts.map(
      (f) =>
        (JSON.stringify(f).match(/"untrusted-model-report"/g) ?? []).length,
    ),
    roleCalls: h.planner.inputs.length,
    inheritedReports: h.prompts.map(
      (p) => (p.match(/"untrusted-model-report"/g) ?? []).length,
    ),
  };
};
