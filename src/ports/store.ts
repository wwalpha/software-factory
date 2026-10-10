export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Stored<T = unknown> {
  id: string;
  kind: string;
  version: number;
  value: T;
}
export interface Event {
  id: string;
  topic: string;
  payload: unknown;
}
export interface Write {
  kind: string;
  id: string;
  expectedVersion: number;
  value: unknown;
}
export interface AttemptAdmission {
  attemptId: string;
  missionId: string;
}
export interface PersistencePort {
  get<T = unknown>(kind: string, id: string): Promise<Stored<T> | null>;
  list<T = unknown>(kind: string): Promise<Stored<T>[]>;
  commit(
    writes: Write[],
    event: Event,
    admission?: AttemptAdmission,
  ): Promise<{ duplicate: boolean }>;
  pending(): Promise<Event[]>;
  ack(id: string): Promise<void>;
  reserve(
    id: string,
    account: string,
    amount: number,
    limit: number,
  ): Promise<void>;
  settle(id: string, actual: number | null): Promise<void>;
  balance(
    account: string,
  ): Promise<{ reserved: number; spent: number; unknown: number }>;
  close(): Promise<void>;
}
