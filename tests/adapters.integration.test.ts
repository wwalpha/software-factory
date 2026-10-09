import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import {
  ResponsesPlanner,
  classifyProviderError,
} from '../src/adapters/responses.js';
import { CodexSession } from '../src/adapters/codex.js';
import { models, harness } from './helpers.js';
import { redact } from '../src/adapters/logging.js';
import type { ModelBinding, Attempt } from '../src/domain/contracts.js';
const binding: ModelBinding = {
  enabled: true,
  model: 'fixture-model',
  reasoning: 'low',
  verifiedAt: new Date().toISOString(),
  priceReference: 'test-only',
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
  maxOutputTokens: 100,
};
test('real openai SDK maps JSON, refusal, incomplete, invalid JSON, auth expiry and rate limit without retries', async () => {
  let scenario = 'valid',
    calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    let body = '';
    for await (const c of req) body += String(c);
    const input = JSON.parse(body);
    assert.deepEqual(input.tools, []);
    assert.equal(input.store, false);
    if (scenario === '401' || scenario === '429') {
      res.writeHead(Number(scenario), { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'provider failure', type: 'api_error' },
        }),
      );
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_fixture',
        object: 'response',
        status: scenario === 'partial' ? 'incomplete' : 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content:
              scenario === 'refusal'
                ? [{ type: 'refusal', refusal: 'No' }]
                : [
                    {
                      type: 'output_text',
                      text:
                        scenario === 'bad'
                          ? 'not json'
                          : JSON.stringify({
                              objective: 'do work',
                              nonGoals: [],
                              ambiguities: [],
                            }),
                    },
                  ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const planner = new ResponsesPlanner(
      { ...models, reasoner: binding },
      'test-key',
      `http://127.0.0.1:${address.port}/v1`,
    );
    const valid = await planner.structured(
      'MissionDraft',
      {},
      binding,
      AbortSignal.timeout(1000),
    );
    assert.equal(valid.value.objective, 'do work');
    assert.equal(valid.usage.certainty, 'measured');
    for (const [value, code] of [
      ['refusal', 'refused'],
      ['partial', 'incomplete'],
      ['bad', 'invalid-output'],
      ['401', 'auth-expired'],
      ['429', 'rate-limited'],
    ]) {
      scenario = value ?? '';
      const before = calls;
      await assert.rejects(
        planner.structured(
          'MissionDraft',
          {},
          binding,
          AbortSignal.timeout(1000),
        ),
        (e) => classifyProviderError(e) === code,
      );
      assert.equal(calls, before + 1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test('actual Codex SDK subprocess stream, result, unknown event and AbortSignal are mapped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-sdk-'));
  const script = join(root, 'codex-fixture');
  const h = await harness();
  try {
    const attempt: Attempt = {
      id: 'a',
      missionId: 'm',
      workItemId: 'w',
      epoch: 1,
      leaseUntil: new Date(Date.now() + 1000).toISOString(),
      baseDigest: 'a'.repeat(64),
      operationId: 'o',
      state: 'running',
      waiting: null,
      usage: {
        certainty: 'unknown',
        inputTokens: null,
        outputTokens: null,
        usd: null,
      },
      stopped: false,
    };
    const recipe = (await h.guard.release('baseline')).recipe;
    const source = (event: string) =>
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{${event}});`;
    await writeFile(
      script,
      source(
        `console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));console.log(JSON.stringify({type:'item.completed',item:{id:'i',type:'agent_message',text:JSON.stringify({summary:'candidate',acceptanceClaims:[],concerns:[]})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}}));`,
      ),
    );
    await chmod(script, 0o700);
    const make = () =>
      new CodexSession(
        new Codex({
          codexPathOverride: script,
          env: { PATH: process.env.PATH ?? '', HOME: root },
        }),
      );
    const session = make();
    const result = await session.run(
      attempt,
      'build',
      recipe,
      binding,
      root,
      AbortSignal.timeout(3000),
    );
    assert.equal(result.claim.summary, 'candidate');
    assert.equal(session.status().state, 'completed');
    await writeFile(
      script,
      source(`console.log(JSON.stringify({type:'new.unknown'}));`),
    );
    await assert.rejects(
      make().run(
        attempt,
        'build',
        recipe,
        binding,
        root,
        AbortSignal.timeout(3000),
      ),
      /Unsupported Codex event/,
    );
    await writeFile(script, source('setInterval(()=>{},1000);'));
    const interrupted = make();
    const pending = interrupted.run(
      attempt,
      'build',
      recipe,
      binding,
      root,
      AbortSignal.timeout(3000),
    );
    setTimeout(() => interrupted.interrupt(), 50);
    await assert.rejects(pending);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('secret scrubbing removes key patterns, bearer credentials and configured exact values', async () => {
  assert.equal(
    redact('sk-sensitive Bearer private-token exact-secret', ['exact-secret']),
    '[REDACTED] Bearer [REDACTED] [REDACTED]',
  );
  const source = await readFile(
    new URL('../src/adapters/codex.js', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('process.env.OPENAI_API_KEY'));
});
