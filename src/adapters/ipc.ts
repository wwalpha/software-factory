import { createConnection, createServer, type Server } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { ensure, FactoryError } from '../domain/invariants.js';
import type { GuardPort, OperationRequest } from '../ports/guard.js';
const MAX = 32 * 1024 * 1024;
export function authenticated(actual: unknown, expected: string): boolean {
  return (
    typeof actual === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export async function serve(
  socketPath: string,
  token: string,
  handle: (method: string, params: unknown) => Promise<unknown>,
  mode = 0o600,
): Promise<Server> {
  ensure(
    token.length >= 32,
    'auth',
    'IPC token must contain at least 32 characters',
  );
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    let data = '',
      consumed = false;
    socket.setTimeout(180000, () => socket.destroy());
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > MAX) {
        socket.destroy();
        return;
      }
      if (!consumed && data.includes('\n')) {
        consumed = true;
        void (async () => {
          try {
            const value: unknown = JSON.parse(
              data.slice(0, data.indexOf('\n')),
            );
            ensure(
              value &&
                typeof value === 'object' &&
                'token' in value &&
                'method' in value &&
                'params' in value,
              'ipc',
              'Malformed request',
            );
            ensure(
              authenticated(value.token, token),
              'auth',
              'Unauthenticated caller',
            );
            ensure(typeof value.method === 'string', 'ipc', 'Invalid method');
            socket.setTimeout(0);
            const result = await handle(value.method, value.params);
            socket.end(JSON.stringify({ ok: true, result }) + '\n');
          } catch (e) {
            socket.end(
              JSON.stringify({
                ok: false,
                code: e instanceof FactoryError ? e.code : 'internal',
                error:
                  e instanceof FactoryError ? e.message : 'Operation failed',
              }) + '\n',
            );
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, mode);
  return server;
}
export class GuardClient implements GuardPort {
  constructor(
    private socketPath: string,
    private token: string,
  ) {}
  call<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let data = '';
      socket.setTimeout(86460000, () =>
        socket.destroy(new Error('Guard timeout')),
      );
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({ method, params, token: this.token }) + '\n',
        ),
      );
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (Buffer.byteLength(data) > MAX)
          socket.destroy(new Error('IPC limit'));
      });
      socket.on('error', reject);
      socket.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (!result.ok) reject(new FactoryError(result.code, result.error));
          else resolve(result.result as T);
        } catch {
          reject(new FactoryError('ipc', 'Invalid Guard response'));
        }
      });
    });
  }
  operate<T>(request: OperationRequest): Promise<T> {
    return this.call('operate', request);
  }
}
