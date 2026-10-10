import { writeSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensure } from '../domain/invariants.js';
import {
  MAX_MESSAGE_BYTES,
  PRODUCT_PROTOCOL,
  productBytes,
  productMessage,
  productRequest,
  productValue,
  type ProductResponse,
} from './product-protocol.js';

const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  ensure(
    bytes <= MAX_MESSAGE_BYTES,
    'product-protocol',
    'Product request too large',
  );
  chunks.push(chunk);
}
const request = productMessage(productBytes(Buffer.concat(chunks)));
productRequest(request);
let response: ProductResponse;
try {
  const root = await realpath(process.env.PRODUCT_ROOT ?? '/workspace');
  let path = root;
  for (const part of request.module.split('/')) {
    path = join(path, part);
    const stat = await lstat(path);
    ensure(
      !stat.isSymbolicLink(),
      'product-path',
      'Product links are rejected',
    );
  }
  const stat = await lstat(path);
  ensure(
    stat.isFile() &&
      stat.nlink === 1 &&
      (await realpath(path)) === resolve(root, request.module),
    'product-path',
    'Product path escapes candidate',
  );
  // Only this untrusted process imports the candidate; it has no assertions or expected values.
  const product = await import(pathToFileURL(path).href);
  ensure(
    Object.hasOwn(product, request.exportName) &&
      typeof product[request.exportName] === 'function',
    'product-export',
    'Named function export required',
  );
  const value: unknown = await product[request.exportName](...request.args);
  productValue(value);
  response = { protocol: PRODUCT_PROTOCOL, id: request.id, ok: true, value };
} catch (error) {
  response = {
    protocol: PRODUCT_PROTOCOL,
    id: request.id,
    ok: false,
    error: error instanceof Error ? error.message : 'Product execution failed',
  };
}
const encoded = JSON.stringify(response);
ensure(
  Buffer.byteLength(encoded) <= MAX_MESSAGE_BYTES,
  'product-protocol',
  'Product response too large',
);
writeSync(3, encoded);
