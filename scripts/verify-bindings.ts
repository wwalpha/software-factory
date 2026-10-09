import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../src/adapters/config.js';
import { ResponsesPlanner } from '../src/adapters/responses.js';
import { DockerRunner } from '../src/adapters/docker.js';
import { recipes } from '../src/adapters/recipes.js';
import { SqliteStore } from '../src/adapters/sqlite.js';
import { digest, treeDigest } from '../src/adapters/artifacts.js';
import { ensure } from '../src/domain/invariants.js';
import type { Attempt } from '../src/domain/contracts.js';
const path = process.env.FACTORY_CONFIG,
  limit = Number(process.env.FACTORY_PROBE_MAX_USD);
if (
  !path ||
  !process.env.OPENAI_API_KEY ||
  !process.env.CODEX_PROVIDER_API_KEY ||
  !(limit >= 0.4)
) {
  console.log(
    JSON.stringify({
      status: 'BLOCKED',
      reason:
        'Explicit configuration, separate provider credentials and at least $0.40 probe budget required',
    }),
  );
  process.exitCode = 3;
} else {
  const settings = await loadSettings(path);
  ensure(settings.workerImage, 'image', 'Pinned worker image required');
  const original = await readFile(path, 'utf8'),
    id = randomUUID();
  const store = await SqliteStore.open(
    join(settings.guardRoot, 'binding-probes.db'),
  );
  try {
    const bindingDate = new Date().toISOString();
    const candidate = structuredClone(settings.models);
    for (const name of ['reasoner', 'scout', 'engineer'] as const) {
      candidate[name].enabled = true;
      candidate[name].verifiedAt = bindingDate;
    }
    const planner = new ResponsesPlanner(candidate, process.env.OPENAI_API_KEY);
    for (const name of ['reasoner', 'scout'] as const) {
      await store.reserve(`${id}-${name}`, id, 0.1, limit);
      const out = await planner.structured(
        'MissionDraft',
        { objective: 'Return objective probe, empty nonGoals and ambiguities' },
        candidate[name],
        AbortSignal.timeout(60000),
      );
      await store.settle(`${id}-${name}`, out.usage.usd);
    }
    const runner = new DockerRunner(
      settings.workerImage,
      join(settings.guardRoot, 'binding-work'),
      process.env.CODEX_PROVIDER_API_KEY,
    );
    const probe = await runner.probe();
    ensure(probe.imageVerified, 'isolation', 'Isolation probe failed');
    const recipe = recipes().find((r) => r.role === 'builder');
    ensure(recipe, 'recipe', 'No builder recipe');
    const tree = {};
    const attempt: Attempt = {
      id,
      missionId: id,
      workItemId: 'binding-probe',
      epoch: 1,
      leaseUntil: new Date(Date.now() + 120000).toISOString(),
      baseDigest: treeDigest(tree),
      operationId: id,
      state: 'running',
      waiting: null,
      usage: {
        certainty: 'unknown',
        inputTokens: null,
        outputTokens: null,
        usd: null,
      },
      stopped: false,
    };
    await store.reserve(`${id}-engineer`, id, recipe.budgetUsd, limit);
    const out = await runner.run(
      attempt,
      tree,
      'Return a valid AgentClaim describing a connectivity probe. Do not create files.',
      recipe,
      candidate.engineer,
      AbortSignal.timeout(120000),
    );
    await store.settle(`${id}-engineer`, out.fact.usage.usd);
    ensure(
      out.fact.outcome === 'completed' && out.fact.stopped,
      'binding',
      'Actual Codex model probe failed',
    );
    ensure(
      (await readFile(path, 'utf8')) === original,
      'config',
      'Configuration changed during verification',
    );
    await writeFile(
      path,
      JSON.stringify({ ...settings, models: candidate }, null, 2) + '\n',
    );
    await store.commit(
      [
        {
          kind: 'binding-proof',
          id,
          expectedVersion: 0,
          value: {
            models: candidate,
            at: bindingDate,
            digest: digest(candidate),
          },
        },
      ],
      { id, topic: 'binding.verified', payload: { id } },
    );
    console.log(
      JSON.stringify({
        status: 'PASS',
        verifiedAt: bindingDate,
        models: Object.fromEntries(
          Object.entries(candidate).map(([key, b]) => [key, b.model]),
        ),
      }),
    );
  } finally {
    await store.close();
  }
}
