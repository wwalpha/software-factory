import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../tests/helpers.js';
import { service } from '../tests/services.js';
import { GuardClient } from '../src/adapters/ipc.js';
import { token } from '../src/adapters/config.js';
import { digest } from '../src/adapters/artifacts.js';
import type {
  MissionRevision,
  ResultBundle,
  Experiment,
} from '../src/domain/contracts.js';
const f = await fixture();
const guard = await service('guard', f.configPath, f.config),
  runtime = await service('factoryd', f.configPath, f.config);
try {
  const client = new GuardClient(
      f.config.runtimeSocket,
      await token(f.config.runtimeTokenFile),
    ),
    operator = new GuardClient(
      f.config.operatorSocket,
      await token(f.config.operatorTokenFile),
    );
  const results: ResultBundle[] = [];
  for (const profile of f.profiles) {
    const mission = await client.call<MissionRevision>('submit', {
      requirements: profile.acceptance.map((a) => a.description).join('\n'),
      profile,
    });
    await writeFile(
      join(f.root, `${profile.id}-mission.json`),
      JSON.stringify(mission, null, 2),
    );
    await writeFile(
      join(f.root, `${profile.id}-profile.json`),
      JSON.stringify(profile, null, 2),
    );
    await writeFile(
      join(f.root, `${profile.id}-requirements.txt`),
      mission.objective,
    );
    await operator.call('grant', {
      mission,
      grant: {
        id: `grant-${mission.id}`,
        caller: 'factoryd',
        projectId: profile.id,
        missionId: mission.id,
        operations: mission.delegation.operations,
        scope: mission.scope,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxUsd: mission.budget.maxUsd,
        missionDigest: digest(mission),
        releaseId: mission.factoryRelease,
      },
    });
    const result = await client.call<ResultBundle>('run', {
      id: mission.id,
      mode: 'fake',
    });
    if (result.status !== 'completed') throw Error(JSON.stringify(result));
    results.push(result);
  }
  const first = results[0];
  if (!first) throw Error('No results');
  const experiment = await client.call<Experiment>(
    'experimentCreate',
    first.missionId,
  );
  const evaluated = await client.call('experimentRun', {
    id: experiment.id,
    mode: 'fake',
  });
  const releases = await client.call<{ id: string; stage: string }[]>(
    'releaseStatus',
    null,
  );
  const canary = releases.find((r) => r.stage === 'canary');
  const rollback = canary ? await client.call('rollback', canary.id) : null;
  await writeFile(
    join(f.root, 'demo-results.json'),
    JSON.stringify({ results, evaluated, rollback }, null, 2),
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      mode: 'fake',
      config: f.configPath,
      resultFile: join(f.root, 'demo-results.json'),
      missions: results.map((r) => ({
        id: r.missionId,
        status: r.status,
        digest: r.artifact?.digest,
      })),
      experiment: evaluated,
      rollback,
    }),
  );
  // Keep the example state and artifacts for inspection; no product repository is changed.
  await readFile(join(f.root, 'demo-results.json'));
} finally {
  await runtime.stop();
  await guard.stop();
}
