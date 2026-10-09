import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { GuardClient } from '../src/adapters/ipc.js';
import { token, type Settings } from '../src/adapters/config.js';
export async function service(
  entry: 'guard' | 'factoryd',
  path: string,
  config: Settings,
  extra: Record<string, string> = {},
): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
  const args = [
    new URL(`../src/cli/${entry}.js`, import.meta.url).pathname,
    '--config',
    path,
    ...(entry === 'guard' ? ['start'] : []),
  ];
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH ?? '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr?.on('data', (chunk) => {
    errors += String(chunk);
  });
  const socket = entry === 'guard' ? config.guardSocket : config.runtimeSocket,
    credential = await token(
      entry === 'guard' ? config.guardTokenFile : config.runtimeTokenFile,
    );
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error(`Service exited: ${errors}`);
    try {
      await new GuardClient(socket, credential).call(
        entry === 'guard' ? 'info' : 'releaseStatus',
        null,
      );
      break;
    } catch (error) {
      await delay(20);
      if (n === 99) {
        child.kill('SIGKILL');
        throw new Error(`Service did not start: ${errors}; ${String(error)}`, {
          cause: error,
        });
      }
    }
  }
  return {
    child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    },
  };
}
