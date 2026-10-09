import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { service } from './services.js';
import { token } from '../src/adapters/config.js';
import { GuardClient } from '../src/adapters/ipc.js';
import { digest } from '../src/adapters/artifacts.js';
import { runProcess } from '../src/adapters/process.js';
import type { MissionRevision, ResultBundle } from '../src/domain/contracts.js';
test('real Guard and factoryd processes use independent authenticated IPC and durable results', async () => {
  const f = await fixture();
  const guard = await service('guard', f.configPath, f.config),
    runtime = await service('factoryd', f.configPath, f.config);
  try {
    const api = new GuardClient(
        f.config.runtimeSocket,
        await token(f.config.runtimeTokenFile),
      ),
      op = new GuardClient(
        f.config.operatorSocket,
        await token(f.config.operatorTokenFile),
      );
    await assert.rejects(
      new GuardClient(f.config.guardSocket, 'x'.repeat(64)).call('info', null),
    );
    await assert.rejects(
      new GuardClient(
        f.config.guardSocket,
        await token(f.config.guardTokenFile),
      ).call('grant', {}),
    );
    const profile = f.profiles[0];
    assert.ok(profile);
    const mission = await api.call<MissionRevision>('submit', {
      requirements: 'Fix clamp boundaries',
      profile,
    });
    const grant = {
      id: `grant-${mission.id}`,
      caller: 'factoryd',
      projectId: mission.projectId,
      missionId: mission.id,
      operations: mission.delegation.operations,
      scope: mission.scope,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxUsd: mission.budget.maxUsd,
      missionDigest: digest(mission),
      releaseId: mission.factoryRelease,
    };
    await op.call('grant', { grant, mission });
    const result = await api.call<ResultBundle>('run', {
      id: mission.id,
      mode: 'fake',
    });
    assert.equal(result.status, 'completed');
    assert.ok(result.completionSignature);
    await runtime.stop();
    const restarted = await service('factoryd', f.configPath, f.config);
    try {
      assert.deepEqual(await api.call('result', mission.id), result);
    } finally {
      await restarted.stop();
    }
    const cli = await runProcess(process.execPath, [
      'dist/src/cli/factory.js',
      '--config',
      f.configPath,
      'doctor',
    ]);
    assert.equal(cli.code, 3);
    assert.equal(JSON.parse(cli.stdout).status, 'BLOCKED');
  } finally {
    await runtime.stop();
    await guard.stop();
    await f.cleanup();
  }
});
test('Guard crash after external effect never blindly replays operation', async () => {
  const f = await fixture();
  const guard = await service('guard', f.configPath, f.config, {
    FACTORY_FAULT: 'after-effect',
  });
  try {
    const api = new GuardClient(
      f.config.guardSocket,
      await token(f.config.guardTokenFile),
    );
    const op = new GuardClient(
      f.config.operatorSocket,
      await token(f.config.operatorTokenFile),
    );
    const p = f.profiles[0];
    assert.ok(p);
    const mission: MissionRevision = {
      id: randomUUID(),
      revision: 1,
      parentRevision: null,
      objective: 'repair',
      nonGoals: [],
      projectId: p.id,
      taskType: p.taskType,
      scope: p.scope,
      acceptance: p.acceptance,
      delegation: p.delegation,
      budget: p.budget,
      delivery: 'sealed-tree',
      factoryRelease: 'baseline',
      createdAt: new Date().toISOString(),
    };
    const grant = {
      id: 'g',
      caller: 'factoryd',
      projectId: p.id,
      missionId: mission.id,
      operations: mission.delegation.operations,
      scope: mission.scope,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxUsd: 10,
      missionDigest: digest(mission),
      releaseId: 'baseline',
    };
    await op.call('grant', { mission, grant });
    const request = {
      id: randomUUID(),
      grantId: 'g',
      mission,
      type: 'snapshot',
      targetDigest: digest('snapshot'),
      amount: 0.1,
      payload: {},
    };
    const closed = once(guard.child, 'close');
    await assert.rejects(api.call('operate', request));
    await closed;
    const restarted = await service('guard', f.configPath, f.config);
    try {
      const record = await api.call<{ state: string }>(
        'operationStatus',
        request.id,
      );
      assert.equal(record.state, 'uncertain');
      await assert.rejects(api.call('operate', request));
      const recovery = await api.call<{ stopped: boolean; state: string }>(
        'reconcile',
        request.id,
      );
      assert.equal(recovery.stopped, true);
      assert.equal(recovery.state, 'uncertain');
    } finally {
      await restarted.stop();
    }
  } finally {
    await guard.stop();
    await f.cleanup();
  }
});
test('timeout and cancellation terminate descendant process groups', async () => {
  const f = await fixture();
  try {
    const pidfile = join(f.root, 'child.pid'),
      script = join(f.root, 'spawn.mjs');
    await writeFile(
      script,
      `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidfile)},String(child.pid));setInterval(()=>{},1000);`,
    );
    await assert.rejects(
      runProcess(process.execPath, [script], { timeoutMs: 300 }),
      /timed out/,
    );
    const pid = Number(await readFile(pidfile, 'utf8'));
    assert.throws(() => process.kill(pid, 0));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      runProcess(process.execPath, [script], {
        signal: controller.signal,
        timeoutMs: 3000,
      }),
      /cancelled/,
    );
  } finally {
    await f.cleanup();
  }
});
