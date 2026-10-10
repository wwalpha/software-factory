import test from 'node:test';
import assert from 'node:assert/strict';
import { callProduct, readProductSource } from 'factory:product';
test('shared normalization preserves both public callers', async () => {
  assert.equal(
    await callProduct('names.ts', 'normalizeName', [' ALIce ']),
    'alice',
  );
  assert.deepEqual(await callProduct('names.ts', 'userNames', [[' A ', 'B']]), [
    'a',
    'b',
  ]);
  assert.deepEqual(await callProduct('names.ts', 'teamNames', [[' A ', 'B']]), [
    'a',
    'b',
  ]);
  assert.deepEqual(await callProduct('names.ts', 'teamNames', [[]]), []);
  assert.equal(
    (await readProductSource('names.ts')).match(/trim\(\)\.toLowerCase\(\)/g)
      ?.length,
    1,
  );
});
