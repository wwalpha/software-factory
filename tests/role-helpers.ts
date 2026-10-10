import assert from 'node:assert/strict';
import { join } from 'node:path';
import { harness, edits } from './helpers.js';
import { FakePlanner, FakeRunner } from '../src/adapters/fake.js';
import { Runtime } from '../src/application/runtime.js';
import { SqliteStore } from '../src/adapters/sqlite.js';
import { FactoryError } from '../src/domain/invariants.js';
import type { MissionRevision, WorkItem } from '../src/domain/contracts.js';
import type { RoleExecution } from '../src/ports/role-execution.js';

export class RolePlanner extends FakePlanner {
  calls = new Map<string, number>();
  failures = 1;
  error: unknown = new FactoryError(
    'rate-limited',
    'Transient provider rejection',
  );
  role: WorkItem['role'] = 'explorer';
  itemId = 'inspect-alpha';
  independent = false;
  reads = false;
  followupFailures = 0;
  override async plan(
    m: MissionRevision,
    revision: number,
    facts: unknown,
    signal: AbortSignal,
  ) {
    const plan = await super.plan(m, revision, facts, signal);
    const builder = plan.value.items[0];
    assert.ok(builder);
    const roleItem: WorkItem = {
      ...builder,
      id: this.itemId,
      role: this.role,
      budgetUsd: 0.2,
    };
    builder.dependsOn = [roleItem.id];
    plan.value.items.unshift(roleItem);
    plan.value.estimatedUsd += roleItem.budgetUsd;
    if (this.independent) {
      plan.value.items.unshift({
        ...roleItem,
        id: 'review-beta',
        role: 'reviewer',
      });
      plan.value.estimatedUsd += roleItem.budgetUsd;
    }
    return plan;
  }
  override async report(role: unknown, input: unknown, signal: AbortSignal) {
    let value = input;
    let followup = false;
    if (
      value &&
      typeof value === 'object' &&
      'authorizedReads' in value &&
      'input' in value
    ) {
      value = value.input;
      followup = true;
    }
    const response = await super.report(role, input, signal);
    if (value && typeof value === 'object' && 'item' in value) {
      const item = value.item as WorkItem;
      let key = item.id;
      if (followup) key += ':read';
      const count = (this.calls.get(key) ?? 0) + 1;
      this.calls.set(key, count);
      if (item.id === this.itemId) {
        let failures = this.failures;
        if (followup) failures = this.followupFailures;
        if (count <= failures) throw this.error;
        if (this.reads && !followup)
          response.value.reads.paths.push('range.ts');
      }
      response.value.facts = [`Persisted ${item.id} response`];
      response.usage = {
        certainty: 'measured',
        inputTokens: 10,
        outputTokens: 5,
        usd: 0.02,
      };
    }
    return response;
  }
}
export const roleHarness = async (planner = new RolePlanner()) => {
  const h = await harness(new FakeRunner(edits));
  let store = h.runtimeStore;
  let runtime = new Runtime(store, planner, h.port, 'fake');
  const profile = h.profiles[0];
  assert.ok(profile);
  profile.budget.maxAttempts = 1;
  const mission = await runtime.submit('repair with investigation', profile);
  const grant = await h.grant(mission);
  return {
    ...h,
    planner,
    mission,
    grantValue: grant,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    executions: async () =>
      (await store.list<RoleExecution>('role-execution')).map((r) => r.value),
    restart: async (alreadyClosed = false) => {
      if (!alreadyClosed) await store.close();
      store = await SqliteStore.open(join(h.config.runtimeRoot, 'runtime.db'));
      runtime = new Runtime(store, planner, h.port, 'fake');
    },
    close: async () => {
      await store.close();
      await h.guardStore.close();
      await h.cleanup();
    },
  };
};
