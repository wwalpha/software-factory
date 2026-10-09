import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Settings } from '../adapters/config.js';
import type { GuardPort } from '../ports/guard.js';
export interface DoctorReport {
  status: 'READY' | 'BLOCKED';
  mode: 'fake' | 'live';
  checks: { name: string; ok: boolean; detail: string }[];
}
export async function doctor(
  settings: Settings,
  guard: GuardPort,
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [
    {
      name: 'node',
      ok: process.versions.node === '24.21.0',
      detail: process.versions.node,
    },
  ];
  if (settings.mode === 'fake') {
    checks.push({
      name: 'isolation',
      ok: false,
      detail: 'Fake development mode is not a security boundary',
    });
    return { status: 'BLOCKED', mode: 'fake', checks };
  }
  try {
    const info = await guard.call<{
      development: boolean;
      uid: number;
      root: string;
      dockerReady: boolean;
      imageVerified: boolean;
      credentials: boolean;
      privatePaths: string[];
    }>('info', null);
    checks.push({
      name: 'guard-identity',
      ok:
        !info.development &&
        info.uid !== process.getuid?.() &&
        info.root === settings.guardRoot,
      detail: 'Separate OS identity required',
    });
    for (const path of info.privatePaths) {
      let denied = true;
      for (const permission of [constants.R_OK, constants.W_OK]) {
        try {
          await access(path, permission);
          denied = false;
        } catch (e) {
          if (!(e instanceof Error && 'code' in e && e.code === 'EACCES'))
            denied = false;
        }
      }
      checks.push({
        name: 'guard-private-storage',
        ok: denied,
        detail: denied
          ? 'Access denied by OS'
          : 'Access denial was not established',
      });
    }
    const socket = await stat(settings.guardSocket);
    checks.push({
      name: 'guard-socket-owner',
      ok: socket.uid === info.uid,
      detail: 'Socket must belong to Guard identity',
    });
    checks.push({
      name: 'docker',
      ok: info.dockerReady && info.imageVerified,
      detail: 'Guard must verify pinned image and run isolation probe',
    });
    checks.push({
      name: 'codex-auth',
      ok: info.credentials,
      detail: 'Dedicated Codex provider credential required',
    });
  } catch {
    checks.push({
      name: 'guard',
      ok: false,
      detail: 'Guard unavailable or failed verification',
    });
  }
  checks.push({
    name: 'responses-auth',
    ok: Boolean(process.env.OPENAI_API_KEY),
    detail: 'Responses authentication is separate from Codex',
  });
  checks.push({
    name: 'models',
    ok: Object.values(settings.models).every(
      (b) =>
        b.enabled &&
        b.verifiedAt !== null &&
        b.inputUsdPerMillion !== null &&
        b.outputUsdPerMillion !== null,
    ),
    detail: 'Explicitly verified and priced bindings required',
  });
  return {
    status: checks.every((c) => c.ok) ? 'READY' : 'BLOCKED',
    mode: 'live',
    checks,
  };
}
