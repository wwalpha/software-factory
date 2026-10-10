import { readFileSync } from 'node:fs';
import { contract } from '../../src/adapters/contracts.js';
import type { WorkerInput } from '../../src/adapters/worker-input.js';
export const workerInput = (): WorkerInput => ({
  attempt: {
    id: 'stdin-attempt',
    missionId: 'stdin-mission',
    workItemId: 'stdin-work',
    epoch: 1,
    leaseUntil: '2030-01-01T00:00:00.000Z',
    baseDigest: 'a'.repeat(64),
    operationId: 'stdin-operation',
    state: 'running',
    waiting: null,
    usage: {
      certainty: 'unknown',
      inputTokens: null,
      outputTokens: null,
      usd: null,
    },
    stopped: false,
  },
  prompt: '東京・日本語\n"引用"\\path stdin-private-prompt',
  recipe: {
    ...contract(
      'RoleRecipe',
      JSON.parse(
        readFileSync(
          new URL('../../../config/roles.json', import.meta.url),
          'utf8',
        ),
      )[2],
    ),
    scope: ['received.json'],
  },
  binding: {
    enabled: true,
    model: 'fixture-model',
    reasoning: 'low',
    verifiedAt: '2026-10-10T00:00:00.000Z',
    priceReference: 'test-only',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    maxOutputTokens: 100,
  },
});
