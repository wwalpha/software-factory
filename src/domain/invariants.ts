import type {
  MissionRevision,
  PlanProposal,
  WorkItem,
  Handoff,
  Attempt,
  FactoryRelease,
  Experiment,
  Evaluation,
} from './contracts.js';
export class FactoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FactoryError';
  }
}
export function ensure(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new FactoryError(code, message);
}
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every(
        (p) =>
          p !== '..' &&
          p !== '.' &&
          p !== '' &&
          !/^\.git(?:$|modules$|attributes$)/i.test(p) &&
          !/^\.env(?:\.|$)/i.test(p) &&
          ![
            '.aws',
            '.ssh',
            '.codex',
            '.factory',
            'node_modules',
            '__proto__',
            'constructor',
            'prototype',
          ].includes(p),
      ) &&
    !/\.(pem|key)$/i.test(path)
  );
}
export function inScope(path: string, scope: string[]): boolean {
  return (
    safePath(path) &&
    scope.some(
      (s) => path === s || path.startsWith(s.endsWith('/') ? s : `${s}/`),
    )
  );
}
export function validateMission(m: MissionRevision): void {
  ensure(
    m.scope.length && m.scope.every(safePath),
    'scope',
    'Mission scope must contain safe relative paths',
  );
  ensure(
    m.acceptance.length &&
      new Set(m.acceptance.map((a) => a.id)).size === m.acceptance.length,
    'acceptance',
    'Acceptance must be nonempty and unique',
  );
  ensure(
    m.delegation.operations.includes('check') &&
      m.delegation.operations.includes('seal'),
    'authority',
    'Check and sealed delivery authority required',
  );
}
export function validatePlan(
  plan: PlanProposal,
  mission: MissionRevision,
  currentRevision: number,
  achieved: string[] = [],
): void {
  ensure(
    plan.missionId === mission.id &&
      plan.missionRevision === mission.revision &&
      plan.parentRevision === currentRevision &&
      plan.revision === currentRevision + 1,
    'stale-plan',
    'Plan parent or mission revision changed',
  );
  ensure(
    plan.items.length &&
      plan.estimatedUsd <= mission.budget.maxUsd &&
      plan.items.reduce((n, i) => n + i.budgetUsd, 0) <= plan.estimatedUsd,
    'budget',
    'Plan exceeds budget',
  );
  const items = new Map<string, WorkItem>();
  for (const item of plan.items) {
    ensure(!items.has(item.id), 'dag', 'Duplicate work item');
    items.set(item.id, item);
    ensure(
      item.scope.length && item.scope.every((p) => inScope(p, mission.scope)),
      'scope',
      'Work item escapes mission',
    );
    ensure(
      item.acceptanceIds.every((id) =>
        mission.acceptance.some((a) => a.id === id),
      ),
      'acceptance',
      'Unknown acceptance condition',
    );
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    ensure(!visiting.has(id), 'dag', 'Cycle in plan');
    const item = items.get(id);
    ensure(item, 'dag', 'Missing dependency');
    visiting.add(id);
    item.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  items.forEach((_, id) => visit(id));
  ensure(
    mission.acceptance.every(
      (a) =>
        achieved.includes(a.id) ||
        plan.items.some((i) => i.acceptanceIds.includes(a.id)),
    ),
    'acceptance',
    'Plan leaves unmet acceptance behind',
  );
}
export function validateHandoff(h: Handoff, a: Attempt): void {
  ensure(
    a.stopped &&
      h.attemptId === a.id &&
      h.epoch === a.epoch &&
      h.baseDigest === a.baseDigest,
    'stale-result',
    'Execution must stop and epoch/base must match',
  );
}
export function mayTakeOver(
  a: Attempt,
  stopped: boolean,
  now = Date.now(),
): void {
  ensure(
    Date.parse(a.leaseUntil) < now && stopped,
    'lease',
    'Expired heartbeat alone does not permit takeover',
  );
}
export function validateRecipeChange(
  base: FactoryRelease,
  candidate: FactoryRelease,
): void {
  ensure(
    candidate.parent === base.id && candidate.kind === 'recipe',
    'authority',
    'Only recipe changes can be auto-adopted',
  );
  const b = { ...base.recipe, prompt: '', promptDigest: '' };
  const c = { ...candidate.recipe, prompt: '', promptDigest: '' };
  ensure(
    JSON.stringify(b) === JSON.stringify(c),
    'authority',
    'Automatic evolution may change prompt text only',
  );
  ensure(
    candidate.projectIds.every((x) => base.projectIds.includes(x)) &&
      candidate.taskTypes.every((x) => base.taskTypes.includes(x)),
    'authority',
    'Release scope may not expand',
  );
}
export function evaluateDecision(
  e: Experiment,
  baseline: Evaluation,
  candidate: Evaluation,
): 'adopted' | 'rejected' | 'held' {
  ensure(
    [baseline, candidate].every(
      (x) => x.experimentId === e.id && x.suiteDigest === e.suiteDigest,
    ),
    'evaluation',
    'Evaluation input mismatch',
  );
  if (
    baseline.usd === null ||
    candidate.usd === null ||
    !candidate.cases.some((c) => c.partition === 'separate')
  )
    return 'held';
  if (
    candidate.quality < e.minQuality ||
    candidate.quality < baseline.quality ||
    candidate.rescueCount > e.maxRescue ||
    candidate.usd > e.maxUsd ||
    candidate.durationMs > e.maxDurationMs
  )
    return 'rejected';
  return candidate.rescueCount < baseline.rescueCount ||
    candidate.quality > baseline.quality ||
    (e.minRetryReduction > 0 &&
      baseline.retryCount - candidate.retryCount >= e.minRetryReduction)
    ? 'adopted'
    : 'held';
}
