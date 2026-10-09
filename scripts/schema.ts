import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(
  await readFile('contracts/factory.schema.json', 'utf8'),
);
const result = await compile(schema, 'FactoryContract', {
  bannerComment:
    '/* Generated from contracts/factory.schema.json. Do not edit. */',
  unreachableDefinitions: true,
  additionalProperties: false,
});
const target = 'src/domain/contracts.ts';
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== result)
    throw new Error('Generated contracts are stale');
} else await writeFile(target, result);
