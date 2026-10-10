import type {
  RoleReport,
  Usage,
  Waiting,
  WorkItem,
} from '../domain/contracts.js';

// Runtime-owned journal; agent output supplies only RoleReport and Usage.
export interface RoleExecution {
  id: string;
  missionId: string;
  missionRevision: number;
  planRevision: number;
  workItemId: string;
  role: WorkItem['role'];
  inputDigest: string;
  snapshotDigest: string;
  state: 'running' | 'waiting' | 'completed' | 'uncertain' | 'failed';
  failureCode: string | null;
  retryable: boolean;
  waiting: Waiting | null;
  calls: {
    id: string;
    inputDigest: string;
    snapshotDigest: string;
    state: 'running' | 'completed' | 'failed' | 'uncertain';
    usage: Usage;
    report: RoleReport | null;
    failureCode: string | null;
  }[];
  result: RoleReport | null;
}
