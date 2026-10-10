import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const helper = new URL('./product-call.js', import.meta.url).href;
const files: string[] = JSON.parse(process.env.CHECK_FILES ?? '[]');
const allowed = new Set([
  ...files.map(
    (file) =>
      pathToFileURL(realpathSync(resolve(process.env.CHECK_ROOT ?? '', file)))
        .href,
  ),
  helper,
  new URL('./product-protocol.js', import.meta.url).href,
  new URL('../domain/invariants.js', import.meta.url).href,
]);
const testBuiltins = new Set([
  'node:test',
  'node:assert',
  'node:assert/strict',
  'node:path',
  'node:url',
  'node:util',
  'node:buffer',
  'node:timers',
  'node:timers/promises',
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'factory:product')
      return { url: helper, shortCircuit: true };
    const result = nextResolve(specifier, context);
    if (
      result.url.startsWith('node:') &&
      !testBuiltins.has(result.url) &&
      !(
        context.parentURL === helper &&
        ['node:net', 'node:crypto'].includes(result.url)
      )
    )
      throw Error(
        'Protected tests must use factory:product for product calls and source reads',
      );
    if (!result.url.startsWith('node:') && !allowed.has(result.url))
      throw Error(
        'Legacy/direct product imports are refused; migrate to factory:product and re-register the profile',
      );
    return result;
  },
});
