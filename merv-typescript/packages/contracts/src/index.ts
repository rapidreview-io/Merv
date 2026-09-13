import { createHash, randomUUID } from 'node:crypto';
import 'cordis';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = Record<string, Json>;
export class MervError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'MervError';
  }
}
export function check(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new MervError(code, message, status);
}
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface Sql {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
}
export interface Transaction extends Sql {
  readonly transactionId: symbol;
}
export interface Migration {
  version: number;
  sql: string;
}
export interface StoredEvent {
  id: number;
  projectId: string;
  actorId: string;
  type: string;
  subjectId: string;
  data: Data;
  createdAt: string;
}
export interface State {
  transaction<T>(fn: (tx: Transaction) => T): T;
  read<T>(fn: (sql: Sql) => T): T;
  assertTransaction(tx: Transaction): void;
  migrate(component: string, migrations: Migration[]): void;
  appendEvent(tx: Transaction, event: Omit<StoredEvent, 'id' | 'createdAt'>): StoredEvent;
  events(projectId: string, after?: number): StoredEvent[];
}
export function inTransaction<T>(
  state: State,
  tx: Transaction | undefined,
  fn: (tx: Transaction) => T,
): T {
  if (tx) {
    state.assertTransaction(tx);
    return fn(tx);
  }
  return state.transaction(fn);
}
export interface Blobs {
  put(namespace: string, bytes: Uint8Array): { hash: string; size: number };
  get(namespace: string, hash: string): Buffer;
}
export type Role = 'operator' | 'producer' | 'reviewer' | 'reader';
export type Permission = 'read' | 'write' | 'review' | 'admin';
export interface Caller {
  actorId: string;
  projectId: string;
}
export interface Actor {
  id: string;
  projectId: string;
  name: string;
  role: Role;
  active: boolean;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
}
export interface Credentials {
  project: Project;
  actor: Actor;
  token: string;
}
export interface Scope {
  bootstrap(input: { projectName: string; actorName: string }): Credentials;
  authenticate(token: string): Actor;
  require(caller: Caller, permission: Permission, tx?: Transaction): Actor;
  project(caller: Caller): Project;
  issueActor(caller: Caller, input: { name: string; role: Role }): { actor: Actor; token: string };
  actors(caller: Caller): Actor[];
  revokeActor(caller: Caller, actorId: string): void;
}
export interface Artifact {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
  createdAt: string;
}
export interface ArtifactInput {
  title: string;
  content: string;
  mediaType?: string;
  encoding?: 'utf8' | 'base64';
}
export interface Artifacts {
  create(caller: Caller, input: ArtifactInput, tx?: Transaction): Artifact;
  get(caller: Caller, artifactId: string, tx?: Transaction): Artifact;
  read(
    caller: Caller,
    artifactId: string,
  ): { artifact: Artifact; content: string; encoding: 'utf8' | 'base64' };
  list(caller: Caller): Artifact[];
}
export interface WorkflowDefinition {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  edges: { from: string; action: string; to: string }[];
  managed?: boolean;
}
export interface WorkflowSnapshot {
  id: string;
  projectId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  data: Data;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowStart {
  workflow: string;
  version?: number;
  requestId: string;
  data?: Data;
}
export interface WorkflowTransition {
  instanceId: string;
  expectedRevision: number;
  action: string;
  requestId: string;
  data?: Data;
}
export interface Workflows {
  register(definition: WorkflowDefinition): {
    dispose(): void;
    start(caller: Caller, input: WorkflowStart, tx?: Transaction): WorkflowSnapshot;
    transition(caller: Caller, input: WorkflowTransition, tx?: Transaction): WorkflowSnapshot;
  };
  start(caller: Caller, input: WorkflowStart, tx?: Transaction): WorkflowSnapshot;
  transition(caller: Caller, input: WorkflowTransition, tx?: Transaction): WorkflowSnapshot;
  get(caller: Caller, instanceId: string, tx?: Transaction): WorkflowSnapshot;
  list(caller: Caller): WorkflowSnapshot[];
  history(caller: Caller, instanceId: string): unknown[];
  catalog(): WorkflowDefinition[];
}
export type Verdict = 'pass' | 'needs_changes' | 'fail';
export interface ReviewRequest {
  id: string;
  projectId: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  artifactIds: string[];
  criteria: string[];
  snapshotHash: string;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  verdict: Verdict | null;
  notes: string | null;
  createdAt: string;
}
export interface ReviewInput {
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  artifactIds: string[];
  criteria: string[];
  requestId: string;
}
export interface ReviewSubmit {
  reviewId: string;
  verdict: Verdict;
  notes: string;
  requestId: string;
}
export interface Reviews {
  request(caller: Caller, input: ReviewInput, tx?: Transaction): ReviewRequest;
  get(caller: Caller, reviewId: string, tx?: Transaction): ReviewRequest;
  list(caller: Caller): ReviewRequest[];
  start(caller: Caller, reviewId: string, tx?: Transaction): ReviewRequest;
  submit(caller: Caller, input: ReviewSubmit, tx?: Transaction): ReviewRequest;
  supersede(caller: Caller, reviewId: string, tx?: Transaction): void;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  checks: string[];
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  reviewId: string | null;
  workflow: WorkflowSnapshot;
  createdAt: string;
}
export interface TaskCreate {
  title: string;
  goal: string;
  checks: string[];
  briefId: string;
  requestId: string;
}
export interface TaskDelivery {
  taskId: string;
  artifactIds: string[];
  expectedRevision: number;
  requestId: string;
}
export interface TaskReview extends ReviewSubmit {
  expectedRevision: number;
}
export interface TaskReissue {
  taskId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
export interface Tasks {
  create(caller: Caller, input: TaskCreate): Task;
  get(caller: Caller, taskId: string): Task;
  list(caller: Caller): Task[];
  submitDelivery(caller: Caller, input: TaskDelivery): Task;
  submitReview(caller: Caller, input: TaskReview): Task;
  reissueReview(caller: Caller, input: TaskReissue): Task;
}
declare module 'cordis' {
  interface Context {
    state: State;
    blobs: Blobs;
    scope: Scope;
    artifacts: Artifacts;
    workflows: Workflows;
    reviews: Reviews;
    tasks: Tasks;
  }
}
