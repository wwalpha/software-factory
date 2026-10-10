import { mkdtemp, rm, readFile, chmod, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckPort } from '../ports/agents.js';
import type { ProjectProfile, CheckSpec } from '../domain/contracts.js';
import { ensure, safePath, FactoryError } from '../domain/invariants.js';
import { digest, type Tree, writeTree, readTree } from './artifacts.js';
import { runProcess } from './process.js';
import { productBroker, removeCheckContainer } from './product-broker.js';
import { PRODUCT_PROTOCOL } from './product-protocol.js';

const runtimeFiles = [
  'adapters/checks.js',
  'adapters/check-worker.js',
  'adapters/evaluator-loader.js',
  'adapters/product-call.js',
  'adapters/product-protocol.js',
  'adapters/product-worker.js',
  'adapters/product-broker.js',
  'adapters/process.js',
  'adapters/artifacts.js',
  'domain/invariants.js',
];
const runtimeSnapshot = async (): Promise<Tree> => {
  const tree: Tree = {};
  for (const file of runtimeFiles)
    tree[`src/${file}`] = {
      content: (
        await readFile(new URL(`../${file}`, import.meta.url))
      ).toString('base64'),
      executable: false,
    };
  return tree;
};
const checkSnapshot = async (
  root: string,
  check: Pick<CheckSpec, 'files' | 'kind'>,
): Promise<Tree> => {
  const snapshot = await readTree(root);
  const files: Tree = {};
  ensure(
    check.files.length > 0 && new Set(check.files).size === check.files.length,
    'check',
    'Nonempty unique check files required',
  );
  for (const path of check.files) {
    ensure(
      safePath(path) && Object.hasOwn(snapshot, path),
      'check',
      'Unsafe or missing check path',
    );
    files[path] = snapshot[path]!;
  }
  return files;
};
const version = (
  check: Pick<CheckSpec, 'files' | 'kind'>,
  files: Tree,
  runtime: Tree,
) => {
  const contents = Object.fromEntries(
    Object.entries(files).map(([path, file]) => [path, file.content]),
  );
  return digest({
    kind: check.kind,
    files: contents,
    evaluator: PRODUCT_PROTOCOL,
    runtime,
  });
};
export const checkVersion = async (
  root: string,
  check: Pick<CheckSpec, 'files' | 'kind'>,
): Promise<string> => {
  return version(
    check,
    await checkSnapshot(root, check),
    await runtimeSnapshot(),
  );
};
export class ProtectedChecks implements CheckPort {
  constructor(private dockerImage: string | null = null) {}
  get dockerIsolated() {
    return this.dockerImage !== null;
  }
  async run(tree: Tree, profile: ProjectProfile, signal: AbortSignal) {
    tree = structuredClone(tree);
    ensure(
      profile.checks.length > 0 &&
        new Set(profile.checks.map((check) => check.id)).size ===
          profile.checks.length,
      'check',
      'Nonempty unique registered checks required',
    );
    if (this.dockerImage)
      ensure(
        /^sha256:[a-f0-9]{64}$/.test(this.dockerImage),
        'isolation',
        'Pinned product image ID required',
      );
    const root = await mkdtemp(join(tmpdir(), 'factory-check-'));
    const workspace = join(root, 'workspace');
    const results: { checkId: string; passed: boolean; detail: string }[] = [];
    try {
      await writeTree(workspace, tree, true);
      const runtime = await runtimeSnapshot();
      await writeTree(join(root, 'evaluator'), runtime, true);
      const productRuntime = Object.fromEntries(
        [
          'adapters/product-worker.js',
          'adapters/product-protocol.js',
          'domain/invariants.js',
        ].map((file) => [`src/${file}`, runtime[`src/${file}`]!]),
      ) as Tree;
      await writeTree(join(root, 'product'), productRuntime, true);
      for (const [index, check] of profile.checks.entries()) {
        ensure(!signal.aborted, 'cancelled', 'Check cancelled');
        const files = await checkSnapshot(profile.checkRoot, check);
        ensure(
          version(check, files, runtime) === check.version,
          'check-tampered',
          'Protected check/evaluator changed; operator migration and re-registration required',
        );
        const checks = join(root, `checks-${index}`);
        await writeTree(checks, files, true);
        const payload = {
          kind: check.kind,
          files: check.files,
          compiler: '',
        };
        if (this.dockerImage)
          payload.compiler = '/factory/node_modules/typescript/bin/tsc';
        else
          payload.compiler = new URL(
            '../../../node_modules/typescript/bin/tsc',
            import.meta.url,
          ).pathname;
        let output;
        let productFailed = false;
        if (check.kind === 'node-test') {
          const broker = await productBroker(
            root,
            workspace,
            join(root, 'product'),
            tree,
            this.dockerImage,
            signal,
          );
          let evaluatorFailure: unknown;
          try {
            output = await runProcess(
              process.execPath,
              [
                join(root, 'evaluator/src/adapters/check-worker.js'),
                JSON.stringify(payload),
              ],
              {
                env: {
                  PATH: process.env.PATH ?? '',
                  CHECK_ROOT: checks,
                  CHECK_FILES: JSON.stringify(check.files),
                  PRODUCT_CALL_SOCKET: broker.socketPath,
                },
                signal,
                timeoutMs: 60000,
              },
            );
          } catch (error) {
            evaluatorFailure = error;
          } finally {
            await broker.close();
          }
          const failure = broker.failure();
          if (failure instanceof FactoryError && failure.code === 'uncertain')
            throw failure;
          if (evaluatorFailure) throw evaluatorFailure;
          if (failure) {
            if (
              failure instanceof FactoryError &&
              failure.code === 'product-error'
            )
              productFailed = true;
            else throw failure;
          }
        } else if (this.dockerImage) {
          const name = `factory-check-${randomUUID()}`;
          try {
            output = await runProcess(
              'docker',
              [
                'create',
                '--pull',
                'never',
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
                `type=bind,src=${join(root, 'evaluator')},dst=/trusted,readonly`,
                this.dockerImage,
                'node',
                '/trusted/src/adapters/check-worker.js',
                JSON.stringify(payload),
              ],
              { timeoutMs: 10000 },
            );
            ensure(
              output.code === 0,
              'isolation',
              'Typecheck container creation failed',
            );
            output = await runProcess('docker', ['start', '--attach', name], {
              signal,
              timeoutMs: 60000,
            });
          } finally {
            await removeCheckContainer(name);
          }
        } else {
          output = await runProcess(
            process.execPath,
            [
              join(root, 'evaluator/src/adapters/check-worker.js'),
              JSON.stringify(payload),
            ],
            {
              env: { PATH: process.env.PATH ?? '', PRODUCT_ROOT: workspace },
              signal,
              timeoutMs: 60000,
            },
          );
        }
        ensure(output, 'check', 'Evaluator outcome missing');
        ensure(
          !signal.aborted,
          'cancelled',
          'Check cancelled before acceptance',
        );
        let passed = false;
        try {
          const result: unknown = JSON.parse(
            output.stdoutBytes.toString('utf8'),
          );
          passed =
            !productFailed &&
            output.code === 0 &&
            output.stopped &&
            typeof result === 'object' &&
            result !== null &&
            Object.keys(result).length === 1 &&
            'passed' in result &&
            result.passed === true;
        } catch {
          passed = false;
        }
        const result = {
          checkId: check.id,
          passed,
          detail: 'Protected check failed or returned incomplete results',
        };
        if (passed) {
          if (check.kind === 'node-test')
            result.detail =
              'Protected assertions passed via external product calls';
          else result.detail = 'Trusted compiler passed';
        }
        results.push(result);
      }
      return results;
    } finally {
      // Read-only snapshots must be made removable without changing the operator originals.
      const writable = async (path: string): Promise<void> => {
        await chmod(path, 0o700);
        for (const entry of await readdir(path, { withFileTypes: true }))
          if (entry.isDirectory()) await writable(join(path, entry.name));
      };
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  }
}
