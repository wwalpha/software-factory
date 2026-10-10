import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { FactoryError } from '../domain/invariants.js';
export interface ProcessResult {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  stopped: boolean;
  responseBytes: Buffer;
}
export const runProcess = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    input?: string;
    responsePipe?: boolean;
  } = {},
): Promise<ProcessResult> => {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env ?? {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
      detached: true,
    };
    let stdio: 'pipe' | ['pipe', 'pipe', 'pipe', 'pipe'];
    if (options.responsePipe) stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
    else stdio = 'pipe';
    const child = spawn(command, args, { ...spawnOptions, stdio });
    let stdout = '',
      stderr = '',
      bytes = 0,
      stopping = false,
      failure: Error | undefined;
    const chunks: Buffer[] = [];
    const responses: Buffer[] = [];
    const stop = (reason: Error) => {
      failure ??= reason;
      if (stopping) return;
      stopping = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH'))
            failure = new FactoryError(
              'uncertain',
              'Process group stop not confirmed',
            );
        }
      }
    };
    const aborted = () =>
      stop(new FactoryError('cancelled', 'Process cancelled'));
    options.signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(
      () => stop(new FactoryError('timeout', 'Process timed out')),
      options.timeoutMs ?? 60000,
    );
    const collect = (
      chunk: Buffer,
      stream: 'stdout' | 'stderr' | 'response',
    ) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) {
        stop(new FactoryError('output-limit', 'Process output exceeded limit'));
        return;
      }
      if (stream === 'stdout') {
        stdout += chunk.toString();
        chunks.push(chunk);
      } else if (stream === 'stderr') stderr += chunk.toString();
      else responses.push(chunk);
    };
    child.stdout.on('data', (c: Buffer) => collect(c, 'stdout'));
    child.stderr.on('data', (c: Buffer) => collect(c, 'stderr'));
    if (options.responsePipe)
      (child.stdio[3] as Readable).on('data', (c: Buffer) =>
        collect(c, 'response'),
      );
    child.on('error', (e) => {
      failure = e;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      if (failure) reject(failure);
      else
        resolve({
          code: code ?? -1,
          stdout,
          stdoutBytes: Buffer.concat(chunks),
          stderr,
          stopped: true,
          responseBytes: Buffer.concat(responses),
        });
    });
    child.stdin.on('error', () => {
      /* Child may close input before exit; close handles the outcome. */
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) aborted();
  });
};
