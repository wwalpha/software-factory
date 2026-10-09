import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { clamp } = await import(
  pathToFileURL(join(process.env.PRODUCT_ROOT, 'range.ts')).href
);
test('clamp meets lower, upper, interior and equality acceptance', () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(0, 0, 10), 0);
});
