import { createServer, request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { readWorkerInput, type WorkerInput } from './worker-input.js';
import {
  createCodex,
  CodexSession,
  failedFact,
  codexFailure,
} from './codex.js';
import { FactoryError } from '../domain/invariants.js';
import type { RunnerFact } from '../domain/contracts.js';
const deadline = AbortSignal.timeout(110000);
let input: WorkerInput;
try {
  input = await readWorkerInput(process.stdin, deadline);
} catch {
  process.stdin.destroy();
  process.stderr.write('Worker input or startup failed; raw input omitted\n');
  process.exit(2);
}
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
    deadline,
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
  let code: string = 'failed';
  if (e instanceof FactoryError) code = e.code;
  else if (e instanceof Error) code = codexFailure(e.message);
  if (deadline.aborted) code = 'timeout';
  let outcome: RunnerFact['outcome'] = 'failed';
  switch (code) {
    case 'timeout':
    case 'auth-expired':
    case 'rate-limited':
    case 'refused':
    case 'invalid-output':
    case 'unknown-event':
      outcome = code;
  }
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
