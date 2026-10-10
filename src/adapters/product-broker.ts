import { createServer, type Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Tree } from '../domain/tree.js';
import { ensure, FactoryError } from '../domain/invariants.js';
import { runProcess } from './process.js';
import {
  CALL_TIMEOUT_MS,
  MAX_CALLS,
  MAX_MESSAGE_BYTES,
  PRODUCT_PROTOCOL,
  productBytes,
  exactObject,
  productPath,
  productMessage,
  productRequest,
  productResponse,
  type ProductRequest,
} from './product-protocol.js';

export async function removeCheckContainer(name: string): Promise<void> {
  try {
    const removed = await runProcess('docker', ['rm', '--force', name], {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const remaining = await runProcess(
      'docker',
      ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`],
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    ensure(
      remaining.code === 0 &&
        remaining.stdout.trim() === '' &&
        (removed.code === 0 || removed.stderr.includes('No such container')),
      'uncertain',
      'Container removal not confirmed',
    );
  } catch {
    throw new FactoryError(
      'uncertain',
      `Check container stop unconfirmed: ${name}`,
    );
  }
}

async function invoke(
  request: ProductRequest,
  workspace: string,
  runtime: string,
  image: string | null,
  signal: AbortSignal,
) {
  ensure(!signal.aborted, 'cancelled', 'Product call cancelled');
  const options = {
    input: JSON.stringify(request),
    signal,
    timeoutMs: CALL_TIMEOUT_MS,
    maxBytes: MAX_MESSAGE_BYTES,
  };
  let output;
  if (image) {
    const name = `factory-product-${randomUUID()}`;
    try {
      // Create first: cancelling the attached CLI cannot leave a late, unidentified run.
      const created = await runProcess(
        'docker',
        [
          'create',
          '--pull',
          'never',
          '--name',
          name,
          '--label',
          'factory.product-check=product',
          '--interactive',
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
          '--tmpfs',
          '/factory:ro,nosuid,nodev,noexec,size=1m',
          '--workdir',
          '/workspace',
          '--mount',
          `type=bind,src=${workspace},dst=/workspace,readonly`,
          '--mount',
          `type=bind,src=${runtime},dst=/product,readonly`,
          image,
          '/bin/sh',
          '-c',
          'exec node /product/src/adapters/product-worker.js 3>&1 1>&2',
        ],
        { timeoutMs: CALL_TIMEOUT_MS },
      );
      ensure(
        created.code === 0,
        'isolation',
        'Product container creation failed',
      );
      output = await runProcess(
        'docker',
        ['start', '--attach', '--interactive', name],
        options,
      );
    } finally {
      await removeCheckContainer(name);
    }
  } else {
    // Same-UID children are only for managed development fixtures, never a hostile-code sandbox.
    output = await runProcess(
      process.execPath,
      [join(runtime, 'src/adapters/product-worker.js')],
      {
        ...options,
        responsePipe: true,
        env: { PATH: process.env.PATH ?? '', PRODUCT_ROOT: workspace },
      },
    );
  }
  ensure(
    output.stopped && output.code === 0,
    'product-exit',
    'Product worker exited abnormally',
  );
  const response = productResponse(
    productBytes(image ? output.stdoutBytes : output.responseBytes),
    request.id,
  );
  ensure(response.ok, 'product-error', 'Product import/call/value failed');
  return response;
}

export async function productBroker(
  root: string,
  workspace: string,
  runtime: string,
  tree: Tree,
  image: string | null,
  signal: AbortSignal,
) {
  const socketPath = join(root, 'p.sock');
  const controller = new AbortController();
  const callSignal = AbortSignal.any([signal, controller.signal]);
  const sockets = new Set<Socket>();
  const ids = new Set<string>();
  let failure: Error | undefined;
  let queue = Promise.resolve();
  const fail = (error: unknown) => {
    if (
      !failure ||
      (error instanceof FactoryError && error.code === 'uncertain')
    )
      failure =
        error instanceof Error ? error : new Error('Product broker failed');
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= MAX_CALLS) {
      fail(
        new FactoryError('product-protocol', 'Too many product connections'),
      );
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', fail);
    socket.setTimeout(CALL_TIMEOUT_MS, () =>
      socket.destroy(new FactoryError('timeout', 'Product request timed out')),
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES)
        socket.destroy(
          new FactoryError('product-protocol', 'Product request too large'),
        );
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      socket.setTimeout(0);
      queue = queue.then(async () => {
        let id = '';
        try {
          ensure(
            !failure && !callSignal.aborted,
            'cancelled',
            'Product broker stopped',
          );
          const request = productMessage(productBytes(Buffer.concat(chunks)));
          ensure(
            request &&
              typeof request === 'object' &&
              'id' in request &&
              typeof request.id === 'string',
            'product-protocol',
            'Product ID required',
          );
          id = request.id;
          ensure(
            /^[a-f0-9-]{36}$/.test(id) && !ids.has(id) && ids.size < MAX_CALLS,
            'product-protocol',
            'Duplicate or excessive product requests',
          );
          ids.add(id);
          let response;
          if ('source' in request) {
            const sourceRequest: unknown = request;
            exactObject(sourceRequest, ['protocol', 'id', 'module', 'source']);
            ensure(
              sourceRequest.protocol === PRODUCT_PROTOCOL &&
                sourceRequest.source === true &&
                typeof sourceRequest.module === 'string',
              'product-protocol',
              'Invalid source request',
            );
            productPath(sourceRequest.module);
            const file = tree[sourceRequest.module];
            ensure(file, 'product-path', 'Source not in candidate snapshot');
            const bytes = Buffer.from(file.content, 'base64');
            const source = bytes.toString('utf8');
            ensure(
              Buffer.from(source, 'utf8').equals(bytes),
              'product-value',
              'Source must be lossless UTF-8',
            );
            response = {
              protocol: PRODUCT_PROTOCOL,
              id,
              ok: true,
              value: source,
            };
          } else {
            productRequest(request);
            ensure(
              Object.hasOwn(tree, request.module),
              'product-path',
              'Module not in candidate snapshot',
            );
            response = await invoke(
              request,
              workspace,
              runtime,
              image,
              callSignal,
            );
          }
          const encoded = JSON.stringify(response);
          ensure(
            Buffer.byteLength(encoded) <= MAX_MESSAGE_BYTES,
            'product-protocol',
            'Product observation too large',
          );
          socket.end(encoded);
        } catch (error) {
          fail(error);
          socket.end(
            JSON.stringify({
              protocol: PRODUCT_PROTOCOL,
              id,
              ok: false,
              error: 'Product observation failed',
            }),
          );
        }
      });
    });
  });
  server.on('error', fail);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    failure: () => failure,
    close: async () => {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue;
    },
  };
}
