import { loadSettings, token } from '../src/adapters/config.js';
import { doctor } from '../src/application/doctor.js';
import { GuardClient } from '../src/adapters/ipc.js';
const path = process.env.FACTORY_CONFIG,
  id = process.env.FACTORY_LIVE_MISSION;
if (!path || !id || !(Number(process.env.FACTORY_LIVE_BUDGET_USD) > 0)) {
  console.log(
    JSON.stringify({
      status: 'BLOCKED',
      reason:
        'Set FACTORY_CONFIG, an operator-granted FACTORY_LIVE_MISSION and explicit positive FACTORY_LIVE_BUDGET_USD',
    }),
  );
  process.exitCode = 3;
} else {
  const settings = await loadSettings(path);
  const report = await doctor(
    settings,
    new GuardClient(settings.guardSocket, await token(settings.guardTokenFile)),
  );
  if (settings.mode !== 'live' || report.status !== 'READY') {
    console.log(JSON.stringify(report));
    process.exitCode = 3;
  } else {
    const client = new GuardClient(
      settings.runtimeSocket,
      await token(settings.runtimeTokenFile),
    );
    const status = await client.call<{
      mission: { budget: { maxUsd: number } };
    }>('status', id);
    if (
      status.mission.budget.maxUsd > Number(process.env.FACTORY_LIVE_BUDGET_USD)
    ) {
      console.log(
        JSON.stringify({
          status: 'BLOCKED',
          reason: 'Mission budget exceeds explicit live-test cap',
        }),
      );
      process.exitCode = 3;
    } else {
      const result = await client.call<{ status: string }>('run', {
        id,
        mode: 'live',
      });
      console.log(JSON.stringify(result));
      process.exitCode =
        result.status === 'completed' ? 0 : result.status === 'waiting' ? 4 : 2;
    }
  }
}
