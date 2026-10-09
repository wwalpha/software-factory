import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CheckPort } from '../ports/agents.js';
import type { ProjectProfile, CheckSpec } from '../domain/contracts.js';
import { ensure, safePath } from '../domain/invariants.js';
import { digest, type Tree, writeTree } from './artifacts.js';
import { runProcess } from './process.js';
export async function checkVersion(
  root: string,
  check: Pick<CheckSpec, 'files' | 'kind'>,
): Promise<string> {
  const files: Record<string, string> = {};
  for (const path of check.files) {
    ensure(safePath(path), 'check', 'Unsafe check path');
    files[path] = (await readFile(resolve(root, path))).toString('base64');
  }
  return digest({ kind: check.kind, files });
}
export class ProtectedChecks implements CheckPort {
  constructor(private dockerImage: string | null = null) {}
  async run(tree: Tree, profile: ProjectProfile, signal: AbortSignal) {
    const root = await mkdtemp(join(tmpdir(), 'factory-check-'));
    const workspace = join(root, 'workspace'),
      checks = join(root, 'checks');
    await writeTree(workspace, tree);
    await chmod(workspace, 0o755);
    await mkdir(checks);
    const results: { checkId: string; passed: boolean; detail: string }[] = [];
    try {
      for (const check of profile.checks) {
        ensure(
          (await checkVersion(profile.checkRoot, check)) === check.version,
          'check-tampered',
          'Protected check changed',
        );
        for (const path of check.files) {
          await mkdir(resolve(checks, path, '..'), { recursive: true });
          await writeFile(
            resolve(checks, path),
            await readFile(resolve(profile.checkRoot, path)),
            { mode: 0o444 },
          );
        }
        const payload = { kind: check.kind, files: check.files };
        let output;
        if (this.dockerImage) {
          const name = `factory-check-${randomUUID()}`;
          try {
            output = await runProcess(
              'docker',
              [
                'run',
                '--name',
                name,
                '--network',
                'none',
                '--read-only',
                '--cap-drop',
                'ALL',
                '--security-opt',
                'no-new-privileges',
                '--pids-limit',
                '128',
                '--memory',
                '512m',
                '--cpus',
                '1',
                '--user',
                '1000:1000',
                '--tmpfs',
                '/tmp:rw,nosuid,nodev,size=64m',
                '--mount',
                `type=bind,src=${workspace},dst=/workspace,readonly`,
                '--mount',
                `type=bind,src=${checks},dst=/checks,readonly`,
                this.dockerImage,
                'node',
                '/factory/dist/src/adapters/check-worker.js',
                JSON.stringify(payload),
              ],
              { signal, timeoutMs: 60000 },
            );
          } finally {
            const stopped = await runProcess('docker', ['rm', '--force', name]);
            ensure(
              stopped.code === 0,
              'uncertain',
              'Check container stop not confirmed',
            );
          }
        } else {
          output = await runProcess(
            process.execPath,
            [
              new URL('./check-worker.js', import.meta.url).pathname,
              JSON.stringify(payload),
            ],
            {
              env: {
                PATH: process.env.PATH ?? '',
                PRODUCT_ROOT: workspace,
                CHECK_ROOT: checks,
              },
              signal,
              timeoutMs: 60000,
            },
          );
        }
        let passed = false;
        try {
          const result: unknown = JSON.parse(output.stdout);
          passed =
            output.code === 0 &&
            typeof result === 'object' &&
            result !== null &&
            'passed' in result &&
            result.passed === true;
        } catch {
          passed = false;
        }
        results.push({
          checkId: check.id,
          passed,
          detail: passed
            ? 'Protected assertions passed'
            : 'Protected check failed or returned incomplete results',
        });
      }
      return results;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
