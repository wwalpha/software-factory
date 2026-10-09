import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
const file = join(process.env.PRODUCT_ROOT, 'names.ts');
const product = await import(pathToFileURL(file).href);
test('shared normalization preserves both public callers', async () => {
  assert.equal(typeof product.normalizeName, 'function');
  assert.equal(product.normalizeName(' ALIce '), 'alice');
  assert.deepEqual(product.userNames([' A ', 'B']), ['a', 'b']);
  assert.deepEqual(product.teamNames([' A ', 'B']), ['a', 'b']);
  assert.deepEqual(product.teamNames([]), []);
  assert.equal(
    (await readFile(file, 'utf8')).match(/trim\(\)\.toLowerCase\(\)/g)?.length,
    1,
  );
});
