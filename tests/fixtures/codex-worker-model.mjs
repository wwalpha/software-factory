import process from 'node:process';
import { setInterval } from 'node:timers';
import { writeFile } from 'node:fs/promises';
import { FactoryError } from '../domain/invariants.js';
export { failedFact, codexFailure } from './codex-original.js';
export const createCodex = () => ({});
export class CodexSession {
  async run(attempt, prompt, recipe, binding) {
    if (prompt === 'fixture-provider-timeout')
      throw new FactoryError('timeout', 'stdin-private-secret');
    if (prompt === 'fixture-early-exit') process.exit(2);
    if (prompt === 'fixture-hang')
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    await writeFile(
      '/workspace/received.json',
      JSON.stringify({ attempt, prompt, recipe, binding }),
    );
    return {
      claim: {
        summary: 'fixture model boundary',
        acceptanceClaims: [],
        concerns: [],
      },
      usage: { certainty: 'measured', inputTokens: 0, outputTokens: 0, usd: 0 },
    };
  }
}
