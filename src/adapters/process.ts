import { spawn } from 'node:child_process';
import { FactoryError } from '../domain/invariants.js';
export interface ProcessResult {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  stopped: boolean;
}
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    input?: string;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
      stdio: 'pipe',
      detached: true,
    });
    let stdout = '',
      stderr = '',
      failure: Error | undefined;
    const chunks: Buffer[] = [];
    function stop(reason: Error) {
      failure ??= reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH'))
            failure = e instanceof Error ? e : new Error('Kill failed');
        }
      }
    }
    const aborted = () =>
      stop(new FactoryError('cancelled', 'Process cancelled'));
    options.signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(
      () => stop(new FactoryError('timeout', 'Process timed out')),
      options.timeoutMs ?? 60000,
    );
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') {
        stdout += chunk.toString();
        chunks.push(chunk);
      } else stderr += chunk.toString();
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
        (options.maxBytes ?? 1024 * 1024)
      )
        stop(new FactoryError('output-limit', 'Process output exceeded limit'));
    };
    child.stdout.on('data', (c: Buffer) => collect(c, 'stdout'));
    child.stderr.on('data', (c: Buffer) => collect(c, 'stderr'));
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
        });
    });
    child.stdin.on('error', () => {
      /* Child may close input before exit; close handles the outcome. */
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) aborted();
  });
}
