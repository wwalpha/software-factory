import type {
  MissionRevision,
  Attempt,
  RoleRecipe,
  RunnerFact,
  EvidenceReceipt,
  ResultBundle,
  FactoryRelease,
} from '../domain/contracts.js';
import type { Tree } from '../domain/tree.js';
export interface OperationRequest {
  id: string;
  grantId: string;
  mission: MissionRevision;
  type: 'snapshot' | 'build' | 'check' | 'seal';
  targetDigest: string;
  amount: number;
  payload: unknown;
}
export interface OperationRecord {
  request: OperationRequest;
  digest: string;
  state: 'pending' | 'completed' | 'uncertain' | 'failed';
  result: unknown;
  retryAllowed?: boolean;
}
export interface BuildPayload {
  attempt: Attempt;
  tree: Tree;
  prompt: string;
  recipe: RoleRecipe;
}
export interface GuardPort {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  operate<T = unknown>(request: OperationRequest): Promise<T>;
}
export interface BuildResult {
  fact: RunnerFact;
  tree: Tree;
}
export interface CheckResult {
  receipts: EvidenceReceipt[];
}
export interface SealResult {
  bundle: ResultBundle;
}
export interface ReleaseState {
  releases: FactoryRelease[];
  active: string;
  revoked: string[];
}
