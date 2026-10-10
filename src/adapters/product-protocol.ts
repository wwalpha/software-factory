import { ensure, safePath } from '../domain/invariants.js';

export const PRODUCT_PROTOCOL = 'factory-product-v1';
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_CALLS = 128;
export const CALL_TIMEOUT_MS = 10000;
export type ProductValue =
  | null
  | boolean
  | number
  | string
  | ProductValue[]
  | { [key: string]: ProductValue };
export interface ProductRequest {
  protocol: typeof PRODUCT_PROTOCOL;
  id: string;
  module: string;
  exportName: string;
  args: ProductValue[];
}
export type ProductResponse =
  | {
      protocol: typeof PRODUCT_PROTOCOL;
      id: string;
      ok: true;
      value: ProductValue;
    }
  | { protocol: typeof PRODUCT_PROTOCOL; id: string; ok: false; error: string };

export const productPath = (path: string): void => {
  ensure(
    safePath(path) && !/[:?#]/.test(path),
    'product-path',
    'Product module must be a safe candidate-relative path',
  );
};
export const productValue: (
  value: unknown,
  depth?: number,
) => asserts value is ProductValue = (value, depth = 0) => {
  ensure(depth <= 32, 'product-value', 'Product value exceeds depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    ensure(
      Number.isFinite(value) && !Object.is(value, -0),
      'product-value',
      'Nonfinite numbers and negative zero are unsupported',
    );
    return;
  }
  ensure(
    value && typeof value === 'object',
    'product-value',
    'Unsupported product value',
  );
  if (Array.isArray(value)) {
    ensure(
      Object.keys(value).length === value.length &&
        Reflect.ownKeys(value).length === value.length + 1 &&
        Array.from({ length: value.length }, (_, i) =>
          Object.hasOwn(value, i),
        ).every(Boolean),
      'product-value',
      'Sparse or decorated arrays are unsupported',
    );
  } else {
    ensure(
      Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null,
      'product-value',
      'Only plain product objects are supported',
    );
    ensure(
      Reflect.ownKeys(value).length === Object.keys(value).length,
      'product-value',
      'Hidden or symbol properties are unsupported',
    );
  }
  let keys: string[];
  if (Array.isArray(value))
    keys = Array.from({ length: value.length }, (_, index) => String(index));
  else keys = Object.keys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(
      descriptor && 'value' in descriptor,
      'product-value',
      'Product accessors are unsupported',
    );
    productValue(descriptor.value, depth + 1);
  }
};
export const exactObject: (
  value: unknown,
  keys: string[],
) => asserts value is Record<string, unknown> = (value, keys) => {
  ensure(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    'product-protocol',
    'Invalid product message schema',
  );
};
export const productRequest: (
  value: unknown,
) => asserts value is ProductRequest = (value) => {
  exactObject(value, ['protocol', 'id', 'module', 'exportName', 'args']);
  ensure(
    value.protocol === PRODUCT_PROTOCOL &&
      typeof value.id === 'string' &&
      /^[a-f0-9-]{36}$/.test(value.id) &&
      typeof value.module === 'string' &&
      typeof value.exportName === 'string' &&
      /^[A-Za-z_$][\w$]*$/.test(value.exportName) &&
      Array.isArray(value.args),
    'product-protocol',
    'Invalid product call',
  );
  productPath(value.module);
  productValue(value.args);
};
export const productResponse = (text: string, id: string): ProductResponse => {
  const value = productMessage(text);
  let fields: string[];
  if (value && typeof value === 'object' && 'ok' in value && value.ok === true)
    fields = ['protocol', 'id', 'ok', 'value'];
  else fields = ['protocol', 'id', 'ok', 'error'];
  exactObject(value, fields);
  ensure(
    value.protocol === PRODUCT_PROTOCOL &&
      value.id === id &&
      typeof value.ok === 'boolean',
    'product-protocol',
    'Unmatched product response',
  );
  if (value.ok) productValue(value.value);
  else
    ensure(
      typeof value.error === 'string',
      'product-protocol',
      'Invalid product error',
    );
  return value as ProductResponse;
};
export const productMessage = (text: string): unknown => {
  ensure(
    Buffer.byteLength(text) <= MAX_MESSAGE_BYTES,
    'product-protocol',
    'Product message too large',
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid or missing product response');
  }
  ensure(
    JSON.stringify(value) === text,
    'product-protocol',
    'Exactly one canonical JSON message required',
  );
  return value;
};
export const productBytes = (bytes: Buffer): string => {
  ensure(
    bytes.length <= MAX_MESSAGE_BYTES,
    'product-protocol',
    'Product message too large',
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
