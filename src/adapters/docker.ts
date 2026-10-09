import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerPort } from '../ports/agents.js';
import type {
  Attempt,
  RoleRecipe,
  ModelBinding,
  RunnerFact,
} from '../domain/contracts.js';
import { runProcess } from './process.js';
import {
  readTree,
  writeTree,
  type Tree,
  treeDigest,
  validateCandidate,
} from './artifacts.js';
import { ensure } from '../domain/invariants.js';
import { contract } from './contracts.js';
import { failedFact } from './codex.js';
import { modelProxy } from './proxy.js';
export class DockerRunner implements RunnerPort {
  constructor(
    private image: string,
    private directory: string,
    private apiKey: string,
  ) {}
  async probe(): Promise<{
    dockerReady: boolean;
    imageVerified: boolean;
    credentials: boolean;
  }> {
    const credentials = this.apiKey.length > 0;
    try {
      const version = await runProcess(
        'docker',
        ['info', '--format', '{{.ServerVersion}}'],
        { timeoutMs: 10000 },
      );
      if (version.code !== 0)
        return { dockerReady: false, imageVerified: false, credentials };
      const pinned =
        /^sha256:[a-f0-9]{64}$/.test(this.image) ||
        /@sha256:[a-f0-9]{64}$/.test(this.image);
      if (!pinned)
        return { dockerReady: true, imageVerified: false, credentials };
      const code =
        "const fs=require('node:fs'); if(process.getuid()===0||['/var/run/docker.sock','/guard','/host-home','/workspace/.git'].some(p=>fs.existsSync(p)))process.exit(2); const os=require('node:os');if(Object.keys(os.networkInterfaces()).some(n=>n!=='lo'))process.exit(3); console.log('isolated')";
      const result = await runProcess(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--user',
          '1000:1000',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '64',
          '--memory',
          '256m',
          '--cpus',
          '1',
          this.image,
          'node',
          '-e',
          code,
        ],
        { timeoutMs: 20000 },
      );
      return {
        dockerReady: true,
        imageVerified: result.code === 0 && result.stdout.trim() === 'isolated',
        credentials,
      };
    } catch {
      return { dockerReady: false, imageVerified: false, credentials };
    }
  }
  private name(id: string) {
    ensure(/^[a-zA-Z0-9_.-]+$/.test(id), 'operation', 'Invalid operation ID');
    return `factory-${id}`;
  }
  async stop(id: string): Promise<boolean> {
    await runProcess('docker', ['rm', '--force', this.name(id)]);
    return this.isStopped(id);
  }
  async isStopped(id: string): Promise<boolean> {
    const info = await runProcess('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      this.name(id),
    ]);
    if (info.code !== 0) {
      const list = await runProcess('docker', [
        'ps',
        '-a',
        '--format',
        '{{.Names}}',
      ]);
      return (
        list.code === 0 && !list.stdout.split('\n').includes(this.name(id))
      );
    }
    return info.stdout.trim() === 'false';
  }
  async run(
    attempt: Attempt,
    tree: Tree,
    prompt: string,
    recipe: RoleRecipe,
    binding: ModelBinding,
    signal: AbortSignal,
  ): Promise<{ fact: RunnerFact; tree: Tree }> {
    ensure(
      binding.enabled && binding.verifiedAt,
      'binding',
      'Codex binding unverified',
    );
    ensure(
      /^sha256:[a-f0-9]{64}$/.test(this.image) ||
        /@sha256:[a-f0-9]{64}$/.test(this.image),
      'image',
      'Worker image must be pinned by digest',
    );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.directory, 'attempt-'));
    const workspace = join(root, 'workspace'),
      ipc = join(root, 'ipc');
    await writeTree(workspace, tree);
    await chmod(workspace, 0o755);
    await mkdir(ipc, { mode: 0o755 });
    const uid = process.getuid?.() ?? 1000,
      gid = process.getgid?.() ?? 1000;
    ensure(uid !== 0, 'isolation', 'Guard must run as nonroot');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const combined = AbortSignal.any([signal, controller.signal]);
    const proxy = await modelProxy(
      join(ipc, 'model.sock'),
      this.apiKey,
      binding,
      8,
      combined,
      recipe.budgetUsd,
    );
    let stopped = false;
    try {
      const output = await runProcess(
        'docker',
        [
          'run',
          '--name',
          this.name(attempt.operationId),
          '--init',
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
          '1g',
          '--cpus',
          '1',
          '--user',
          `${uid}:${gid}`,
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=128m',
          '--workdir',
          '/workspace',
          '--mount',
          `type=bind,src=${workspace},dst=/workspace`,
          '--mount',
          `type=bind,src=${ipc},dst=/ipc,readonly`,
          this.image,
          'node',
          '/factory/dist/src/adapters/codex-worker.js',
        ],
        {
          input: JSON.stringify({ attempt, prompt, recipe, binding }),
          signal: combined,
          timeoutMs: 130000,
        },
      );
      stopped = await this.stop(attempt.operationId);
      ensure(stopped, 'uncertain', 'Container stop not confirmed');
      const observed = contract('RunnerFact', JSON.parse(output.stdout).fact);
      ensure(output.code === 0, 'runner', 'Worker failed');
      if (observed.outcome !== 'completed')
        return { tree, fact: { ...observed, stopped: true } };
      const result = contract('AgentClaim', JSON.parse(output.stdout).claim);
      const candidate = await readTree(workspace);
      validateCandidate(tree, candidate, recipe.scope);
      return {
        tree: candidate,
        fact: {
          ...observed,
          stopped: true,
          handoff: {
            attemptId: attempt.id,
            epoch: attempt.epoch,
            baseDigest: attempt.baseDigest,
            candidateDigest: treeDigest(candidate),
            claim: result,
          },
        },
      };
    } catch {
      stopped = await this.stop(attempt.operationId);
      return {
        tree,
        fact: failedFact(
          attempt,
          stopped
            ? signal.aborted
              ? 'cancelled'
              : controller.signal.aborted
                ? 'timeout'
                : 'failed'
            : 'uncertain',
          'Worker failed or was interrupted; raw output omitted',
          stopped,
        ),
      };
    } finally {
      clearTimeout(timeout);
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      if (stopped) await rm(root, { recursive: true, force: true });
    }
  }
}
