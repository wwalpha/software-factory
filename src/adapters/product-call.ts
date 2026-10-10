import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ensure } from '../domain/invariants.js';
import {
  MAX_MESSAGE_BYTES,
  PRODUCT_PROTOCOL,
  productBytes,
  productPath,
  productRequest,
  productResponse,
  type ProductValue,
} from './product-protocol.js';

const observation = async (
  request: unknown,
  id: string,
): Promise<ProductValue> => {
  const socketPath = process.env.PRODUCT_CALL_SOCKET;
  ensure(
    socketPath,
    'check-migration',
    'Use the registered external-product evaluator',
  );
  const response = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.setTimeout(60000, () =>
      socket.destroy(new Error('Product broker timed out')),
    );
    socket.on('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES)
        socket.destroy(new Error('Product observation too large'));
      else chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const result = productResponse(productBytes(response), id);
  if (!result.ok) ensure(result.ok, 'product-error', result.error);
  return result.value;
};
export const callProduct = async (
  module: string,
  exportName: string,
  args: ProductValue[],
): Promise<ProductValue> => {
  const request = {
    protocol: PRODUCT_PROTOCOL,
    id: randomUUID(),
    module,
    exportName,
    args,
  };
  productRequest(request);
  ensure(
    Buffer.byteLength(JSON.stringify(request)) <= MAX_MESSAGE_BYTES,
    'product-protocol',
    'Product request too large',
  );
  return observation(request, request.id);
};
export const readProductSource = async (module: string): Promise<string> => {
  productPath(module);
  const id = randomUUID();
  const value = await observation(
    { protocol: PRODUCT_PROTOCOL, id, module, source: true },
    id,
  );
  ensure(
    typeof value === 'string',
    'product-protocol',
    'Expected product source bytes',
  );
  return value;
};
