import { createServer, request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { Attempt, RoleRecipe, ModelBinding } from '../domain/contracts.js';
import {
  createCodex,
  CodexSession,
  failedFact,
  codexFailure,
} from './codex.js';
import { FactoryError } from '../domain/invariants.js';
let data = '';
for await (const chunk of process.stdin) data += String(chunk);
const input: {
  attempt: Attempt;
  prompt: string;
  recipe: RoleRecipe;
  binding: ModelBinding;
} = JSON.parse(data);
await mkdir('/tmp/codex-home', { recursive: true, mode: 0o700 });
const server = createServer((req, res) => {
  const upstream = request(
    {
      socketPath: '/ipc/model.sock',
      path: req.url,
      method: req.method,
      headers: { 'content-type': 'application/json' },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
await new Promise<void>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve()),
);
const address = server.address();
if (!address || typeof address === 'string') throw Error('Proxy failed');
try {
  const session = new CodexSession(
    createCodex(
      `http://127.0.0.1:${address.port}/v1`,
      'factory-ephemeral-proxy',
    ),
  );
  const result = await session.run(
    input.attempt,
    input.prompt,
    input.recipe,
    input.binding,
    '/workspace',
    AbortSignal.timeout(110000),
  );
  process.stdout.write(
    JSON.stringify({
      claim: result.claim,
      fact: {
        attemptId: input.attempt.id,
        outcome: 'completed',
        stopped: false,
        usage: result.usage,
        handoff: null,
        detail: 'Codex turn completed',
      },
    }) + '\n',
  );
} catch (e) {
  const code =
    e instanceof FactoryError
      ? e.code
      : codexFailure(e instanceof Error ? e.message : 'failed');
  const outcome = [
    'auth-expired',
    'rate-limited',
    'refused',
    'invalid-output',
    'unknown-event',
  ].includes(code)
    ? (code as
        | 'auth-expired'
        | 'rate-limited'
        | 'refused'
        | 'invalid-output'
        | 'unknown-event')
    : 'failed';
  process.stdout.write(
    JSON.stringify({
      claim: null,
      fact: failedFact(
        input.attempt,
        outcome,
        'Codex request failed; raw provider output omitted',
        false,
      ),
    }) + '\n',
  );
} finally {
  server.closeAllConnections();
  server.close();
}
