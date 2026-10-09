import { randomUUID } from 'node:crypto';
import type {
  Experiment,
  FactoryRelease,
  Evaluation,
  Attempt,
  EvidenceReceipt,
} from '../domain/contracts.js';
import type { GuardService } from './service.js';
import type { CheckPort } from '../ports/agents.js';
import { contract } from '../adapters/contracts.js';
import {
  canonical,
  digest,
  trackedSnapshot,
  treeDigest,
} from '../adapters/artifacts.js';
import {
  ensure,
  evaluateDecision,
  validateRecipeChange,
} from '../domain/invariants.js';
export interface EvaluationSuite {
  id: string;
  cases: {
    id: string;
    partition: 'development' | 'separate';
    projectId: string;
  }[];
}
export class EvolutionService {
  constructor(
    private guard: GuardService,
    private checks: CheckPort,
    private suite: EvaluationSuite,
  ) {}
  async suiteDigest() {
    const cases = [];
    for (const c of this.suite.cases) {
      const profile = this.guard.profile(c.projectId);
      const snapshot = await trackedSnapshot(profile.repository);
      cases.push({
        ...c,
        treeDigest: treeDigest(snapshot.tree),
        checks: profile.checks,
      });
    }
    return digest({ id: this.suite.id, cases });
  }
  async fix(raw: unknown): Promise<Experiment> {
    const experiment = contract('Experiment', raw);
    ensure(
      experiment.status === 'fixed' &&
        experiment.suiteId === this.suite.id &&
        experiment.suiteDigest === (await this.suiteDigest()),
      'evaluation',
      'Unregistered or changed suite',
    );
    ensure(
      experiment.maxTrials <= 3 && experiment.evidence.length > 0,
      'evaluation',
      'Experiment needs evidence and bounded trials',
    );
    const base = await this.guard.release(experiment.baselineRelease);
    ensure(base.stage === 'stable', 'release', 'Baseline unavailable');
    // One prompt-change family shares limits even when a proposer changes experiment IDs.
    const lineage = digest({
      root: await this.rootRelease(base),
      change: 'builder-prompt',
    });
    ensure(
      experiment.lineage === lineage,
      'lineage',
      'Unrecognized candidate lineage',
    );
    ensure(
      experiment.projectIds.every(
        (id) =>
          base.projectIds.includes(id) &&
          this.guard.profile(id).delegation.autoRecipe,
      ) && experiment.taskTypes.every((t) => base.taskTypes.includes(t)),
      'authority',
      'Automatic adoption was not delegated',
    );
    const policy = {
      minQuality: experiment.minQuality,
      maxRescue: experiment.maxRescue,
      maxUsd: experiment.maxUsd,
      maxDurationMs: experiment.maxDurationMs,
      maxTrials: experiment.maxTrials,
      rollbackQuality: experiment.rollbackQuality,
      rollbackRescue: experiment.rollbackRescue,
      minRetryReduction: experiment.minRetryReduction,
      suiteDigest: experiment.suiteDigest,
    };
    const previous = await this.guard.store.get('lineage-policy', lineage);
    ensure(
      !previous || canonical(previous.value) === canonical(policy),
      'evaluation',
      'A lineage cannot relax frozen criteria or budget across experiment IDs',
    );
    await this.guard.store.commit(
      [
        {
          kind: 'experiment',
          id: experiment.id,
          expectedVersion: 0,
          value: experiment,
        },
        ...(!previous
          ? [
              {
                kind: 'lineage-policy',
                id: lineage,
                expectedVersion: 0,
                value: policy,
              },
            ]
          : []),
      ],
      {
        id: `experiment-${experiment.id}`,
        topic: 'experiment.fixed',
        payload: { id: experiment.id },
      },
    );
    return experiment;
  }
  async rootRelease(release: FactoryRelease): Promise<string> {
    return release.parent
      ? this.rootRelease(await this.guard.release(release.parent))
      : release.id;
  }
  async descriptor(baseId: string) {
    return {
      suiteId: this.suite.id,
      suiteDigest: await this.suiteDigest(),
      lineage: digest({
        root: await this.rootRelease(await this.guard.release(baseId)),
        change: 'builder-prompt',
      }),
    };
  }
  async propose(experimentId: string, prompt: string): Promise<FactoryRelease> {
    const row = await this.guard.store.get<Experiment>(
      'experiment',
      experimentId,
    );
    ensure(
      row?.value.status === 'fixed',
      'experiment',
      'Experiment must be fixed before candidate creation',
    );
    ensure(
      prompt.length > 0 && prompt.length < 8000,
      'recipe',
      'Invalid prompt',
    );
    const baseline = await this.guard.release(row.value.baselineRelease);
    const candidate: FactoryRelease = {
      ...baseline,
      id: `candidate-${randomUUID()}`,
      parent: baseline.id,
      experimentId,
      stage: 'candidate',
      projectIds: row.value.projectIds,
      taskTypes: row.value.taskTypes,
      recipe: { ...baseline.recipe, prompt, promptDigest: digest(prompt) },
      createdAt: new Date().toISOString(),
    };
    validateRecipeChange(baseline, candidate);
    ensure(
      !(await this.guard.store.list<FactoryRelease>('release')).some(
        (r) => r.value.experimentId === experimentId,
      ),
      'experiment',
      'Candidate already fixed for experiment',
    );
    await this.guard.store.commit(
      [
        {
          kind: 'release',
          id: candidate.id,
          expectedVersion: 0,
          value: candidate,
        },
      ],
      {
        id: `candidate-${candidate.id}`,
        topic: 'release.candidate',
        payload: { id: candidate.id },
      },
    );
    return candidate;
  }
  async run(experimentId: string): Promise<{
    decision: string;
    baseline: Evaluation;
    candidate: Evaluation;
  }> {
    const row = await this.guard.store.get<Experiment>(
      'experiment',
      experimentId,
    );
    ensure(row, 'experiment', 'Experiment not found');
    const e = row.value;
    if (['adopted', 'rejected', 'held'].includes(e.status)) {
      const baseline = await this.guard.store.get<Evaluation>(
          'evaluation',
          `${e.id}-baseline`,
        ),
        candidate = await this.guard.store.get<Evaluation>(
          'evaluation',
          `${e.id}-candidate`,
        );
      ensure(
        baseline && candidate,
        'uncertain',
        'Experiment interrupted; results require operator reconciliation',
      );
      return {
        decision: e.status,
        baseline: baseline.value,
        candidate: candidate.value,
      };
    }
    ensure(e.status === 'fixed', 'experiment', 'Experiment is not ready');
    ensure(
      e.suiteDigest === (await this.suiteDigest()),
      'evaluation',
      'Evaluation suite changed',
    );
    ensure(
      !(await this.guard.store.list<Experiment>('experiment')).some(
        (r) => r.value.status === 'evaluating',
      ),
      'experiment',
      'Only one improvement experiment may run',
    );
    const candidate = (
      await this.guard.store.list<FactoryRelease>('release')
    ).find((r) => r.value.experimentId === e.id);
    ensure(
      candidate?.value.stage === 'candidate',
      'experiment',
      'Candidate required',
    );
    const trial = await this.guard.store.get<{ count: number }>(
      'lineage',
      e.lineage,
    );
    ensure(
      (trial?.value.count ?? 0) < e.maxTrials,
      'budget',
      'Lineage trial cap reached',
    );
    await this.guard.store.reserve(
      e.id,
      `lineage-${e.lineage}`,
      e.maxUsd,
      e.maxUsd * e.maxTrials,
    );
    await this.guard.store.commit(
      [
        {
          kind: 'lineage',
          id: e.lineage,
          expectedVersion: trial?.version ?? 0,
          value: { count: (trial?.value.count ?? 0) + 1 },
        },
        {
          kind: 'experiment',
          id: e.id,
          expectedVersion: row.version,
          value: { ...e, status: 'evaluating' },
        },
      ],
      {
        id: `trial-${e.id}`,
        topic: 'experiment.started',
        payload: { id: e.id },
      },
    );
    let baselineResult: Evaluation, candidateResult: Evaluation;
    const deadline = AbortSignal.timeout(e.maxDurationMs);
    try {
      baselineResult = await this.evaluate(
        e,
        await this.guard.release(e.baselineRelease),
        deadline,
      );
      candidateResult = await this.evaluate(e, candidate.value, deadline);
    } catch (error) {
      await this.guard.store.settle(e.id, null);
      await this.guard.store.commit(
        [
          {
            kind: 'experiment',
            id: e.id,
            expectedVersion: row.version + 1,
            value: { ...e, status: 'held' },
          },
        ],
        { id: `held-${e.id}`, topic: 'experiment.held', payload: { id: e.id } },
      );
      throw error;
    }
    const decision = evaluateDecision(e, baselineResult, candidateResult);
    const observedUsd =
      baselineResult.usd !== null && candidateResult.usd !== null
        ? baselineResult.usd + candidateResult.usd
        : null;
    await this.guard.store.settle(e.id, observedUsd);
    await this.guard.store.commit(
      [
        {
          kind: 'evaluation',
          id: `${e.id}-baseline`,
          expectedVersion: 0,
          value: baselineResult,
        },
        {
          kind: 'evaluation',
          id: `${e.id}-candidate`,
          expectedVersion: 0,
          value: candidateResult,
        },
        {
          kind: 'experiment',
          id: e.id,
          expectedVersion: row.version + 1,
          value: { ...e, status: decision },
        },
        {
          kind: 'release',
          id: candidate.id,
          expectedVersion: candidate.version,
          value: {
            ...candidate.value,
            stage: decision === 'adopted' ? 'canary' : 'candidate',
          },
        },
      ],
      {
        id: `decision-${e.id}`,
        topic: 'experiment.decided',
        payload: { id: e.id, decision },
      },
    );
    return { decision, baseline: baselineResult, candidate: candidateResult };
  }
  private async evaluate(
    e: Experiment,
    release: FactoryRelease,
    deadline: AbortSignal,
  ): Promise<Evaluation> {
    const started = Date.now();
    let rescues = 0,
      retries = 0,
      cost: number | null = 0;
    const cases: Evaluation['cases'] = [],
      evidenceIds: string[] = [];
    for (const c of this.suite.cases) {
      const profile = this.guard.profile(c.projectId);
      let tree = (await trackedSnapshot(profile.repository)).tree,
        passed = false;
      for (let epoch = 1; epoch <= 2; epoch++) {
        const id = randomUUID();
        const attempt: Attempt = {
          id,
          missionId: `eval-${e.id}`,
          workItemId: c.id,
          epoch,
          leaseUntil: new Date(Date.now() + 120000).toISOString(),
          baseDigest: treeDigest(tree),
          operationId: id,
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
        ensure(!deadline.aborted, 'timeout', 'Experiment deadline exceeded');
        const budgetPerCall = (e.maxUsd - 0.1) / (this.suite.cases.length * 4);
        const recipe = {
          ...release.recipe,
          scope: profile.scope,
          budgetUsd: Math.min(release.recipe.budgetUsd, budgetPerCall),
        };
        await this.guard.store.reserve(
          id,
          `eval-${e.id}`,
          budgetPerCall,
          e.maxUsd,
        );
        const out = await this.guard.runner.run(
          attempt,
          tree,
          profile.acceptance.map((a) => a.description).join('\n'),
          recipe,
          this.guard.config.models.engineer,
          AbortSignal.any([deadline, AbortSignal.timeout(120000)]),
        );
        await this.guard.store.settle(id, out.fact.usage.usd);
        cost =
          cost === null || out.fact.usage.usd === null
            ? null
            : cost + out.fact.usage.usd;
        ensure(
          out.fact.stopped,
          'uncertain',
          'Evaluation worker still running',
        );
        tree = out.tree;
        const results = await this.checks.run(
          tree,
          profile,
          AbortSignal.any([deadline, AbortSignal.timeout(60000)]),
        );
        passed =
          out.fact.outcome === 'completed' &&
          results.length === profile.checks.length &&
          results.every((r) => r.passed);
        const record = {
          experimentId: e.id,
          releaseId: release.id,
          caseId: c.id,
          partition: c.partition,
          targetDigest: treeDigest(tree),
          results,
          signature: this.guard.signature({
            targetDigest: treeDigest(tree),
            results,
          }),
        };
        await this.guard.store.commit(
          [
            {
              kind: 'evaluation-evidence',
              id,
              expectedVersion: 0,
              value: record,
            },
          ],
          {
            id: `eval-evidence-${id}`,
            topic: 'evaluation.checked',
            payload: { id },
          },
        );
        evidenceIds.push(id);
        if (passed) break;
        if (epoch === 1) retries++;
      }
      if (!passed) rescues++;
      cases.push({ id: c.id, partition: c.partition, passed });
    }
    return {
      experimentId: e.id,
      releaseId: release.id,
      suiteDigest: e.suiteDigest,
      quality: cases.filter((c) => c.passed).length / cases.length,
      rescueCount: rescues,
      retryCount: retries,
      usd: cost,
      durationMs: Date.now() - started,
      cases,
      evidenceIds,
    };
  }
  async followup(raw: unknown): Promise<unknown> {
    const bundle = contract('ResultBundle', raw);
    const releaseRow = await this.guard.store.get<FactoryRelease>(
      'release',
      bundle.factoryRelease,
    );
    ensure(releaseRow, 'release', 'Unknown release');
    const release = releaseRow.value;
    if (release.stage !== 'canary') return { action: 'none' };
    if (bundle.status === 'completed') {
      ensure(
        bundle.completionSignature,
        'evidence',
        'Follow-up requires Guard completion proof',
      );
      const { completionSignature, ...rest } = bundle;
      ensure(
        this.guard.verify(
          { ...rest, completionSignature: null },
          completionSignature,
        ),
        'evidence',
        'Forged follow-up',
      );
    } else {
      ensure(
        bundle.status === 'failed' &&
          bundle.checks.some((c) => c.result === 'fail'),
        'evidence',
        'Failed follow-up needs protected failure evidence',
      );
      for (const receipt of bundle.checks) {
        const stored = await this.guard.store.get<EvidenceReceipt>(
          'evidence',
          receipt.id,
        );
        ensure(
          stored &&
            canonical(stored.value) === canonical(receipt) &&
            receipt.missionId === bundle.missionId &&
            receipt.targetDigest === bundle.artifact?.digest,
          'evidence',
          'Forged failure observation',
        );
      }
    }
    const mission = (
      await this.guard.store.get<MissionRevisionForFollowup>(
        'mission',
        bundle.missionId,
      )
    )?.value;
    ensure(
      mission &&
        Date.parse(mission.createdAt) > Date.parse(release.createdAt) &&
        mission.factoryRelease === release.id,
      'release',
      'Only new missions qualify',
    );
    const eventId = `followup-${bundle.missionId}`;
    if (await this.guard.store.get('followup', bundle.missionId))
      return { action: 'duplicate' };
    const experiment = (
      await this.guard.store.get<Experiment>(
        'experiment',
        release.experimentId ?? '',
      )
    )?.value;
    ensure(experiment, 'experiment', 'Missing fixed experiment');
    const quality =
      bundle.checks.filter((c) => c.result === 'pass').length /
      Math.max(1, bundle.checks.length);
    const failed =
      quality < experiment.rollbackQuality ||
      (bundle.status === 'completed' ? 0 : 1) > experiment.rollbackRescue;
    await this.guard.store.commit(
      [
        {
          kind: 'followup',
          id: bundle.missionId,
          expectedVersion: 0,
          value: { releaseId: release.id, failed },
        },
      ],
      {
        id: eventId,
        topic: 'release.observed',
        payload: { id: release.id, failed },
      },
    );
    if (failed) return this.rollback(release.id);
    const followups = (
      await this.guard.store.list<{ releaseId: string; failed: boolean }>(
        'followup',
      )
    ).filter((r) => r.value.releaseId === release.id && !r.value.failed);
    if (followups.length >= 2)
      await this.guard.store.commit(
        [
          {
            kind: 'release',
            id: release.id,
            expectedVersion: releaseRow.version,
            value: { ...release, stage: 'stable' },
          },
        ],
        {
          id: `stable-${release.id}`,
          topic: 'release.stable',
          payload: { id: release.id },
        },
      );
    return { action: followups.length >= 2 ? 'stable' : 'observe' };
  }
  async rollback(id: string): Promise<unknown> {
    const row = await this.guard.store.get<FactoryRelease>('release', id);
    ensure(row && row.value.parent, 'release', 'Cannot roll back root release');
    if (row.value.stage !== 'revoked')
      await this.guard.store.commit(
        [
          {
            kind: 'release',
            id,
            expectedVersion: row.version,
            value: { ...row.value, stage: 'revoked' },
          },
        ],
        { id: `revoke-${id}`, topic: 'release.revoked', payload: { id } },
      );
    const operations = (
      await this.guard.store.list<import('../ports/guard.js').OperationRecord>(
        'operation',
      )
    ).filter(
      (r) =>
        r.value.request.mission.factoryRelease === id &&
        ['pending', 'uncertain'].includes(r.value.state),
    );
    const previous = await this.guard.store.get('rollback', id);
    if (previous && operations.length === 0) return previous.value;
    const reconciled = [];
    for (const op of operations)
      reconciled.push({
        id: op.id,
        ...((await this.guard.call('reconcile', op.id)) as object),
      });
    const value = {
      release: id,
      stable: row.value.parent,
      reconciled,
      productRestored: false,
    };
    await this.guard.store.commit(
      [
        {
          kind: 'rollback',
          id,
          expectedVersion: previous?.version ?? 0,
          value,
        },
      ],
      {
        id: `rollback-${id}-${randomUUID()}`,
        topic: 'release.rollback',
        payload: { id, reconciled },
      },
    );
    return {
      release: id,
      stable: row.value.parent,
      reconciled,
      productRestored: false,
    };
  }
}
type MissionRevisionForFollowup = { createdAt: string; factoryRelease: string };
