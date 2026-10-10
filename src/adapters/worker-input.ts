import type { Readable } from 'node:stream';
import { addAbortSignal } from 'node:stream';
import type { Attempt, RoleRecipe, ModelBinding } from '../domain/contracts.js';
import { FactoryError, ensure } from '../domain/invariants.js';
import { contract } from './contracts.js';

export const WORKER_INPUT_BYTES = 1024 * 1024;
export interface WorkerInput {
  attempt: Attempt;
  prompt: string;
  recipe: RoleRecipe;
  binding: ModelBinding;
}

export const readWorkerInput = async (
  stream: Readable,
  signal: AbortSignal,
): Promise<WorkerInput> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    addAbortSignal(signal, stream);
    for await (const chunk of stream) {
      ensure(Buffer.isBuffer(chunk), 'invalid-input', 'Expected byte input');
      bytes += chunk.length;
      ensure(
        bytes <= WORKER_INPUT_BYTES,
        'input-limit',
        'Worker input exceeded byte limit',
      );
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    const input: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    ensure(
      input && typeof input === 'object' && !Array.isArray(input),
      'invalid-input',
      'Invalid Worker input',
    );
    ensure(
      Object.keys(input).length === 4 &&
        ['attempt', 'prompt', 'recipe', 'binding'].every((key) => key in input),
      'invalid-input',
      'Invalid Worker envelope',
    );
    const prompt: unknown = Reflect.get(input, 'prompt');
    ensure(
      typeof prompt === 'string' && prompt.length > 0,
      'invalid-input',
      'Invalid Worker prompt',
    );
    return {
      attempt: contract('Attempt', Reflect.get(input, 'attempt')),
      prompt,
      recipe: contract('RoleRecipe', Reflect.get(input, 'recipe')),
      binding: contract('ModelBinding', Reflect.get(input, 'binding')),
    };
  } catch (error) {
    stream.destroy();
    if (signal.aborted) {
      let code = 'cancelled';
      if (
        signal.reason instanceof Error &&
        signal.reason.name === 'TimeoutError'
      )
        code = 'timeout';
      throw new FactoryError(code, 'Worker input interrupted');
    }
    if (error instanceof FactoryError && error.code === 'input-limit')
      throw error;
    throw new FactoryError(
      'invalid-input',
      'Invalid Worker input; raw input omitted',
    );
  }
};
