import type { PlanningPort, RunnerPort } from '../ports/agents.js';
import type {
  Attempt,
  RoleRecipe,
  ModelBinding,
  MissionRevision,
  PlanProposal,
  ProjectProfile,
  Usage,
  RoleReport,
  RunnerFact,
} from '../domain/contracts.js';
import { type Tree, treeDigest, validateCandidate } from './artifacts.js';
import { ensure } from '../domain/invariants.js';
export const fakeUsage: Usage = {
  certainty: 'measured',
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
};
export interface FakeEdit {
  path: string;
  before: string;
  after: string;
}
export class FakePlanner implements PlanningPort {
  async draft(
    requirements: string,
    _profile: ProjectProfile,
    _signal: AbortSignal,
  ) {
    return {
      value: {
        objective: requirements.trim(),
        nonGoals: ['Production deployment', 'Remote push'],
        ambiguities: [],
      },
      usage: fakeUsage,
    };
  }
  async plan(
    mission: MissionRevision,
    revision: number,
    facts: unknown,
    _signal: AbortSignal,
  ): Promise<{ value: PlanProposal; usage: Usage }> {
    const items = mission.scope.map((path, index) => ({
      id: `work-${revision + 1}-${index}`,
      role: 'builder' as const,
      dependsOn: [],
      scope: [path],
      acceptanceIds: mission.acceptance.map((a) => a.id),
      instruction: `${mission.objective}\nPrevious execution facts: ${JSON.stringify(facts)}`,
      budgetUsd: Math.min(
        0.2,
        mission.budget.maxUsd / (mission.scope.length + 4),
      ),
    }));
    return {
      value: {
        missionId: mission.id,
        revision: revision + 1,
        parentRevision: revision,
        missionRevision: mission.revision,
        items,
        estimatedUsd: items.reduce((n, x) => n + x.budgetUsd, 0),
        rationale: revision
          ? 'Replan from protected check failures'
          : 'Independent work is derived from mission scope',
      },
      usage: fakeUsage,
    };
  }
  async report(
    _role: unknown,
    _input: unknown,
    _signal: AbortSignal,
  ): Promise<{ value: RoleReport; usage: Usage }> {
    return {
      value: {
        facts: ['Deterministic offline role double'],
        hypotheses: [],
        unknowns: [],
        reads: { paths: [] },
        suggestedTests: ['Check boundary cases from acceptance'],
        approved: true,
      },
      usage: fakeUsage,
    };
  }
  async improve(_input: unknown, _signal: AbortSignal) {
    return {
      prompt:
        'Read acceptance examples before editing. Check boundary cases before returning a candidate.',
      hypothesis: 'Reading boundary examples may reduce repair attempts',
    };
  }
}
export class FakeRunner implements RunnerPort {
  constructor(
    private edits: FakeEdit[],
    private omitFirst = false,
  ) {}
  async stop(_id: string) {
    return true;
  }
  async isStopped(_id: string) {
    return true;
  }
  async run(
    attempt: Attempt,
    tree: Tree,
    _prompt: string,
    recipe: RoleRecipe,
    _binding: ModelBinding,
    signal: AbortSignal,
  ): Promise<{ fact: RunnerFact; tree: Tree }> {
    ensure(!signal.aborted, 'cancelled', 'Attempt cancelled');
    const candidate = structuredClone(tree);
    if (
      !this.omitFirst ||
      attempt.epoch > 1 ||
      recipe.prompt.includes('Read acceptance examples')
    ) {
      for (const edit of this.edits) {
        if (
          !recipe.scope.some(
            (p) => edit.path === p || edit.path.startsWith(p + '/'),
          )
        )
          continue;
        const old = candidate[edit.path];
        ensure(old, 'fake', 'Fixture path missing');
        const text = Buffer.from(old.content, 'base64').toString('utf8');
        candidate[edit.path] = {
          ...old,
          content: Buffer.from(
            text.replaceAll(edit.before, edit.after),
          ).toString('base64'),
        };
      }
    }
    validateCandidate(tree, candidate, recipe.scope);
    return {
      tree: candidate,
      fact: {
        attemptId: attempt.id,
        outcome: 'completed',
        stopped: true,
        usage: fakeUsage,
        detail: 'Deterministic fake runner; no GPT performance claim',
        handoff: {
          attemptId: attempt.id,
          epoch: attempt.epoch,
          baseDigest: attempt.baseDigest,
          candidateDigest: treeDigest(candidate),
          claim: {
            summary: 'Candidate prepared',
            acceptanceClaims: [],
            concerns: [],
          },
        },
      },
    };
  }
}
