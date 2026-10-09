import { Lane } from './lanes.js';
import { randomUUID } from 'node:crypto';
import type { PersistencePort } from '../ports/store.js';
import type { PlanningPort } from '../ports/agents.js';
import type {
  GuardPort,
  OperationRequest,
  BuildResult,
  CheckResult,
  OperationRecord,
} from '../ports/guard.js';
import type {
  MissionRevision,
  ProjectProfile,
  PlanProposal,
  Attempt,
  EvidenceReceipt,
  ResultBundle,
  Waiting,
  FactoryRelease,
  Experiment,
} from '../domain/contracts.js';
import {
  ensure,
  FactoryError,
  validatePlan,
  validateMission,
  validateHandoff,
  inScope,
} from '../domain/invariants.js';
import { contract } from '../adapters/contracts.js';
import {
  digest,
  type Tree,
  treeDigest,
  mergeTrees,
} from '../adapters/artifacts.js';
import { classifyProviderError } from '../adapters/responses.js';
import { rejectSecrets } from '../adapters/logging.js';
export interface MissionState {
  missionId: string;
  status:
    'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  phase: 'planning' | 'working' | 'integrating' | 'verifying' | 'delivery';
  waiting: Waiting | null;
  planRevision: number;
  tree: Tree | null;
  plan: PlanProposal | null;
  work: Record<
    string,
    'pending' | 'running' | 'completed' | 'failed' | 'waiting'
  >;
  attempts: string[];
  receipts: EvidenceReceipt[];
  repairs: number;
  startedAt: string | null;
  grantId: string;
}
export class Runtime {
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private writes: Promise<void> = Promise.resolve();
  private coordinator = new Lane(1);
  private workers = new Lane(2);
  private review = new Lane(1);
  constructor(
    public readonly store: PersistencePort,
    private planner: PlanningPort,
    private guard: GuardPort,
    public readonly mode: 'fake' | 'live',
    private secrets: string[] = [],
  ) {}
  async submit(
    requirements: string,
    profile: ProjectProfile,
  ): Promise<MissionRevision> {
    ensure(
      requirements.trim() && requirements.length <= 16000,
      'requirements',
      'Requirements required (maximum 16000 characters)',
    );
    rejectSecrets({ requirements, profile }, this.secrets);
    const id = randomUUID(),
      reservation = `draft-${id}`;
    await this.store.reserve(reservation, id, 0.1, profile.budget.maxUsd);
    let drafted;
    try {
      const signal = AbortSignal.timeout(60000);
      drafted = await this.coordinator.run(signal, () =>
        this.planner.draft(requirements, profile, signal),
      );
      await this.store.settle(reservation, drafted.usage.usd);
    } catch (e) {
      await this.store.settle(reservation, null);
      throw e;
    }
    rejectSecrets(drafted, this.secrets);
    const draft = contract('MissionDraft', drafted.value),
      release = await this.guard.call<FactoryRelease>('releaseFor', {
        projectId: profile.id,
        taskType: profile.taskType,
      });
    const mission: MissionRevision = {
      id,
      revision: 1,
      parentRevision: null,
      objective: draft.objective,
      nonGoals: draft.nonGoals,
      projectId: profile.id,
      taskType: profile.taskType,
      scope: profile.scope,
      acceptance: profile.acceptance,
      delegation: profile.delegation,
      budget: profile.budget,
      delivery: 'sealed-tree',
      factoryRelease: release.id,
      createdAt: new Date().toISOString(),
    };
    validateMission(mission);
    const state: MissionState = {
      missionId: id,
      status: draft.ambiguities.length ? 'waiting' : 'ready',
      phase: 'planning',
      waiting: draft.ambiguities.length
        ? {
            reason: draft.ambiguities.join('; '),
            owner: 'operator',
            resumeCondition:
              'Submit a new mission revision resolving the stated ambiguity',
          }
        : null,
      planRevision: 0,
      tree: null,
      plan: null,
      work: {},
      attempts: [],
      receipts: [],
      repairs: 0,
      startedAt: null,
      grantId: `grant-${id}`,
    };
    await this.store.commit(
      [
        { kind: 'mission', id, expectedVersion: 0, value: mission },
        {
          kind: 'mission-revision',
          id: `${id}-1`,
          expectedVersion: 0,
          value: mission,
        },
        { kind: 'state', id, expectedVersion: 0, value: state },
      ],
      { id: `submit-${id}`, topic: 'mission.submitted', payload: { id } },
    );
    return mission;
  }
  async mission(id: string): Promise<MissionRevision> {
    const row = await this.store.get<MissionRevision>('mission', id);
    ensure(row, 'mission', 'Mission not found');
    return row.value;
  }
  async revise(id: string, clarification: string): Promise<MissionRevision> {
    ensure(
      !this.running.has(id) && clarification.trim(),
      'revision',
      'Stop active work and supply clarification',
    );
    const old = await this.mission(id),
      state = await this.state(id),
      row = await this.store.get('mission', id);
    ensure(
      row && state.status !== 'completed',
      'revision',
      'Delivered missions cannot be revised',
    );
    for (const attemptId of state.attempts) {
      const a = await this.store.get<Attempt>('attempt', attemptId);
      ensure(
        a?.value.stopped,
        'uncertain',
        'Old attempts must be stopped before revision',
      );
    }
    const mission = contract('MissionRevision', {
      ...old,
      revision: old.revision + 1,
      parentRevision: old.revision,
      objective: `${old.objective}\nHuman clarification: ${clarification}`,
      createdAt: new Date().toISOString(),
    });
    await this.save(
      {
        ...state,
        status: 'ready',
        waiting: null,
        plan: null,
        planRevision: 0,
        work: {},
        attempts: [],
        receipts: [],
        grantId: `grant-${id}-r${mission.revision}`,
      },
      'mission.revised',
      [
        { kind: 'mission', id, expectedVersion: row.version, value: mission },
        {
          kind: 'mission-revision',
          id: `${id}-${mission.revision}`,
          expectedVersion: 0,
          value: mission,
        },
      ],
    );
    return mission;
  }
  async state(id: string): Promise<MissionState> {
    const row = await this.store.get<MissionState>('state', id);
    ensure(row, 'mission', 'Mission not found');
    return row.value;
  }
  private async save(
    state: MissionState,
    topic: string,
    writes: import('../ports/store.js').Write[] = [],
  ): Promise<void> {
    const snapshot = structuredClone(state);
    rejectSecrets({ snapshot, writes }, this.secrets);
    const write = this.writes.then(async () => {
      const row = await this.store.get('state', snapshot.missionId);
      ensure(row, 'mission', 'Mission not found');
      await this.store.commit(
        [
          {
            kind: 'state',
            id: snapshot.missionId,
            expectedVersion: row.version,
            value: snapshot,
          },
          ...writes,
        ],
        { id: randomUUID(), topic, payload: { missionId: snapshot.missionId } },
      );
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }
  async status(id: string) {
    return {
      mission: await this.mission(id),
      state: await this.state(id),
      budget: await this.store.balance(id),
    };
  }
  private request(
    m: MissionRevision,
    s: MissionState,
    type: OperationRequest['type'],
    payload: unknown,
    amount = 0.01,
  ): OperationRequest {
    return {
      id: randomUUID(),
      grantId: s.grantId,
      mission: m,
      type,
      targetDigest: s.tree ? treeDigest(s.tree) : digest('snapshot'),
      amount,
      payload,
    };
  }
  private async operation<T>(request: OperationRequest): Promise<T> {
    await this.store.commit(
      [
        {
          kind: 'dispatch',
          id: request.id,
          expectedVersion: 0,
          value: request,
        },
      ],
      {
        id: `dispatch-${request.id}`,
        topic: 'guard.dispatch',
        payload: { id: request.id },
      },
    );
    const result = await this.guard.operate<T>(request);
    await this.store.ack(`dispatch-${request.id}`);
    return result;
  }
  async recover(id: string): Promise<MissionState> {
    const state = await this.state(id);
    for (const attemptId of state.attempts) {
      const row = await this.store.get<Attempt>('attempt', attemptId);
      if (
        !row ||
        !['running', 'reserved', 'uncertain', 'waiting'].includes(
          row.value.state,
        )
      )
        continue;
      const attempt = row.value;
      const operation = await this.guard.call<OperationRecord | null>(
        'operationStatus',
        attempt.operationId,
      );
      if (operation?.state === 'completed') {
        const result = operation.result as BuildResult;
        ensure(
          result.fact.stopped,
          'uncertain',
          'Old worker stop not confirmed',
        );
        if (
          operation.retryAllowed ||
          ['auth-expired', 'rate-limited'].includes(result.fact.outcome)
        ) {
          state.work[attempt.workItemId] = 'pending';
          state.waiting = null;
          await this.save(state, 'attempt.retry-ready', [
            {
              kind: 'attempt',
              id: attempt.id,
              expectedVersion: row.version,
              value: {
                ...attempt,
                state: 'failed',
                stopped: true,
                waiting: null,
              },
            },
          ]);
        } else if (attempt.state !== 'waiting')
          await this.accept(state, row.version, attempt, result);
      } else {
        const fact = operation
          ? await this.guard.call<{ stopped: boolean; retryAllowed: boolean }>(
              'reconcile',
              attempt.operationId,
            )
          : { stopped: true, retryAllowed: true };
        await this.store.settle(attempt.id, null);
        if (fact.stopped && fact.retryAllowed) {
          state.work[attempt.workItemId] = 'pending';
          state.waiting = null;
          await this.save(state, 'attempt.retry-ready', [
            {
              kind: 'attempt',
              id: attempt.id,
              expectedVersion: row.version,
              value: {
                ...attempt,
                state: 'failed',
                stopped: true,
                waiting: null,
              },
            },
          ]);
          continue;
        }
        const waiting: Waiting = {
          reason: operation
            ? 'External operation outcome is uncertain'
            : 'Dispatch did not complete',
          owner: 'operator',
          resumeCondition: fact.stopped
            ? 'Inspect sealed candidate/operation evidence, then explicitly authorize a new attempt'
            : 'Confirm old worker termination or revoke its write path',
        };
        if (attempt.state !== 'uncertain' || attempt.stopped !== fact.stopped)
          await this.store.commit(
            [
              {
                kind: 'attempt',
                id: attempt.id,
                expectedVersion: row.version,
                value: {
                  ...attempt,
                  state: 'uncertain',
                  stopped: fact.stopped,
                  waiting,
                },
              },
            ],
            {
              id: `recovered-${attempt.id}-${row.version}`,
              topic: 'attempt.uncertain',
              payload: { id: attempt.id },
            },
          );
        state.work[attempt.workItemId] = 'waiting';
        state.waiting = waiting;
      }
    }
    if (Object.values(state.work).includes('waiting')) state.status = 'waiting';
    await this.save(state, 'mission.reconciled');
    return state;
  }
  async run(id: string, mode: 'fake' | 'live'): Promise<ResultBundle> {
    ensure(
      mode === this.mode,
      'mode',
      'Runtime and requested mode differ; no fallback',
    );
    ensure(
      !this.running.has(id),
      'running',
      'Mission already has an active scheduler',
    );
    this.running.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let state = await this.state(id);
    const mission = await this.mission(id);
    try {
      if (['completed', 'cancelled'].includes(state.status))
        return this.result(id);
      if (
        state.waiting?.resumeCondition.startsWith(
          'Submit a new mission revision',
        )
      )
        return this.result(id);
      state = await this.recover(id);
      state.status = 'running';
      state.startedAt ??= new Date().toISOString();
      await this.save(state, 'mission.started');
      if (!state.tree) {
        const snapshot = await this.operation<{ tree: Tree }>(
          this.request(mission, state, 'snapshot', {}),
        );
        state.tree = snapshot.tree;
        await this.save(state, 'mission.snapshot');
      }
      const investigation =
        state.planRevision === 0
          ? await this.roleCall(
              id,
              'explorer',
              { mission, files: Object.keys(state.tree) },
              controller.signal,
            )
          : null;
      const testDesign =
        state.planRevision === 0
          ? await this.roleCall(
              id,
              'test-designer',
              { mission, files: Object.keys(state.tree) },
              controller.signal,
            )
          : null;
      const budgetStart = Date.parse(state.startedAt);
      while (!controller.signal.aborted) {
        ensure(
          Date.now() - budgetStart < mission.budget.maxMinutes * 60000,
          'budget',
          'Mission time budget exhausted',
        );
        if (!state.plan) {
          state.phase = 'planning';
          const callId = randomUUID();
          await this.store.reserve(callId, id, 0.1, mission.budget.maxUsd);
          try {
            const proposed = await this.coordinator.run(controller.signal, () =>
              this.planner.plan(
                mission,
                state.planRevision,
                {
                  files: Object.keys(state.tree ?? {}),
                  investigation,
                  testDesign,
                  checks: state.receipts,
                  repairs: state.repairs,
                },
                controller.signal,
              ),
            );
            await this.store.settle(callId, proposed.usage.usd);
            const plan = contract('PlanProposal', proposed.value);
            validatePlan(plan, mission, state.planRevision);
            state.plan = plan;
            state.planRevision = plan.revision;
            state.work = Object.fromEntries(
              plan.items.map((i) => [i.id, 'pending']),
            );
            await this.save(state, 'plan.adopted', [
              {
                kind: 'plan',
                id: `${id}-r${mission.revision}-${plan.revision}`,
                expectedVersion: 0,
                value: plan,
              },
            ]);
          } catch (e) {
            const balance = await this.store.balance(id);
            if (balance.reserved > 0) await this.store.settle(callId, null);
            throw e;
          }
        }
        state.phase = 'working';
        const plan = state.plan;
        const runnable = plan.items
          .filter(
            (item) =>
              state.work[item.id] === 'pending' &&
              item.dependsOn.every((dep) => state.work[dep] === 'completed'),
          )
          .slice(0, 2);
        if (runnable.length) {
          const base = state.tree;
          ensure(base, 'artifact', 'No mission snapshot');
          const settled = await Promise.allSettled(
            runnable.map(async (item) => {
              if (item.role !== 'builder') {
                const role = [
                  'explorer',
                  'test-designer',
                  'reviewer',
                  'failure-analyst',
                ].includes(item.role)
                  ? (item.role as
                      | 'explorer'
                      | 'test-designer'
                      | 'reviewer'
                      | 'failure-analyst')
                  : 'explorer';
                const report = await this.roleCall(
                  id,
                  role,
                  { mission, item, tree: base },
                  controller.signal,
                );
                for (const path of report.reads.paths)
                  ensure(
                    inScope(path, item.scope),
                    'scope',
                    'Role requested out-of-scope read',
                  );
                return { item, report };
              }
              ensure(
                state.attempts.length < mission.budget.maxAttempts,
                'budget',
                'Attempt budget exhausted',
              );
              const previous = (
                await this.store.list<Attempt>('attempt')
              ).filter(
                (a) =>
                  a.value.missionId === id && a.value.workItemId === item.id,
              );
              const epoch = Math.max(
                state.repairs + 1,
                ...previous.map((a) => a.value.epoch + 1),
              );
              const attemptId = randomUUID(),
                operationId = randomUUID();
              const attempt: Attempt = {
                id: attemptId,
                missionId: id,
                workItemId: item.id,
                epoch,
                leaseUntil: new Date(Date.now() + 120000).toISOString(),
                baseDigest: treeDigest(base),
                operationId,
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
              await this.store.reserve(
                attemptId,
                id,
                item.budgetUsd,
                mission.budget.maxUsd,
              );
              state.attempts.push(attemptId);
              state.work[item.id] = 'running';
              await this.save(state, 'attempt.started', [
                {
                  kind: 'attempt',
                  id: attemptId,
                  expectedVersion: 0,
                  value: attempt,
                },
              ]);
              const release = await this.guard.call<FactoryRelease[]>(
                'releaseStatus',
                null,
              );
              const selected = release.find(
                (r) => r.id === mission.factoryRelease,
              );
              ensure(selected, 'release', 'Pinned release missing');
              const request = {
                ...this.request(
                  mission,
                  state,
                  'build',
                  {
                    attempt,
                    tree: base,
                    prompt: item.instruction,
                    recipe: { ...selected.recipe, scope: item.scope },
                  },
                  item.budgetUsd,
                ),
                id: operationId,
                targetDigest: attempt.baseDigest,
              };
              const result = await this.workers.run(controller.signal, () =>
                this.operation<BuildResult>(request),
              );
              return { item, attempt, result };
            }),
          );
          for (let index = 0; index < settled.length; index++) {
            const result = settled[index],
              item = runnable[index];
            ensure(result && item, 'scheduler', 'Missing scheduler result');
            if (result.status === 'rejected') {
              state.work[item.id] = 'waiting';
              state.waiting = this.waiting(result.reason);
              continue;
            }
            if (
              'attempt' in result.value &&
              result.value.attempt &&
              result.value.result
            )
              await this.accept(
                state,
                1,
                result.value.attempt,
                result.value.result,
              );
            else state.work[item.id] = 'completed';
          }
          await this.save(state, 'work.batch');
          continue;
        }
        if (
          Object.values(state.work).some(
            (s) => s === 'waiting' || s === 'running',
          )
        ) {
          state.status = 'waiting';
          state.waiting ??= {
            reason: 'Dependent work cannot continue',
            owner: 'runtime',
            resumeCondition: 'Resolve blocked dependencies',
          };
          break;
        }
        if (Object.values(state.work).some((s) => s === 'failed')) {
          state.repairs++;
          state.plan = null;
          continue;
        }
        state.phase = 'integrating';
        const review = await this.roleCall(
          id,
          'reviewer',
          { mission, tree: state.tree, checks: state.receipts },
          controller.signal,
        );
        state.phase = 'verifying';
        const checked = await this.operation<CheckResult>(
          this.request(mission, state, 'check', { tree: state.tree }),
        );
        state.receipts = checked.receipts;
        const passed =
          review.approved &&
          mission.acceptance.every((a) =>
            checked.receipts.some(
              (r) =>
                r.checkId === a.checkId &&
                r.result === 'pass' &&
                r.targetDigest === treeDigest(state.tree ?? {}),
            ),
          );
        if (passed) {
          state.phase = 'delivery';
          state.waiting = null;
          await this.save(state, 'mission.verified');
          const provisional = {
            ...(await this.bundle(mission, state)),
            status: 'completed' as const,
          };
          const sealed = await this.operation<{ bundle: ResultBundle }>(
            this.request(mission, state, 'seal', {
              tree: state.tree,
              bundle: provisional,
            }),
          );
          ensure(
            !controller.signal.aborted,
            'cancelled',
            'Mission cancelled before delivery',
          );
          state.status = 'completed';
          await this.save(state, 'mission.completed', [
            { kind: 'result', id, expectedVersion: 0, value: sealed.bundle },
          ]);
          await this.guard.call('followup', sealed.bundle);
          return sealed.bundle;
        }
        state.repairs++;
        await this.roleCall(
          id,
          'failure-analyst',
          { mission, checks: state.receipts },
          controller.signal,
        );
        if (state.attempts.length >= mission.budget.maxAttempts) {
          state.status = 'failed';
          break;
        }
        state.plan = null;
        await this.save(state, 'mission.replan');
      }
      if (controller.signal.aborted) {
        state.status = 'cancelled';
        state.waiting = null;
      }
    } catch (e) {
      state.status = controller.signal.aborted ? 'cancelled' : 'waiting';
      state.waiting = controller.signal.aborted ? null : this.waiting(e);
    } finally {
      this.running.delete(id);
      this.controllers.delete(id);
    }
    await this.save(state, 'mission.stopped');
    const result = await this.bundle(mission, state);
    if (state.status === 'failed') await this.guard.call('followup', result);
    return result;
  }
  private waiting(error: unknown): Waiting {
    const code =
      error instanceof FactoryError ? error.code : classifyProviderError(error);
    return {
      reason: code,
      owner: [
        'grant',
        'binding',
        'budget',
        'uncertain',
        'revoked',
        'auth-expired',
      ].includes(code)
        ? 'operator'
        : 'provider',
      resumeCondition:
        code === 'uncertain'
          ? 'Reconcile the old operation; authorize a new attempt only after confirmed stop'
          : 'Correct the reported condition, then resume',
    };
  }
  private async roleCall(
    id: string,
    role: 'explorer' | 'reviewer' | 'test-designer' | 'failure-analyst',
    input: unknown,
    signal: AbortSignal,
  ) {
    const mission = await this.mission(id),
      callId = randomUUID();
    await this.store.reserve(callId, id, 0.1, mission.budget.maxUsd);
    let settled = false;
    try {
      const report = await this.review.run(signal, () =>
        this.planner.report(role, input, signal),
      );
      await this.store.settle(callId, report.usage.usd);
      settled = true;
      const value = contract('RoleReport', report.value);
      if (value.reads.paths.length) {
        ensure(
          value.reads.paths.length <= 8,
          'scope',
          'Too many requested reads',
        );
        const tree = (await this.state(id)).tree;
        ensure(tree, 'snapshot', 'Read snapshot unavailable');
        const reads: Record<string, string> = {};
        for (const path of value.reads.paths) {
          ensure(
            inScope(path, mission.scope),
            'scope',
            'Role read escapes mission',
          );
          const file = tree[path];
          ensure(file, 'read', 'Requested file does not exist');
          ensure(
            Buffer.byteLength(file.content, 'base64') <= 65536,
            'read',
            'Requested file exceeds read limit',
          );
          reads[path] = Buffer.from(file.content, 'base64').toString('utf8');
        }
        const followupId = randomUUID();
        await this.store.reserve(followupId, id, 0.1, mission.budget.maxUsd);
        try {
          const followup = await this.review.run(signal, () =>
            this.planner.report(
              role,
              {
                input,
                authorizedReads: reads,
                instruction:
                  'Use these authorized facts; return no further read requests.',
              },
              signal,
            ),
          );
          await this.store.settle(followupId, followup.usage.usd);
          const answer = contract('RoleReport', followup.value);
          ensure(
            answer.reads.paths.length === 0,
            'read',
            'Role exceeded bounded read round',
          );
          return answer;
        } catch (e) {
          const balance = await this.store.balance(id);
          if (balance.reserved > 0) await this.store.settle(followupId, null);
          throw e;
        }
      }
      return value;
    } catch (e) {
      if (!settled) await this.store.settle(callId, null);
      throw e;
    }
  }
  private async accept(
    state: MissionState,
    version: number,
    attempt: Attempt,
    result: BuildResult,
  ) {
    const fact = contract('RunnerFact', result.fact);
    await this.store.settle(attempt.id, fact.usage.usd);
    if (fact.handoff && fact.outcome === 'completed') {
      validateHandoff(fact.handoff, { ...attempt, stopped: fact.stopped });
      ensure(
        fact.handoff.candidateDigest === treeDigest(result.tree),
        'digest',
        'Candidate bytes changed',
      );
      const dispatch = (
        await this.store.get<OperationRequest>('dispatch', attempt.operationId)
      )?.value;
      ensure(
        dispatch &&
          dispatch.payload &&
          typeof dispatch.payload === 'object' &&
          'tree' in dispatch.payload,
        'recovery',
        'Missing durable base',
      );
      state.tree = mergeTrees(
        dispatch.payload.tree as Tree,
        state.tree ?? {},
        result.tree,
      );
      state.work[attempt.workItemId] = 'completed';
    } else {
      const needsHuman = [
        'refused',
        'auth-expired',
        'rate-limited',
        'unknown-event',
        'uncertain',
      ].includes(fact.outcome);
      state.work[attempt.workItemId] =
        fact.stopped && !needsHuman ? 'failed' : 'waiting';
      if (needsHuman)
        state.waiting = {
          reason: fact.outcome,
          owner: 'operator',
          resumeCondition:
            'Resolve authority/provider state, then authorize a fresh attempt or revise the mission',
        };
    }
    await this.save(state, 'attempt.result', [
      {
        kind: 'attempt',
        id: attempt.id,
        expectedVersion: version,
        value: {
          ...attempt,
          state:
            fact.outcome === 'completed'
              ? 'completed'
              : !fact.stopped
                ? 'uncertain'
                : state.work[attempt.workItemId] === 'waiting'
                  ? 'waiting'
                  : 'failed',
          usage: fact.usage,
          stopped: fact.stopped,
          waiting:
            state.work[attempt.workItemId] === 'waiting' ? state.waiting : null,
        },
      },
    ]);
  }
  async cancel(id: string) {
    if ((await this.state(id)).status === 'completed') return this.result(id);
    this.controllers.get(id)?.abort();
    await this.guard.call('cancelMission', id);
    const state = await this.state(id);
    for (const attemptId of state.attempts) {
      const a = (await this.store.get<Attempt>('attempt', attemptId))?.value;
      if (a && !a.stopped) await this.guard.call('stop', a.operationId);
    }
    state.status = 'cancelled';
    state.waiting = null;
    await this.save(state, 'mission.cancelled');
    return this.result(id);
  }
  async result(id: string): Promise<ResultBundle> {
    return (
      (await this.store.get<ResultBundle>('result', id))?.value ??
      this.bundle(await this.mission(id), await this.state(id))
    );
  }
  private async bundle(
    m: MissionRevision,
    s: MissionState,
  ): Promise<ResultBundle> {
    const budget = await this.store.balance(m.id);
    const currentDigest = s.tree ? treeDigest(s.tree) : null;
    const achieved = m.acceptance
      .filter((a) =>
        s.receipts.some(
          (r) =>
            r.checkId === a.checkId &&
            r.result === 'pass' &&
            r.targetDigest === currentDigest,
        ),
      )
      .map((a) => a.id);
    return {
      missionId: m.id,
      missionRevision: m.revision,
      status: s.status === 'ready' ? 'waiting' : s.status,
      achieved,
      artifact: currentDigest
        ? { digest: currentDigest, reference: `candidate:${currentDigest}` }
        : null,
      checks: s.receipts,
      unmet: m.acceptance
        .filter((a) => !achieved.includes(a.id))
        .map((a) => a.id),
      notRun: m.acceptance
        .filter((a) => !s.receipts.some((r) => r.checkId === a.checkId))
        .map((a) => a.checkId),
      decisions: s.waiting
        ? [s.waiting.reason + ': ' + s.waiting.resumeCondition]
        : [],
      usage: {
        certainty: budget.unknown
          ? 'unknown'
          : this.mode === 'fake'
            ? 'measured'
            : 'estimated',
        inputTokens: null,
        outputTokens: null,
        usd: budget.unknown ? null : budget.spent,
      },
      factoryRelease: m.factoryRelease,
      completionSignature: null,
    };
  }
  async createExperiment(id: string): Promise<Experiment> {
    const mission = await this.mission(id),
      state = await this.state(id);
    ensure(
      state.repairs > 0 || state.status === 'failed',
      'experiment',
      'No failure/repair evidence',
    );
    const descriptor = await this.guard.call<{
      lineage: string;
      suiteId: string;
      suiteDigest: string;
    }>('experimentDescriptor', mission.factoryRelease);
    const e: Experiment = {
      id: randomUUID(),
      ...descriptor,
      hypothesis:
        'Builder boundary-case instructions may reduce repair attempts without lowering acceptance',
      cause: 'unknown',
      evidence: [`mission:${id}`, `repairs:${state.repairs}`],
      projectIds: [mission.projectId],
      taskTypes: [mission.taskType],
      baselineRelease: mission.factoryRelease,
      minQuality: 1,
      maxRescue: 0,
      maxUsd: mission.budget.maxUsd,
      maxDurationMs: 600000,
      maxTrials: 3,
      rollbackQuality: 1,
      rollbackRescue: 0,
      minRetryReduction: 1,
      status: 'fixed',
      createdAt: new Date().toISOString(),
    };
    await this.guard.call('experimentFix', e);
    await this.store.commit(
      [{ kind: 'experiment', id: e.id, expectedVersion: 0, value: e }],
      { id: `fixed-${e.id}`, topic: 'experiment.fixed', payload: { id: e.id } },
    );
    return e;
  }
  async runExperiment(id: string, mode: 'fake' | 'live') {
    ensure(mode === this.mode, 'mode', 'Experiment mode mismatch');
    const e = (await this.store.get<Experiment>('experiment', id))?.value;
    ensure(e, 'experiment', 'Experiment not found');
    const releases = await this.guard.call<FactoryRelease[]>(
      'releaseStatus',
      null,
    );
    if (!releases.some((r) => r.experimentId === id)) {
      const callId = randomUUID();
      await this.store.reserve(callId, `experiment-${id}`, 0.1, e.maxUsd);
      try {
        const proposal = await this.coordinator.run(
          AbortSignal.timeout(60000),
          () =>
            this.planner.improve({ experiment: e }, AbortSignal.timeout(60000)),
        );
        await this.guard.call('experimentPropose', {
          id,
          prompt: proposal.prompt,
        });
        await this.store.settle(callId, this.mode === 'fake' ? 0 : null);
      } catch (error) {
        await this.store.settle(callId, null);
        throw error;
      }
    }
    return this.workers.run(AbortSignal.timeout(e.maxDurationMs), () =>
      this.guard.call('experimentRun', id),
    );
  }
}
