import type {
  MissionDraft,
  MissionRevision,
  PlanProposal,
  ProjectProfile,
  RoleReport,
  RoleRecipe,
  ModelBinding,
  RunnerFact,
  Attempt,
  Usage,
} from '../domain/contracts.js';
import type { Tree } from '../domain/tree.js';
export interface PlanningPort {
  draft(
    requirements: string,
    profile: ProjectProfile,
    signal: AbortSignal,
  ): Promise<{ value: MissionDraft; usage: Usage }>;
  plan(
    mission: MissionRevision,
    revision: number,
    facts: unknown,
    signal: AbortSignal,
  ): Promise<{ value: PlanProposal; usage: Usage }>;
  report(
    role: 'explorer' | 'test-designer' | 'reviewer' | 'failure-analyst',
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ value: RoleReport; usage: Usage }>;
  improve(
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ prompt: string; hypothesis: string }>;
}
export interface RunnerPort {
  run(
    attempt: Attempt,
    tree: Tree,
    prompt: string,
    recipe: RoleRecipe,
    binding: ModelBinding,
    signal: AbortSignal,
  ): Promise<{ fact: RunnerFact; tree: Tree }>;
  stop(operationId: string): Promise<boolean>;
  isStopped(operationId: string): Promise<boolean>;
}
export interface CheckPort {
  run(
    tree: Tree,
    profile: ProjectProfile,
    signal: AbortSignal,
  ): Promise<{ checkId: string; passed: boolean; detail: string }[]>;
}
