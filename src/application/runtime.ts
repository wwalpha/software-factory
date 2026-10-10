import { Lane } from './lanes.js';
import {
  boundedInput,
  reportContext,
  REPORT_CONTEXT_BYTES,
  ROLE_INPUT_BYTES,
  BUILDER_INPUT_BYTES,
} from './report-context.js';
import { randomUUID } from 'node:crypto';
import type { RoleExecution } from '../ports/role-execution.js';
import type { PersistencePort, CommitBudget } from '../ports/store.js';
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
  WorkItem,
  RoleReport,
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
  roleJournalVersion?: 1;
  failureAnalysisId?: string;
  pendingFailure?: { review: RoleReport; targetDigest: string };
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
    delete state.failureAnalysisId;
    delete state.pendingFailure;
    await this.save(
      {
        ...state,
        status: 'ready',
        waiting: null,
        plan: null,
        planRevision: 0,
        work: {},
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
    const saved = await this.store.get<OperationRequest>(
      'dispatch',
      request.id,
    );
    if (saved)
      ensure(
        digest(saved.value) === digest(request),
        'duplicate-conflict',
        'Dispatch ID reused with different request',
      );
    else
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
  private async admit(
    state: MissionState,
    attempt: Attempt,
    request: OperationRequest,
  ): Promise<void> {
    const event = {
      id: `dispatch-${request.id}`,
      topic: 'guard.dispatch',
      payload: {
        missionId: state.missionId,
        id: request.id,
        attemptId: attempt.id,
      },
    };
    const write = this.writes.then(async () => {
      const row = await this.store.get<MissionState>('state', state.missionId);
      ensure(row, 'mission', 'Mission not found');
      const snapshot = structuredClone(state);
      snapshot.attempts = [
        ...new Set([...row.value.attempts, ...snapshot.attempts, attempt.id]),
      ];
      snapshot.work[attempt.workItemId] = 'running';
      const writes = [
        {
          kind: 'state',
          id: state.missionId,
          expectedVersion: row.version,
          value: snapshot,
        },
        { kind: 'attempt', id: attempt.id, expectedVersion: 0, value: attempt },
        {
          kind: 'dispatch',
          id: request.id,
          expectedVersion: 0,
          value: request,
        },
      ];
      rejectSecrets({ writes, event }, this.secrets);
      try {
        await this.store.commit(writes, event, {
          attemptId: attempt.id,
          missionId: state.missionId,
        });
      } catch (error) {
        // A lost commit reply must be reconciled with the same identities before dispatch.
        const saved = await this.store.get<Attempt>('attempt', attempt.id);
        const dispatch = await this.store.get<OperationRequest>(
          'dispatch',
          request.id,
        );
        const durable = await this.state(state.missionId);
        if (
          !saved ||
          digest(saved.value) !== digest(attempt) ||
          !dispatch ||
          digest(dispatch.value) !== digest(request) ||
          !durable.attempts.includes(attempt.id)
        )
          throw error;
      }
      state.attempts = snapshot.attempts;
      state.work[attempt.workItemId] = 'running';
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }
  async recover(id: string, resumeRoles = false): Promise<MissionState> {
    const state = await this.state(id);
    const mission = await this.mission(id);
    if (['completed', 'cancelled'].includes(state.status)) return state;
    state.attempts = [
      ...new Set([
        ...state.attempts,
        ...(await this.store.list<Attempt>('attempt'))
          .filter((a) => a.value.missionId === id)
          .map((a) => a.id),
      ]),
    ];
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
      const dispatch = await this.store.get<OperationRequest>(
        'dispatch',
        attempt.operationId,
      );
      if (dispatch && dispatch.value.mission.revision !== mission.revision)
        continue;
      const operation = await this.guard.call<OperationRecord | null>(
        'operationStatus',
        attempt.operationId,
      );
      if (!operation && attempt.state === 'reserved') {
        ensure(dispatch, 'recovery', 'Missing admitted dispatch');
        try {
          const result = await this.workers.run(
            AbortSignal.timeout(120000),
            () => this.operation<BuildResult>(dispatch.value),
          );
          await this.accept(state, row.version, attempt, result);
        } catch (error) {
          state.work[attempt.workItemId] = 'waiting';
          state.waiting = this.waiting(error);
        }
        continue;
      }
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
    await this.recoverRoles(state, mission, resumeRoles);
    if (Object.values(state.work).includes('waiting')) state.status = 'waiting';
    await this.save(state, 'mission.reconciled');
    return state;
  }
  async resume(id: string, mode: 'fake' | 'live'): Promise<ResultBundle> {
    return this.run(id, mode, true);
  }
  async run(
    id: string,
    mode: 'fake' | 'live',
    resumeRoles = false,
  ): Promise<ResultBundle> {
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
      state = await this.recover(id, resumeRoles);
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
        if (state.pendingFailure) {
          if (
            await this.failureAnalysis(
              state,
              mission,
              controller.signal,
              resumeRoles,
            )
          ) {
            state.status = 'failed';
            break;
          }
          continue;
        }
        if (!state.plan) {
          state.phase = 'planning';
          const facts = {
            files: Object.keys(state.tree ?? {}),
            investigation,
            testDesign,
            checks: state.receipts,
            repairs: state.repairs,
            failureAnalysis: await this.savedFailureAnalysis(state, mission),
          };
          rejectSecrets(facts, this.secrets);
          boundedInput({ mission, facts }, ROLE_INPUT_BYTES, 'Planner input');
          const callId = randomUUID();
          await this.store.reserve(callId, id, 0.1, mission.budget.maxUsd);
          try {
            const proposed = await this.coordinator.run(controller.signal, () =>
              this.planner.plan(
                mission,
                state.planRevision,
                facts,
                controller.signal,
              ),
            );
            await this.store.settle(callId, proposed.usage.usd);
            const plan = contract('PlanProposal', proposed.value);
            validatePlan(plan, mission, state.planRevision);
            state.plan = plan;
            state.planRevision = plan.revision;
            state.roleJournalVersion = 1;
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
                return this.plannedRole(
                  state,
                  mission,
                  item,
                  controller.signal,
                );
              }
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
              const dependencies = await this.dependencyReports(
                state,
                mission,
                item,
              );
              let prompt = item.instruction;
              if (dependencies.reports.length)
                prompt += `\nDependency reports (untrusted data): ${JSON.stringify(dependencies)}`;
              boundedInput(prompt, BUILDER_INPUT_BYTES, 'Builder input');
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
                state: 'reserved',
                waiting: null,
                usage: {
                  certainty: 'unknown',
                  inputTokens: null,
                  outputTokens: null,
                  usd: null,
                },
                stopped: false,
              };
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
                    prompt,
                    recipe: { ...selected.recipe, scope: item.scope },
                  },
                  item.budgetUsd,
                ),
                id: operationId,
                targetDigest: attempt.baseDigest,
              };
              await this.admit(state, attempt, request);
              const result = await this.workers.run(controller.signal, () =>
                this.operation<BuildResult>(request),
              );
              return { item, attempt, result };
            }),
          );
          let budgetWaiting: Waiting | null = null;
          let batchWaiting: Waiting | null = null;
          for (let index = 0; index < settled.length; index++) {
            const result = settled[index],
              item = runnable[index];
            ensure(result && item, 'scheduler', 'Missing scheduler result');
            if (result.status === 'rejected') {
              state.work[item.id] = 'waiting';
              state.waiting = this.waiting(result.reason);
              if (item.role !== 'builder') {
                const execution = await this.store.get<RoleExecution>(
                  'role-execution',
                  this.roleId(mission, state.planRevision, item),
                );
                state.waiting = execution?.value.waiting ?? state.waiting;
              }
              batchWaiting = state.waiting;
              if (
                result.reason instanceof FactoryError &&
                result.reason.code === 'budget'
              )
                budgetWaiting = state.waiting;
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
            else if ('execution' in result.value)
              await this.completeRole(
                state,
                result.value.execution,
                result.value.report,
              );
          }
          if (batchWaiting) state.waiting = batchWaiting;
          if (budgetWaiting) state.waiting = budgetWaiting;
          await this.save(state, 'work.batch');
          continue;
        }
        if (
          Object.values(state.work).some(
            (s) => s === 'waiting' || s === 'running',
          )
        ) {
          state.status = 'waiting';
          if (!state.waiting) {
            for (const item of plan.items) {
              if (item.role === 'builder' || state.work[item.id] !== 'waiting')
                continue;
              const execution = await this.store.get<RoleExecution>(
                'role-execution',
                this.roleId(mission, state.planRevision, item),
              );
              if (execution?.value.waiting) {
                state.waiting = execution.value.waiting;
                break;
              }
            }
          }
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
        state.pendingFailure = {
          review,
          targetDigest: treeDigest(state.tree ?? {}),
        };
        await this.save(state, 'mission.diagnosing');
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
    let reason = code;
    if (
      [
        'budget',
        'report-context-size',
        'report-unavailable',
        'secret',
      ].includes(code) &&
      error instanceof Error
    )
      reason = `${code}: ${error.message}`;
    return {
      reason,
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
  private roleId(
    mission: MissionRevision,
    planRevision: number,
    item: WorkItem,
    purpose?: RoleExecution['purpose'],
  ): string {
    const identity = {
      missionId: mission.id,
      missionRevision: mission.revision,
      planRevision,
      workItemId: item.id,
      role: item.role,
    };
    if (purpose) return digest({ ...identity, purpose });
    return digest(identity);
  }
  private async dependencyReports(
    state: MissionState,
    mission: MissionRevision,
    item: WorkItem,
  ) {
    const selected: RoleExecution[] = [];
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      const dependency = state.plan?.items.find((i) => i.id === id);
      ensure(
        dependency && state.work[id] === 'completed',
        'report-unavailable',
        `Incomplete dependency ${id}`,
      );
      for (const ancestor of dependency.dependsOn) await visit(ancestor);
      if (dependency.role === 'builder') return;
      const key = this.roleId(mission, state.planRevision, dependency);
      const row = await this.store.get<RoleExecution>('role-execution', key);
      const execution = row?.value;
      ensure(
        execution &&
          execution.id === key &&
          execution.missionId === mission.id &&
          execution.missionRevision === mission.revision &&
          execution.planRevision === state.planRevision &&
          execution.workItemId === id &&
          execution.role === dependency.role &&
          !execution.purpose,
        'report-unavailable',
        `Invalid dependency report ${id}`,
      );
      rejectSecrets(execution.result, this.secrets);
      selected.push(execution);
    };
    for (const id of item.dependsOn) await visit(id);
    return reportContext(selected, treeDigest(state.tree ?? {}));
  }
  private async savedFailureAnalysis(
    state: MissionState,
    mission: MissionRevision,
  ) {
    if (!state.failureAnalysisId) return null;
    const execution = (
      await this.store.get<RoleExecution>(
        'role-execution',
        state.failureAnalysisId,
      )
    )?.value;
    ensure(
      execution &&
        execution.id === state.failureAnalysisId &&
        execution.purpose === 'failure-analysis' &&
        execution.role === 'failure-analyst' &&
        execution.workItemId === 'final-failure-analysis' &&
        execution.missionId === mission.id &&
        execution.missionRevision === mission.revision &&
        execution.planRevision <= state.planRevision,
      'report-unavailable',
      'Invalid saved failure diagnosis',
    );
    rejectSecrets(execution.result, this.secrets);
    return reportContext([execution], treeDigest(state.tree ?? {}), true);
  }
  private async failureAnalysis(
    state: MissionState,
    mission: MissionRevision,
    signal: AbortSignal,
    resume: boolean,
  ) {
    ensure(
      state.pendingFailure,
      'recovery',
      'Missing final verification review',
    );
    ensure(
      state.pendingFailure.targetDigest === treeDigest(state.tree ?? {}),
      'snapshot',
      'Final verification snapshot changed before diagnosis',
    );
    const item: WorkItem = {
      id: 'final-failure-analysis',
      role: 'failure-analyst',
      dependsOn: [],
      scope: mission.scope,
      acceptanceIds: [],
      instruction:
        'Diagnose final verification failure using only supplied evidence; distinguish hypotheses and unknowns.',
      budgetUsd: 0.1,
    };
    const id = this.roleId(
      mission,
      state.planRevision,
      item,
      'failure-analysis',
    );
    const prior = (await this.store.get<RoleExecution>('role-execution', id))
      ?.value;
    if (prior) {
      const outstanding = prior.calls.filter((c) => c.state === 'running');
      if (outstanding.length) {
        this.roleFailure(
          prior,
          new FactoryError('uncertain', 'Missing durable diagnosis result'),
        );
        for (const call of outstanding) call.state = 'uncertain';
        await this.writeRole(prior, {
          settlements: outstanding.map((c) => ({ id: c.id, actual: null })),
        });
      }
      ensure(
        prior.state === 'completed' ||
          prior.state === 'running' ||
          (resume && prior.retryable),
        prior.failureCode ?? 'uncertain',
        prior.waiting?.reason ?? 'Diagnosis requires inspection',
      );
    }
    const result = await this.plannedRole(state, mission, item, signal, {
      mission,
      planRevision: state.planRevision,
      targetDigest: treeDigest(state.tree ?? {}),
      checks: state.receipts,
      review: state.pendingFailure.review,
      instruction: item.instruction,
    });
    await this.completeRole(state, result.execution, result.report);
    return state.status === 'failed';
  }
  private roleFailure(
    execution: RoleExecution,
    error: unknown,
  ): RoleExecution['state'] {
    const code = classifyProviderError(error);
    execution.failureCode = code;
    execution.retryable = [
      'rate-limited',
      'auth-expired',
      'grant',
      'binding',
      'revoked',
      'budget',
    ].includes(code);
    execution.state = 'failed';
    let resumeCondition =
      'Inspect this role failure, then submit a new mission revision with human clarification and a matching grant';
    if (execution.retryable) {
      execution.state = 'waiting';
      resumeCondition =
        'Correct the reported condition, then explicitly resume; authorization, provider access and budget are rechecked';
    }
    if (code === 'approval') execution.state = 'waiting';
    if (
      !execution.retryable &&
      ![
        'refused',
        'incomplete',
        'invalid-output',
        'schema',
        'scope',
        'read',
        'approval',
        'secret',
        'report-context-size',
        'report-unavailable',
      ].includes(code)
    ) {
      execution.state = 'uncertain';
      execution.retryable = false;
      resumeCondition =
        'Inspect provider outcome and accounting, then submit a new mission revision with human clarification and a matching grant';
    }
    let owner: Waiting['owner'] = 'operator';
    if (code === 'rate-limited') owner = 'provider';
    execution.waiting = {
      reason: `Non-Builder ${execution.workItemId}: ${this.waiting(error).reason}`,
      owner,
      resumeCondition,
    };
    return execution.state;
  }
  private async writeRole(
    execution: RoleExecution,
    budget?: CommitBudget,
  ): Promise<void> {
    rejectSecrets(execution, this.secrets);
    const row = await this.store.get<RoleExecution>(
      'role-execution',
      execution.id,
    );
    try {
      await this.store.commit(
        [
          {
            kind: 'role-execution',
            id: execution.id,
            expectedVersion: row?.version ?? 0,
            value: execution,
          },
        ],
        {
          id: randomUUID(),
          topic: 'role.execution',
          payload: {
            missionId: execution.missionId,
            executionId: execution.id,
          },
        },
        undefined,
        budget,
      );
    } catch (error) {
      // A lost reply is reusable only when the full transaction is durable.
      const saved = await this.store.get<RoleExecution>(
        'role-execution',
        execution.id,
      );
      if (!saved || digest(saved.value) !== digest(execution)) throw error;
    }
  }
  private async journalReport(
    mission: MissionRevision,
    execution: RoleExecution,
    role: Parameters<PlanningPort['report']>[0],
    input: unknown,
    signal: AbortSignal,
  ): Promise<RoleReport> {
    const inputDigest = digest(input);
    const cached = execution.calls.find(
      (call) => call.inputDigest === inputDigest && call.state === 'completed',
    );
    if (cached?.report) return contract('RoleReport', cached.report);
    return this.review.run(signal, async () => {
      const state = await this.state(mission.id);
      ensure(
        !signal.aborted && state.status !== 'cancelled',
        'cancelled',
        'Mission cancelled',
      );
      ensure(
        state.startedAt &&
          Date.now() - Date.parse(state.startedAt) <
            mission.budget.maxMinutes * 60000,
        'budget',
        'Mission time budget exhausted',
      );
      await this.guard.call('authorizeRole', {
        mission,
        grantId: state.grantId,
      });
      const started = structuredClone(execution);
      started.state = 'running';
      started.failureCode = null;
      started.retryable = false;
      started.waiting = null;
      const call: RoleExecution['calls'][number] = {
        id: randomUUID(),
        inputDigest,
        snapshotDigest: execution.snapshotDigest,
        state: 'running',
        report: null,
        failureCode: null,
        usage: {
          certainty: 'unknown',
          inputTokens: null,
          outputTokens: null,
          usd: null,
        },
      };
      started.calls.push(call);
      await this.writeRole(started, {
        reservation: {
          id: call.id,
          account: mission.id,
          amount: 0.1,
          limit: mission.budget.maxUsd,
        },
      });
      Object.assign(execution, started);
      let response: Awaited<ReturnType<PlanningPort['report']>>;
      try {
        ensure(
          !signal.aborted,
          'cancelled',
          'Mission cancelled before provider dispatch',
        );
        response = await this.planner.report(role, input, signal);
        contract('RoleReport', response.value);
        rejectSecrets(response.value, this.secrets);
        boundedInput(
          response.value,
          REPORT_CONTEXT_BYTES,
          `Report ${execution.workItemId}`,
        );
      } catch (error) {
        const failureState = this.roleFailure(started, error);
        call.failureCode = started.failureCode;
        call.state = 'failed';
        if (failureState === 'uncertain') call.state = 'uncertain';
        await this.writeRole(started, {
          settlements: [{ id: call.id, actual: null }],
        });
        Object.assign(execution, started);
        throw error;
      }
      call.state = 'completed';
      call.report = response.value;
      call.usage = response.usage;
      await this.writeRole(started, {
        settlements: [{ id: call.id, actual: response.usage.usd }],
      });
      Object.assign(execution, started);
      return response.value;
    });
  }
  private async plannedRole(
    state: MissionState,
    mission: MissionRevision,
    item: WorkItem,
    signal: AbortSignal,
    diagnosticInput?: unknown,
  ) {
    let purpose: RoleExecution['purpose'];
    if (diagnosticInput) purpose = 'failure-analysis';
    const id = this.roleId(mission, state.planRevision, item, purpose);
    const prior = await this.store.get<RoleExecution>('role-execution', id);
    let input = diagnosticInput;
    if (!input) {
      const dependencyReports = await this.dependencyReports(
        state,
        mission,
        item,
      );
      input = { mission, item, tree: state.tree };
      if (dependencyReports.reports.length)
        input = { mission, item, tree: state.tree, dependencyReports };
    }
    const execution: RoleExecution = prior?.value ?? {
      id,
      missionId: mission.id,
      missionRevision: mission.revision,
      planRevision: state.planRevision,
      workItemId: item.id,
      role: item.role,
      inputDigest: digest(input),
      snapshotDigest: treeDigest(state.tree ?? {}),
      state: 'running',
      failureCode: null,
      retryable: false,
      waiting: null,
      calls: [],
      result: null,
    };
    if (purpose) execution.purpose = purpose;
    if (execution.state === 'completed' && execution.result)
      return {
        item,
        execution,
        report: contract('RoleReport', execution.result),
      };
    execution.inputDigest = digest(input);
    execution.snapshotDigest = treeDigest(state.tree ?? {});
    let role: Parameters<PlanningPort['report']>[0] = 'explorer';
    if (
      item.role === 'explorer' ||
      item.role === 'reviewer' ||
      item.role === 'test-designer' ||
      item.role === 'failure-analyst'
    )
      role = item.role;
    try {
      const report = await this.roleCall(
        mission.id,
        role,
        input,
        signal,
        execution,
        item.scope,
      );
      return { item, execution, report };
    } catch (error) {
      const durable =
        (await this.store.get<RoleExecution>('role-execution', id))?.value ??
        execution;
      const before = digest(durable);
      const outstanding = durable.calls.filter(
        (call) => call.state === 'running',
      );
      if (outstanding.length)
        this.roleFailure(
          durable,
          new FactoryError('uncertain', 'Role result was not persisted'),
        );
      else this.roleFailure(durable, error);
      for (const call of outstanding) call.state = 'uncertain';
      if (digest(durable) !== before || outstanding.length)
        await this.writeRole(durable, {
          settlements: outstanding.map((call) => ({
            id: call.id,
            actual: null,
          })),
        });
      throw new FactoryError(
        durable.failureCode ?? 'uncertain',
        durable.waiting?.reason ?? 'Role stopped',
      );
    }
  }
  private async completeRole(
    state: MissionState,
    execution: RoleExecution,
    report: RoleReport,
  ) {
    const next = structuredClone(state);
    if (execution.purpose === 'failure-analysis') {
      next.failureAnalysisId = execution.id;
      delete next.pendingFailure;
      next.repairs++;
      if (
        next.attempts.length >=
        (await this.mission(state.missionId)).budget.maxAttempts
      ) {
        next.waiting = this.waiting(
          new FactoryError('budget', 'Attempt budget exhausted'),
        );
        next.status = 'failed';
      } else next.plan = null;
    } else next.work[execution.workItemId] = 'completed';
    const completed: RoleExecution = {
      ...execution,
      state: 'completed',
      result: report,
      failureCode: null,
      retryable: false,
      waiting: null,
    };
    const row = await this.store.get<RoleExecution>(
      'role-execution',
      execution.id,
    );
    ensure(row, 'recovery', 'Missing role execution');
    try {
      await this.save(next, 'role.completed', [
        {
          kind: 'role-execution',
          id: execution.id,
          expectedVersion: row.version,
          value: completed,
        },
      ]);
    } catch (error) {
      const saved = await this.store.get<RoleExecution>(
        'role-execution',
        execution.id,
      );
      const durable = await this.state(state.missionId);
      if (
        !saved ||
        digest(saved.value) !== digest(completed) ||
        (execution.purpose === 'failure-analysis' &&
          durable.failureAnalysisId !== execution.id) ||
        (!execution.purpose &&
          durable.work[execution.workItemId] !== 'completed')
      )
        throw error;
    }
    Object.assign(state, next);
    if (!next.pendingFailure) delete state.pendingFailure;
  }
  private async recoverRoles(
    state: MissionState,
    mission: MissionRevision,
    resume: boolean,
  ) {
    if (state.status === 'ready' && !state.startedAt)
      state.roleJournalVersion = 1;
    for (const item of state.plan?.items ?? []) {
      if (item.role === 'builder') continue;
      const id = this.roleId(mission, state.planRevision, item);
      const row = await this.store.get<RoleExecution>('role-execution', id);
      if (!row) {
        if (
          state.work[item.id] === 'pending' &&
          (state.roleJournalVersion === 1 ||
            (state.status === 'ready' && !state.startedAt))
        )
          continue;
        state.work[item.id] = 'waiting';
        state.waiting = {
          reason: `Non-Builder ${item.id}: legacy execution history/result unavailable`,
          owner: 'operator',
          resumeCondition:
            'Inspect historical work, then submit a new mission revision with human clarification and a matching grant',
        };
        continue;
      }
      const execution = row.value;
      if (execution.state === 'completed' && execution.result) {
        contract('RoleReport', execution.result);
        state.work[item.id] = 'completed';
        continue;
      }
      const outstanding = execution.calls.filter(
        (call) => call.state === 'running',
      );
      if (outstanding.length || execution.state === 'completed') {
        this.roleFailure(
          execution,
          new FactoryError('uncertain', 'Missing durable role result'),
        );
        for (const call of outstanding) call.state = 'uncertain';
        await this.writeRole(execution, {
          settlements: outstanding.map((call) => ({
            id: call.id,
            actual: null,
          })),
        });
      }
      const lastCall = execution.calls.at(-1);
      if (
        execution.state === 'running' &&
        lastCall?.state === 'completed' &&
        lastCall.report &&
        lastCall.report.reads.paths.length === 0
      ) {
        await this.completeRole(
          state,
          execution,
          contract('RoleReport', lastCall.report),
        );
        continue;
      }
      if (execution.state === 'running' || (resume && execution.retryable)) {
        state.work[item.id] = 'pending';
      } else {
        state.work[item.id] = 'waiting';
        state.waiting = execution.waiting;
      }
    }
    if (!Object.values(state.work).includes('waiting')) state.waiting = null;
  }
  private async roleCall(
    id: string,
    role: 'explorer' | 'reviewer' | 'test-designer' | 'failure-analyst',
    input: unknown,
    signal: AbortSignal,
    execution?: RoleExecution,
    scope?: string[],
  ): Promise<RoleReport> {
    const mission = await this.mission(id);
    const invoke = async (value: unknown): Promise<RoleReport> => {
      rejectSecrets(value, this.secrets);
      boundedInput(value, ROLE_INPUT_BYTES, 'Role input');
      if (execution)
        return this.journalReport(mission, execution, role, value, signal);
      const callId = randomUUID();
      await this.store.reserve(callId, id, 0.1, mission.budget.maxUsd);
      let settled = false;
      try {
        const report = await this.review.run(signal, () =>
          this.planner.report(role, value, signal),
        );
        await this.store.settle(callId, report.usage.usd);
        settled = true;
        const validatedReport = contract('RoleReport', report.value);
        rejectSecrets(validatedReport, this.secrets);
        boundedInput(validatedReport, REPORT_CONTEXT_BYTES, `Report ${role}`);
        return validatedReport;
      } catch (error) {
        if (!settled) await this.store.settle(callId, null);
        throw error;
      }
    };
    const value = await invoke(input);
    if (!value.reads.paths.length) return value;
    ensure(value.reads.paths.length <= 8, 'scope', 'Too many requested reads');
    const tree = (await this.state(id)).tree;
    ensure(tree, 'snapshot', 'Read snapshot unavailable');
    const reads: Record<string, string> = {};
    for (const path of value.reads.paths) {
      ensure(
        inScope(path, mission.scope),
        'scope',
        'Role read escapes mission',
      );
      if (scope)
        ensure(
          inScope(path, scope),
          'scope',
          'Role requested out-of-scope read',
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
    const answer = await invoke({
      input,
      authorizedReads: reads,
      instruction:
        'Use these authorized facts; return no further read requests.',
    });
    ensure(
      answer.reads.paths.length === 0,
      'read',
      'Role exceeded bounded read round',
    );
    return answer;
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
