import { Codex } from '@openai/codex-sdk';
import type {
  Attempt,
  RoleRecipe,
  ModelBinding,
  RunnerFact,
  Usage,
  AgentClaim,
} from '../domain/contracts.js';
import { contract, contractSchema } from './contracts.js';
import { FactoryError, ensure } from '../domain/invariants.js';
import { usage } from './responses.js';
export function codexFailure(message: string): RunnerFact['outcome'] {
  if (/401|403|authentication|unauthorized|expired/i.test(message))
    return 'auth-expired';
  if (/429|rate.?limit/i.test(message)) return 'rate-limited';
  if (/approval|permission|refus/i.test(message)) return 'refused';
  return 'failed';
}
export class CodexSession {
  private state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' =
    'idle';
  private controller = new AbortController();
  private result: { claim: AgentClaim; usage: Usage } | null = null;
  constructor(private client: Codex) {}
  status() {
    return { state: this.state, result: this.result };
  }
  interrupt() {
    this.controller.abort();
  }
  async run(
    attempt: Attempt,
    prompt: string,
    recipe: RoleRecipe,
    binding: ModelBinding,
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<{ claim: AgentClaim; usage: Usage }> {
    ensure(
      this.state === 'idle',
      'runner',
      'Each attempt uses a fresh SDK context',
    );
    this.state = 'running';
    const thread = this.client.startThread({
      model: binding.model,
      modelReasoningEffort: binding.reasoning,
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    let claim: AgentClaim | null = null,
      observed: Usage = {
        certainty: 'unknown',
        inputTokens: null,
        outputTokens: null,
        usd: null,
      };
    let completed = false;
    try {
      const { events } = await thread.runStreamed(
        JSON.stringify({
          recipe: recipe.prompt,
          prompt,
          attemptId: attempt.id,
          instruction:
            'Edit only the assigned workspace. Any approval requirement must be reported as a concern. Return AgentClaim; your claim is not verification.',
        }),
        {
          outputSchema: contractSchema('AgentClaim'),
          signal: AbortSignal.any([signal, this.controller.signal]),
        },
      );
      for await (const event of events) {
        switch (event.type) {
          case 'thread.started':
          case 'turn.started':
          case 'item.started':
          case 'item.updated':
            break;
          case 'turn.completed':
            completed = true;
            observed = usage(
              binding,
              event.usage.input_tokens,
              event.usage.output_tokens,
            );
            break;
          case 'turn.failed':
            throw new FactoryError(
              codexFailure(event.error.message),
              'Codex failed; raw messages omitted',
            );
          case 'error':
            throw new FactoryError(
              codexFailure(event.message),
              'Codex failed; raw messages omitted',
            );
          case 'item.completed': {
            const item = event.item;
            if (item.type === 'agent_message') {
              try {
                claim = contract('AgentClaim', JSON.parse(item.text));
              } catch {
                throw new FactoryError('invalid-output', 'Invalid Codex claim');
              }
            } else if (
              ![
                'reasoning',
                'command_execution',
                'file_change',
                'todo_list',
                'error',
              ].includes(item.type)
            )
              throw new FactoryError(
                'unknown-event',
                'Unsupported Codex item; attempt stopped',
              );
            if (item.type === 'error')
              throw new FactoryError(
                'refused',
                'Codex error/approval request rejected',
              );
            break;
          }
          default:
            throw new FactoryError(
              'unknown-event',
              'Unsupported Codex event; attempt stopped',
            );
        }
      }
      ensure(
        completed && claim,
        'incomplete',
        'Codex did not return a complete result',
      );
      this.result = { claim, usage: observed };
      this.state = 'completed';
      return this.result;
    } catch (e) {
      this.state =
        signal.aborted || this.controller.signal.aborted
          ? 'cancelled'
          : 'failed';
      throw e;
    }
  }
}
export function createCodex(baseUrl: string, apiKey: string): Codex {
  return new Codex({
    baseUrl,
    apiKey,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp/codex-home',
      CODEX_HOME: '/tmp/codex-home',
    },
    config: {
      model_provider: 'factory',
      model_providers: {
        factory: {
          name: 'Factory constrained proxy',
          base_url: baseUrl,
          env_key: 'CODEX_API_KEY',
          wire_api: 'responses',
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
      features: { shell_snapshot: false },
    },
  });
}
export function failedFact(
  attempt: Attempt,
  outcome: RunnerFact['outcome'],
  detail: string,
  stopped: boolean,
): RunnerFact {
  return {
    attemptId: attempt.id,
    outcome,
    stopped,
    detail,
    usage: {
      certainty: 'unknown',
      inputTokens: null,
      outputTokens: null,
      usd: null,
    },
    handoff: null,
  };
}
