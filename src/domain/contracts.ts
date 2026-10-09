/* Generated from contracts/factory.schema.json. Do not edit. */

export type FactoryContract =
  | Budget
  | Acceptance
  | Delegation
  | MissionRevision
  | MissionDraft
  | WorkItem
  | PlanProposal
  | Waiting
  | Usage
  | Attempt
  | AgentClaim
  | Handoff
  | RunnerFact
  | EvidenceReceipt
  | AuthorityGrant
  | RoleRecipe
  | Experiment
  | FactoryRelease
  | Evaluation
  | ResultBundle
  | CheckSpec
  | ProjectProfile
  | ModelBinding
  | Models
  | ReadRequest
  | RoleReport
  | RecipeProposal;

export interface Budget {
  maxUsd: number;
  maxAttempts: number;
  maxMinutes: number;
}
export interface Acceptance {
  id: string;
  description: string;
  checkId: string;
}
export interface Delegation {
  /**
   * @maxItems 256
   */
  operations: ("snapshot" | "build" | "check" | "seal" | "evaluate" | "adopt")[];
  autoRecipe: boolean;
}
export interface MissionRevision {
  id: string;
  revision: number;
  parentRevision: number | null;
  objective: string;
  /**
   * @maxItems 256
   */
  nonGoals: string[];
  projectId: string;
  taskType: string;
  /**
   * @maxItems 256
   */
  scope: string[];
  /**
   * @maxItems 256
   */
  acceptance: Acceptance[];
  delegation: Delegation;
  budget: Budget;
  delivery: "sealed-tree";
  factoryRelease: string;
  createdAt: string;
}
export interface MissionDraft {
  objective: string;
  /**
   * @maxItems 256
   */
  nonGoals: string[];
  /**
   * @maxItems 256
   */
  ambiguities: string[];
}
export interface WorkItem {
  id: string;
  role:
    | "explorer"
    | "builder"
    | "test-designer"
    | "reviewer"
    | "failure-analyst"
    | "improver"
    | "capability-engineer"
    | "knowledge-curator";
  /**
   * @maxItems 256
   */
  dependsOn: string[];
  /**
   * @maxItems 256
   */
  scope: string[];
  /**
   * @maxItems 256
   */
  acceptanceIds: string[];
  instruction: string;
  budgetUsd: number;
}
export interface PlanProposal {
  missionId: string;
  revision: number;
  parentRevision: number;
  missionRevision: number;
  /**
   * @maxItems 256
   */
  items: WorkItem[];
  estimatedUsd: number;
  rationale: string;
}
export interface Waiting {
  reason: string;
  owner: "operator" | "runtime" | "provider";
  resumeCondition: string;
}
export interface Usage {
  certainty: "measured" | "estimated" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  usd: number | null;
}
export interface Attempt {
  id: string;
  missionId: string;
  workItemId: string;
  epoch: number;
  leaseUntil: string;
  baseDigest: string;
  operationId: string;
  state: "reserved" | "running" | "completed" | "failed" | "waiting" | "uncertain" | "cancelled";
  waiting: Waiting | null;
  usage: Usage;
  stopped: boolean;
}
export interface AgentClaim {
  summary: string;
  /**
   * @maxItems 256
   */
  acceptanceClaims: string[];
  /**
   * @maxItems 256
   */
  concerns: string[];
}
export interface Handoff {
  attemptId: string;
  epoch: number;
  baseDigest: string;
  candidateDigest: string;
  claim: AgentClaim;
}
export interface RunnerFact {
  attemptId: string;
  outcome:
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout"
    | "refused"
    | "invalid-output"
    | "unknown-event"
    | "auth-expired"
    | "rate-limited"
    | "uncertain";
  stopped: boolean;
  usage: Usage;
  handoff: Handoff | null;
  detail: string;
}
export interface EvidenceReceipt {
  id: string;
  missionId: string;
  targetDigest: string;
  inputDigest: string;
  checkId: string;
  checkVersion: string;
  environment: string;
  issuedAt: string;
  result: "pass" | "fail";
  issuer: string;
  signature: string;
}
export interface AuthorityGrant {
  id: string;
  caller: string;
  projectId: string;
  missionId: string;
  /**
   * @maxItems 256
   */
  operations: ("snapshot" | "build" | "check" | "seal" | "evaluate" | "adopt")[];
  /**
   * @maxItems 256
   */
  scope: string[];
  expiresAt: string;
  maxUsd: number;
  missionDigest: string;
  releaseId: string;
}
export interface RoleRecipe {
  id: string;
  role:
    | "coordinator"
    | "explorer"
    | "builder"
    | "test-designer"
    | "reviewer"
    | "failure-analyst"
    | "improver"
    | "capability-engineer"
    | "knowledge-curator";
  profile: "reasoner" | "engineer" | "scout";
  inputSchema: string;
  outputSchema: string;
  /**
   * @maxItems 256
   */
  capabilities: ("read" | "edit-candidate" | "propose")[];
  /**
   * @maxItems 256
   */
  scope: string[];
  budgetUsd: number;
  prompt: string;
  promptDigest: string;
  failureBehavior: "wait" | "replan" | "reject";
}
export interface Experiment {
  id: string;
  lineage: string;
  hypothesis: string;
  cause:
    "information" | "contract" | "tool" | "authority" | "reasoning" | "planning" | "implementation-bug" | "unknown";
  /**
   * @maxItems 256
   */
  evidence: string[];
  /**
   * @maxItems 256
   */
  projectIds: string[];
  /**
   * @maxItems 256
   */
  taskTypes: string[];
  baselineRelease: string;
  suiteId: string;
  suiteDigest: string;
  minQuality: number;
  maxRescue: number;
  maxUsd: number;
  maxDurationMs: number;
  maxTrials: number;
  rollbackQuality: number;
  rollbackRescue: number;
  status: "fixed" | "evaluating" | "adopted" | "rejected" | "held" | "rolled-back";
  createdAt: string;
  minRetryReduction: number;
}
export interface FactoryRelease {
  id: string;
  parent: string | null;
  kind: "recipe" | "core";
  recipe: RoleRecipe;
  /**
   * @maxItems 256
   */
  projectIds: string[];
  /**
   * @maxItems 256
   */
  taskTypes: string[];
  experimentId: string | null;
  stage: "candidate" | "canary" | "stable" | "revoked";
  createdAt: string;
}
export interface Evaluation {
  experimentId: string;
  releaseId: string;
  suiteDigest: string;
  quality: number;
  rescueCount: number;
  usd: number | null;
  durationMs: number;
  /**
   * @maxItems 256
   */
  cases: {
    id: string;
    partition: "development" | "separate";
    passed: boolean;
  }[];
  /**
   * @maxItems 256
   */
  evidenceIds: string[];
  retryCount: number;
}
export interface ResultBundle {
  missionId: string;
  missionRevision: number;
  status: "completed" | "failed" | "waiting" | "cancelled" | "running";
  /**
   * @maxItems 256
   */
  achieved: string[];
  artifact: {
    digest: string;
    reference: string;
  } | null;
  /**
   * @maxItems 256
   */
  checks: EvidenceReceipt[];
  /**
   * @maxItems 256
   */
  unmet: string[];
  /**
   * @maxItems 256
   */
  notRun: string[];
  /**
   * @maxItems 256
   */
  decisions: string[];
  usage: Usage;
  factoryRelease: string;
  completionSignature: string | null;
}
export interface CheckSpec {
  id: string;
  kind: "node-test" | "tsc";
  /**
   * @maxItems 256
   */
  files: string[];
  version: string;
}
export interface ProjectProfile {
  id: string;
  repository: string;
  taskType: string;
  /**
   * @maxItems 256
   */
  scope: string[];
  /**
   * @maxItems 256
   */
  acceptance: Acceptance[];
  delegation: Delegation;
  budget: Budget;
  /**
   * @maxItems 256
   */
  checks: CheckSpec[];
  checkRoot: string;
}
export interface ModelBinding {
  enabled: boolean;
  model: string;
  reasoning: "low" | "medium" | "high";
  verifiedAt: string | null;
  priceReference: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  maxOutputTokens: number;
}
export interface Models {
  reasoner: ModelBinding;
  engineer: ModelBinding;
  scout: ModelBinding;
}
export interface ReadRequest {
  /**
   * @maxItems 256
   */
  paths: string[];
}
export interface RoleReport {
  /**
   * @maxItems 256
   */
  facts: string[];
  /**
   * @maxItems 256
   */
  hypotheses: string[];
  /**
   * @maxItems 256
   */
  unknowns: string[];
  reads: ReadRequest;
  /**
   * @maxItems 256
   */
  suggestedTests: string[];
  approved: boolean;
}
export interface RecipeProposal {
  prompt: string;
  hypothesis: string;
}
