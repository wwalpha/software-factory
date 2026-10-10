import test from 'node:test';
import assert from 'node:assert/strict';
import { callProduct } from 'factory:product';
test('clamp meets lower, upper, interior and equality acceptance', async () => {
  assert.equal(await callProduct('range.ts', 'clamp', [-5, 0, 10]), 0);
  assert.equal(await callProduct('range.ts', 'clamp', [20, 0, 10]), 10);
  assert.equal(await callProduct('range.ts', 'clamp', [5, 0, 10]), 5);
  assert.equal(await callProduct('range.ts', 'clamp', [0, 0, 10]), 0);
});
