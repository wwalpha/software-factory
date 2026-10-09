import { createServer, type Server } from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensure } from '../domain/invariants.js';
import type { ModelBinding } from '../domain/contracts.js';
// A per-attempt Unix socket exposes only bounded model responses, never general egress.
export async function modelProxy(
  socketPath: string,
  key: string,
  binding: ModelBinding,
  maxCalls: number,
  signal: AbortSignal,
  maxUsd: number,
): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o755 });
  await rm(socketPath, { force: true });
  let calls = 0,
    reserved = 0;
  const server = createServer(async (req, res) => {
    try {
      ensure(
        req.method === 'POST' &&
          ['/responses', '/v1/responses'].includes(req.url ?? ''),
        'network',
        'Endpoint denied',
      );
      ensure(++calls <= maxCalls, 'budget', 'Model request limit reached');
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        ensure(
          Buffer.byteLength(body) <= 1024 * 1024,
          'network',
          'Request too large',
        );
      }
      const parsed: unknown = JSON.parse(body);
      ensure(
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        'schema',
        'Invalid model request',
      );
      ensure(
        binding.inputUsdPerMillion !== null &&
          binding.outputUsdPerMillion !== null,
        'budget',
        'Missing price binding',
      );
      const upper =
        ((Buffer.byteLength(body) + 4096) * binding.inputUsdPerMillion +
          binding.maxOutputTokens * binding.outputUsdPerMillion) /
        1e6;
      ensure(
        reserved + upper <= maxUsd,
        'budget',
        'Attempt proxy budget exhausted',
      );
      reserved += upper;
      if ('tools' in parsed) {
        ensure(
          Array.isArray(parsed.tools) &&
            parsed.tools.every(
              (t) =>
                t &&
                typeof t === 'object' &&
                'type' in t &&
                ['function', 'custom'].includes(String(t.type)),
            ),
          'network',
          'Hosted execution tools are denied',
        );
      }
      const input = {
        ...parsed,
        model: binding.model,
        max_output_tokens: binding.maxOutputTokens,
        store: false,
      };
      // The URL and authorization are Guard-owned; Worker input cannot select either.
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(input),
        signal,
      });
      res.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      });
      if (upstream.body)
        for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch {
      res.writeHead(403);
      res.end('{"error":{"message":"Factory proxy denied request"}}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o666);
  return server;
}
