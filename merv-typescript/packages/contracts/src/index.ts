export {
  patchSchema as paperPatchSchema,
  changesSchema as paperChangesSchema,
} from './paper-edit.js';
export { mapAsync, filterAsync, someAsync, everyAsync } from './async.js';
import type { ToolPolicy } from './tool-policy.js';
export type {
  ToolPolicy,
  ToolGrant,
  SessionToolPolicy,
  SessionToolInvocation,
  ConversationToolPolicy,
} from './tool-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import 'cordis';

export type { Json, Data } from './data.js';
export { clip, visible } from './text.js';
export { mainAgentGuide } from './agent-guide.js';
export { folded, idPattern, idSchema, sha256Hex } from './schemas.js';
export { ordered } from './order.js';
export { reviewHistory, REVIEW_HISTORY_LIMITS } from './review-history.js';
export type { ReviewHistory, ReviewRound } from './review-history.js';
export {
  sessionWorkspaceSchema,
  codePendingMergeSchema,
  type CodePendingMerge,
} from './workspace.js';
export { sessionUsageReportSchema } from './usage-report.js';
export { codePublicationIdSchema, codePublicationMergeSchema } from './code-publications.js';
export type {
  CodePublication,
  CodePublicationMerge,
  CodePublicationApi,
} from './code-publications.js';
export { codeTransportInputSchema, codeTransportGrantSchema } from './code-transport.js';
export type { CodeTransportInput, CodeTransportGrant } from './code-transport.js';
export {
  CODE_BUNDLE_MAX_BYTES,
  CODE_PART_MAX_BYTES,
  CODE_CHECK_SOURCE_MAX_BYTES,
  CODE_CHECK_SLACK_SECONDS,
  codeFindingSchema,
  codeCheckSpecSchema,
  codeStoreLimitsSchema,
  codeRepositoryConfigureInputSchema,
  codeRepositoryImportInputSchema,
  codeRepositoryRebindInputSchema,
  codeWorkspaceManifestInputSchema,
  codeWorkspaceManifestSchema,
  codeUploadBeginSchema,
  codeUploadFinalizeSchema,
  codeDownloadBeginSchema,
  codeDownloadReadSchema,
  codeUnitFenceInputSchema,
  codeMirrorRetryInputSchema,
  codeDeferralCauseSchema,
} from './code-store.js';
export type {
  CodeFinding,
  CodeCheckSpec,
  CodeStoreLimits,
  CodeRepositoryConfigureInput,
  CodeRepositoryImportInput,
  CodeRepositoryPrepareInput,
  CodeRepositoryPreparation,
  CodeRepositoryRebindInput,
  CodeStoreOperation,
  CodeStoreStatus,
  CodeStoreWarning,
  CodeBackupStatus,
  CodeMirrorStatus,
  CodeWorkspaceManifestInput,
  CodeWorkspaceManifest,
  CodeUploadBegin,
  CodeUploadFinalize,
  CodeDownloadBegin,
  CodeDownloadRead,
  CodeUnitFenceInput,
  CodeMirrorRetryInput,
  CodeDeferralCause,
} from './code-store.js';
export type {
  UiManifest,
  UiManifestRow,
  UiManifestGroup,
  UiCollectionSpec,
  UiColumn,
  UiPhrasePart,
  UiLivenessSpec,
  UiRecordSpec,
  UiAction,
  UiSection,
  UiDetail,
} from './ui-manifest.js';
export { uiManifestSchema } from './ui-manifest.js';
export type * from './sessions-models.js';
export type * from './running.js';
export {
  runningKeyPattern,
  runningKey,
  keyKind,
  keyId,
  workRoute,
  dependencyRows,
} from './running.js';
export type { CodeBlocker, PersonMove, NameLookup } from './code-blockers.js';
export { personMove, publicationBlocker, firstPersonMove } from './code-blockers.js';
export { codexHandoffGraceMs, RUNNER_HARNESSES, sessionSecretPattern } from './session-inputs.js';
export { WorkspaceDeferred } from './workspace-driver.js';
export type {
  WorkspaceDriver,
  WorkspaceDriverFactory,
  WorkspaceDriverHost,
  WorkspaceHandle,
  WorkspaceLaunch,
  WorkspaceSession,
  WorkspaceTransport,
} from './workspace-driver.js';
export {
  codeCommitInputSchema,
  codeMergeInputSchema,
  codeCommandControlSchema,
  codeCommitCommandSchema,
  codeCommitReceiptSchema,
  codeCommandCompletionSchema,
  codeCommandRecordSchema,
  codeLocalBindInputSchema,
} from './code.js';
import type { CodeUnit } from './code-units.js';
export type {
  CodeAcceptedSince,
  CodeUnitAcceptInput,
  CodeUnitAcceptance,
  CodeUnitPublication,
  CodeBasePin,
  CodeBaseRecord,
  CodeBaseCheck,
  CodeBaseCheckState,
  CodeBaseControlInput,
  CodeBaseState,
  CodeBaseStatus,
  CodeUnit,
  CodeWriterState,
  CodeWriterStatus,
} from './code-units.js';
export type {
  CodeLocalBindInput,
  CodeProjectBinding,
  CodeProjectStatus,
  CodeCommitInput,
  CodeMergeInput,
  CodeCommitCommand,
  CodeCommitReceipt,
  CodeCommandRecord,
  CodeCommandControl,
  CodeCommandCompletion,
} from './code.js';
import type { Data, Json } from './data.js';
import type { Artifact } from './artifact-models.js';
export type { Artifact } from './artifact-models.js';
import { visible } from './text.js';
import type {
  Role,
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
  WorkflowWorkspacePolicy,
} from './workflow-models.js';
export type {
  Role,
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
  WorkflowWorkspaceBase,
  WorkflowWorkspacePolicy,
} from './workflow-models.js';
export type {
  WorkflowReference,
  WorkflowBlocker,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowProviderDependency,
  WorkflowProviderRelations,
  WorkflowActionStatus,
  WorkflowDecision,
  WorkflowLimitStatus,
  WorkflowOverview,
  WorkflowDependency,
  WorkflowWorkStart,
  ProcessTraversal,
  ProcessNode,
  ProcessEdge,
  ProcessDependencyEdge,
  ProcessGraph,
} from './workflow-guidance.js';
import type {
  WorkflowReference,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowProviderRelations,
  WorkflowDecision,
  WorkflowLimitStatus,
  WorkflowOverview,
  WorkflowDependency,
  WorkflowWorkStart,
  ProcessGraph,
} from './workflow-guidance.js';
export class MervError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    /** Structured detail a transport returns with the refusal, such as per-field issues. */
    public details?: unknown,
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
/** The name of an environment variable that holds a secret or setting a plugin config refers to. */
export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
/** The nonblank value of environment variable `name`; the refusal names the variable, never its value. */
export function requiredEnv(
  name: string,
  code: string,
  message = `Required environment variable ${name} is missing`,
): string {
  const value = process.env[name];
  check(value !== undefined && value.trim(), code, message);
  return value;
}
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export type Limits = {
  depth?: number;
  nodes?: number;
  bytes?: number;
  keys?: 'json' | 'any';
  strings?: 'unicode' | 'json';
  undefined?: 'omit' | 'reject' | 'omit-root';
  nullPrototype?: boolean;
};
/**
 * A detached plain-JSON copy of an input, made without calling accessors: no proxies, foreign
 * prototypes, cycles, sparse arrays, symbol keys, non-finite numbers, NUL or lone surrogates;
 * bounded in depth, nodes and UTF-8 bytes; undefined fields omitted as JSON omits them. Names
 * that steer prototypes are refused unless `keys` is 'any'. `strings: 'json'` permits
 * escaped NUL/surrogates; `undefined: 'reject'` refuses undefined instead of omitting it.
 * `undefined: 'omit-root'` omits undefined root fields but rejects them in nested data.
 * Set `nullPrototype: false` when only ordinary Object-prototype records are accepted.
 */
export function plain<T = Json>(value: unknown, code = 'invalid_input', limits: Limits = {}): T {
  const { depth: maxDepth = 64, nodes: maxNodes = Infinity, bytes: maxBytes = Infinity } = limits;
  let nodes = 0,
    bytes = 0;
  const active = new Set<object>();
  const refuse = (message: string): never => check(false, code, message) as never;
  const text = (item: string) => {
    if (limits.strings !== 'json') {
      check(!item.includes('\0'), code, 'Text cannot contain NUL');
      check(!/\p{Surrogate}/u.test(item), code, 'Text must be well-formed Unicode');
    }
    bytes += Buffer.byteLength(item, 'utf8');
    if (bytes > maxBytes) refuse('Input is too large');
    return item;
  };
  const copy = (item: unknown, depth: number): Json => {
    if (++nodes > maxNodes || depth > maxDepth) refuse('Input is too large or nests too deeply');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return text(item);
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || types.isProxy(item) || active.has(item))
      return refuse('Input must be finite, acyclic plain JSON');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && (prototype !== null || limits.nullPrototype === false)
    )
      refuse('Input must contain plain objects and arrays');
    const keys = Reflect.ownKeys(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (
      keys.some((key) => typeof key !== 'string') ||
      Object.entries(descriptors).some(
        ([key, field]) =>
          !Object.hasOwn(field, 'value') || !(field.enumerable || (array && key === 'length')),
      )
    )
      refuse('Input fields must be ordinary data');
    active.add(item);
    let result: Json;
    if (array) {
      const length = descriptors.length.value as number;
      if (
        length > maxNodes - nodes ||
        keys.length !== length + 1 ||
        !Array.from({ length }, (_, index) => String(index)).every((key) =>
          Object.hasOwn(descriptors, key),
        )
      )
        refuse('Arrays must be dense without extra fields');
      result = Array.from({ length }, (_, index) =>
        copy(descriptors[String(index)].value, depth + 1),
      );
    } else {
      const record: Data = {};
      for (const [key, field] of Object.entries(descriptors)) {
        if (limits.keys !== 'any' && ['__proto__', 'prototype', 'constructor'].includes(key))
          refuse('Input contains a reserved field name');
        text(key);
        if (
          field.value !== undefined ||
          limits.undefined === 'reject' ||
          (limits.undefined === 'omit-root' && depth > 0)
        )
          Object.defineProperty(record, key, {
            value: copy(field.value, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      result = record;
    }
    active.delete(item);
    return result;
  };
  return (value === undefined && limits.undefined !== 'reject' ? undefined : copy(value, 0)) as T;
}
/** Parse a detached copy of `value`; refusals carry `code` and name the failing fields. */
export function parsed<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  code: string,
  limits?: Limits,
): T {
  const result = schema.safeParse(plain(value, code, limits));
  check(
    result.success,
    code,
    result.success
      ? ''
      : result.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; '),
  );
  return result.data;
}
/** Where a domain keeps its receipts and how it compares and replays them; see receipted(). */
export interface Receipt<T> {
  table: string;
  /** Column names; the defaults are actor_id, input_hash and result. */
  actor?: string;
  hash?: string;
  result?: string;
  /** Set when the table stores the operation beside a hash of the input alone. */
  operation?: string;
  /** An older hash recipe whose receipts still replay. */
  legacyHash?: string;
  conflict?: string;
  /** Runs between the work and its record, for a domain that rechecks authority after yielding. */
  after?: () => Promise<unknown>;
  /** Runs on a replayed answer: a recheck, or defaults for fields older answers lack. */
  replay?: (result: T) => T | Promise<T>;
}
/**
 * One durable answer per (project, actor, requestId): a retry with the same hash replays it, a
 * different one conflicts. The caller validates the requestId and computes the hash, so each
 * table keeps the recipe its stored receipts were written with.
 *
 * Receipts deliberately kept elsewhere: wf_requests has no actor (workflow requests are shared
 * by a project) and wf_system_requests belongs to a provider; a Sessions grant is its own
 * receipt, so the secret digest commits with it; createProject keys on the user, since no actor
 * exists yet; ContextBuilder replays before it rebuilds live inputs. Derived requests that one
 * command makes of another name themselves with childRequest().
 */
export async function receipted<T>(
  tx: Transaction,
  caller: Caller,
  requestId: string,
  hash: string,
  execute: () => T | Promise<T>,
  receipt: Receipt<T>,
): Promise<T> {
  const { table, actor = 'actor_id', operation } = receipt;
  const hashColumn = receipt.hash ?? 'input_hash';
  const resultColumn = receipt.result ?? 'result';
  const previous = await tx.get<{ hash: string; result: string; operation?: string }>(
    `SELECT ${hashColumn} AS hash,${resultColumn} AS result${operation === undefined ? '' : ',operation'} FROM ${table} WHERE project_id=? AND ${actor}=? AND request_id=?`,
    caller.projectId,
    caller.actorId,
    requestId,
  );
  if (previous) {
    check(
      (operation === undefined || previous.operation === operation) &&
        (previous.hash === hash ||
          (receipt.legacyHash !== undefined && previous.hash === receipt.legacyHash)),
      'request_conflict',
      receipt.conflict ?? 'requestId was already used with different input',
      409,
    );
    const result = JSON.parse(previous.result) as T;
    return receipt.replay ? await receipt.replay(result) : result;
  }
  const result = await execute();
  await receipt.after?.();
  const columns = [actor, 'request_id', ...(operation === undefined ? [] : ['operation'])];
  await tx.run(
    `INSERT INTO ${table}(project_id,${[...columns, hashColumn, resultColumn].join(',')}) VALUES(?,?,?,?,?${operation === undefined ? '' : ',?'})`,
    caller.projectId,
    caller.actorId,
    requestId,
    ...(operation === undefined ? [] : [operation]),
    hash,
    JSON.stringify(result),
  );
  return result;
}
/**
 * receipted() for a requestId of 1–200 visible characters, hashing the operation with the
 * input. `options` names the table's hash and result columns and an `after` recheck.
 */
export async function replayed<T>(
  tx: Transaction,
  table: string,
  caller: Caller,
  operation: string,
  input: { requestId: string },
  execute: () => T | Promise<T>,
  options: { hash?: string; result?: string; after?: () => Promise<unknown> } = {},
): Promise<T> {
  check(
    typeof input.requestId === 'string' &&
      visible(input.requestId) &&
      input.requestId.length <= 200,
    'invalid_request_id',
    'A stable requestId of 1–200 characters with visible text is required',
  );
  return await receipted(tx, caller, input.requestId, digest({ operation, input }), execute, {
    table,
    ...options,
  });
}
/**
 * The requestId one command gives the request it makes of another service: fixed in length
 * whatever the caller's requestId, distinct per actor and step, and the same on every retry.
 */
export const childRequest = (caller: Caller, scope: string, step: string, requestId: string) =>
  `${scope}:${step}:${digest({ actorId: caller.actorId, requestId })}`;
/** Markdown with comments and fenced blocks blanked: nothing inside them is a heading or a figure. */
export function visibleMarkdown(text: string): string {
  let fence: { character: string; count: number } | undefined;
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split(/\r?\n/)
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (
          match &&
          match[1][0] === fence.character &&
          match[1].length >= fence.count &&
          line.slice(match[0].length).trim() === ''
        )
          fence = undefined;
        return '';
      }
      if (match) fence = { character: match[1][0], count: match[1].length };
      return match ? '' : line;
    })
    .join('\n');
}
const normalizeHeading = (text: string) =>
  text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/**
 * The first nonblank body under a heading that starts with `title` (case, punctuation and
 * closing hashes aside), up to the next heading of the same or a higher level; null when none.
 */
export function markdownSection(text: string, title: string): string | null {
  const wanted = normalizeHeading(title);
  let level = 0;
  let content: string[] = [];
  for (const line of visibleMarkdown(text).split('\n')) {
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (level && heading && heading[1].length <= level) {
      if (content.join('\n').trim()) break;
      level = 0;
    }
    if (level) content.push(line);
    else if (heading && normalizeHeading(heading[2]).startsWith(wanted)) {
      level = heading[1].length;
      content = [];
    }
  }
  const body = content.join('\n').trim();
  return level && visible(body) ? body : null;
}
/** Keys sorted by UTF-16 code unit, independent of the process locale. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export type SqlValue = string | number | bigint | null | Uint8Array;
/** Await initialization before publishing a storage-backed service. */
export async function createService<T extends { initialize(): Promise<void> }>(
  service: T,
): Promise<T> {
  await service.initialize();
  return service;
}
export interface Sql {
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export interface Transaction extends Sql {
  readonly transactionId: symbol;
}
export interface Migration {
  version: number;
  /** PostgreSQL text; its digest() is pinned in component_migrations.hash. */
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
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  read<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T>;
  /** A read-only snapshot scope: nested component transactions never take the writer lock. */
  snapshot<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Whether the current async context is inside such a snapshot, where nothing may write. */
  readonly readScope: boolean;
  /**
   * Inside a snapshot, runs `fn` behind a savepoint of its own: a statement that fails there
   * costs only this call, and the snapshot reads on. Calls on one snapshot run one at a time.
   */
  isolated<T>(fn: () => T | Promise<T>): Promise<T>;
  assertTransaction(tx: Transaction): void;
  migrate(component: string, migrations: Migration[]): Promise<void>;
  appendEvent(tx: Transaction, event: Omit<StoredEvent, 'id' | 'createdAt'>): Promise<StoredEvent>;
  events(projectId: string, after?: number): Promise<StoredEvent[]>;
  latestEvents(projectId: string, before?: number): Promise<StoredEvent[]>;
  eventBatch(after: number, limit: number, tx?: Transaction): Promise<StoredEvent[]>;
  eventHead(tx?: Transaction): Promise<number>;
  onEventsCommitted(listener: () => void): () => void;
}
export interface EventConsumer {
  id: string;
  types: string[];
  from: 'beginning' | 'now';
  handle(event: StoredEvent, tx: Transaction): void | Promise<void>;
}
export interface ConsumerStatus {
  id: string;
  cursor: number;
  active: boolean;
  attempts: number;
  error: string | null;
  retryAt: number;
}
export interface DomainEvents {
  subscribe(consumer: EventConsumer): Promise<() => void | Promise<void>>;
  drain(): Promise<void>;
  status(): Promise<ConsumerStatus[]>;
}
export async function inTransaction<T>(
  state: State,
  tx: Transaction | undefined,
  fn: (tx: Transaction) => T | Promise<T>,
): Promise<T> {
  if (tx) {
    state.assertTransaction(tx);
    return await fn(tx);
  }
  return await state.transaction(fn);
}
export interface Blobs {
  put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }>;
  get(namespace: string, hash: string): Promise<Buffer>;
  /** Optional direct transfer capability; never expands the inline content limit. */
  download?(
    namespace: string,
    hash: string,
    expectedSize: number,
  ): Promise<{ url: string; expiresAt: string }>;
}
export type Permission = 'read' | 'write' | 'review' | 'admin';
export interface Caller {
  actorId: string;
  projectId: string;
  /** Transport-authenticated credential identity; never accepted from tool arguments. */
  credentialId?: string;
  /** Verified human authority attached by the transport, never by tool arguments. */
  human?: {
    issuer: string;
    subject: string;
    expiresAt: string;
    membershipId: string;
  };
  /** User-owned machine authority, distinct from human login and actor credentials. */
  key?: { id: string; membershipId: string };
  /** Server-authenticated leased worker. Invocation ids are minted by Sessions, never tools. */
  session?: { id: string; agentSessionId?: string; invocationId?: string };
  conversation?: { id: string; epoch: number; commandId: string; runtimeId: string };
  /** Server-authenticated supervisor; the binding is rechecked on every control. */
  managed?: {
    allocationId: string;
    epoch: number;
    credentialHash: string;
    boundSessionId?: string;
  };
  /** A project's credential-free service acting for a person, never set by a transport. */
  service?: { vouchedBy: DelegationSource };
}
/** Immutable source of a lease; a shared login's short JWT lifetime is not the user lifetime. */
export type DelegationSource = { actorId: string; projectId: string } & (
  | { kind: 'actor'; credentialId: string; expiresAt: string | null }
  | { kind: 'human'; issuer: string; subject: string; membershipId: string }
  | { kind: 'key'; keyId: string; membershipId: string; expiresAt: string | null }
  /** Valid only while the person who vouched for it may still write in its project. */
  | { kind: 'service'; vouchedBy: DelegationSource }
);
/** One installed session manager owns the authority of credentialless worker actors. */
export interface SessionAuthority {
  require(caller: Caller, tx: Transaction): Promise<DelegationSource>;
}
export interface ConversationAuthority {
  require(caller: Caller, tx: Transaction): Promise<DelegationSource>;
}
/** Optional Sessions authority for allocation-bound supervisors, separate from assignment tools. */
export interface ManagedRunnerAuthority {
  require(caller: Caller, tx: Transaction): Promise<DelegationSource>;
}
/** A domain's event as every domain records it: who, what, on which record, from where. */
/** A review's producer and its excluded contributors cannot be its reviewer. */
export const excludedFromReview = (
  review: Pick<ReviewRequest, 'producerId' | 'excludedActorIds' | 'provenance'>,
  actorId: string,
) =>
  review.producerId === actorId ||
  (review.excludedActorIds ?? []).includes(actorId) ||
  (review.provenance?.excludedActorIds ?? []).includes(actorId);
/**
 * Whether a worker this authority directs may review. The producer never directs its own
 * reviewer, with or without provenance; owner-certified contributors direct none either. Two
 * workers one authority directs are different actors, so either may review the other's work.
 */
export const directsIndependently = (
  review: Pick<ReviewRequest, 'producerId' | 'excludedActorIds' | 'provenance'>,
  authorityId: string,
) =>
  review.provenance ? !excludedFromReview(review, authorityId) : review.producerId !== authorityId;
/** The lease source a review worker would speak for, refused where it may not direct one. */
export const requireDirecting = (
  review: Pick<ReviewRequest, 'producerId' | 'excludedActorIds' | 'provenance'>,
  authorityId: string,
) =>
  check(
    directsIndependently(review, authorityId),
    'review_independence',
    'A producer or contributor cannot direct the reviewer of its own work',
    403,
  );
export const recorded = async (
  state: Pick<State, 'appendEvent'>,
  tx: Transaction,
  caller: Caller,
  type: string,
  subjectId: string,
  data: Data,
) =>
  await state.appendEvent(tx, {
    projectId: caller.projectId,
    actorId: caller.actorId,
    type,
    subjectId,
    data: { ...data, ...eventSource(caller) },
  });
/** Audit provenance only. Authority is still rechecked by Scope inside the operation. */
/**
 * Release a domain's lease row by its exact ownership receipt: the worker's review claim goes
 * back with it, and a row already released is left alone. `where` adds the domain's columns.
 */
/** A lease's stored ownership receipt must be exactly the one presented, or the lease is stale. */
export function checkReceipt<T extends { receipt: string }>(
  lease: T | undefined,
  receipt: unknown,
  message: string,
): asserts lease is T {
  check(
    !!lease && digest(JSON.parse(lease.receipt)) === digest(receipt),
    'stale_lease',
    message,
    409,
  );
}
export async function releasedLease(
  tx: Transaction,
  reviews: Pick<Reviews, 'releaseClaim'>,
  table: string,
  lease: WorkflowLease,
  reason: string,
  where: Record<string, SqlValue> = {},
): Promise<void> {
  const match = {
    id: lease.leaseId,
    project_id: lease.projectId,
    revision: lease.expectedRevision,
    actor_id: lease.actorId,
    ...where,
  };
  const row = await tx.get<{
    id: string;
    project_id: string;
    actor_id: string;
    receipt: string;
    released_at: string | null;
    review_id: string | null;
    claim_id: string | null;
  }>(
    `SELECT * FROM ${table} WHERE ${Object.keys(match)
      .map((column) => `${column}=?`)
      .join(' AND ')}`,
    ...Object.values(match),
  );
  checkReceipt(row, lease.receipt, 'Release must name the exact ownership receipt');
  if (row.released_at) return;
  if (row.review_id && row.claim_id)
    await reviews.releaseClaim(
      {
        projectId: row.project_id,
        reviewId: row.review_id,
        claimId: row.claim_id,
        actorId: row.actor_id,
        reason,
      },
      tx,
    );
  await tx.run(
    `UPDATE ${table} SET released_at=? WHERE id=? AND released_at IS NULL`,
    now(),
    row.id,
  );
}
/** A plugin entry's lifecycle state as the composition root reports it. */
export type PluginRunState =
  'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'disabled';
export interface PluginStatus {
  id: string;
  name: string;
  state: PluginRunState;
  required: boolean;
  missingDependencies: string[];
}
/** The composition root's plugin lifecycle report; every reader of plugin state shares it. */
export interface Composition {
  status(): PluginStatus[];
}
export function eventSource(caller: Caller): Data {
  return caller.session
    ? { source: { kind: 'session', sessionId: caller.session.id } }
    : caller.key
      ? {
          source: { kind: 'user-key', keyId: caller.key.id, membershipId: caller.key.membershipId },
        }
      : caller.conversation
        ? {
            source: {
              kind: 'conversation',
              conversationId: caller.conversation.id,
              commandId: caller.conversation.commandId,
            },
          }
        : {};
}
export interface Actor {
  /** Credentialless service owning this actor, when present. */
  serviceOwner?: string;
  id: string;
  projectId: string;
  name: string;
  role: Role;
  active: boolean;
  /** Present only for the persistent actor representing a project member. */
  user?: { issuer: string; subject: string };
  /** Credentialless actor owned by an agent session (or a historical assignment). */
  agentId?: string;
  sessionId?: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  /** Current Scope reads always include these; optional for legacy frozen snapshots. */
  summary?: string;
  contextRevision?: number;
}
export interface ProjectContextUpdate {
  summary: string;
  /** Exact previously observed Introduction; whitespace is significant. */
  expectedSummary: string;
  requestId: string;
}
/** Project-bound actor credentials are distinct from human login and future worker leases. */
export interface ActorCredential {
  id: string;
  actorId: string;
  projectId: string;
  kind: 'actor';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface AuthenticatedActor extends Actor {
  credential: ActorCredential;
}
export interface IssuedActorCredential {
  actor: Actor;
  credential: ActorCredential;
  /** Returned once; only its digest is stored. */
  token: string;
}
export interface Credentials extends IssuedActorCredential {
  project: Project;
}
/** Verified by an identity provider outside any State transaction. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  expiresAt: string;
}
export interface SharedUser {
  issuer: string;
  subject: string;
  createdAt: string;
}
export interface HumanPrincipal {
  kind: 'user';
  user: SharedUser;
  expiresAt: string;
}
/** A machine bearer owned by a verified user; projectId is its immutable issuance project. */
export interface UserKey {
  id: string;
  owner: { issuer: string; subject: string };
  projectId: string;
  grantScope: 'project' | 'account';
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface IssuedUserKey {
  key: UserKey;
  /** Returned once; only its digest is stored. */
  token: string;
}
export type Principal =
  HumanPrincipal | { kind: 'actor'; actor: AuthenticatedActor } | { kind: 'key'; key: UserKey };
export interface ProjectMembership {
  id: string;
  projectId: string;
  issuer: string;
  subject: string;
  actorId: string;
  role: Role;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}
export interface Scope {
  /** Each project's longest-standing signed-in operator, as a person: who directs its automatic
   * work until an admin chooses. A project with none is left out. */
  projectOwners(tx?: Transaction): Promise<{ projectId: string; source: DelegationSource }[]>;
  /** A credential-free producer owned by a server provider, scoped to one project; only
   * Fleet's review director, 'fleet-review', is a reviewer instead. */
  serviceActor(
    provider: string,
    projectId: string,
    tx?: Transaction,
    role?: 'producer' | 'reviewer',
  ): Promise<Caller>;
  readonly toolPolicy: ToolPolicy;
  delegationSource(caller: Caller, tx?: Transaction): Promise<DelegationSource>;
  requireDelegation(
    source: DelegationSource,
    permission: Permission,
    tx?: Transaction,
  ): Promise<Actor>;
  registerSessionAuthority(authority: SessionAuthority): () => void;
  registerConversationAuthority(authority: ConversationAuthority): () => void;
  registerManagedRunnerAuthority(authority: ManagedRunnerAuthority): () => void;
  createSessionActor(
    source: DelegationSource,
    input: { sessionId: string; agentId?: string; role: Exclude<Role, 'operator'>; name: string },
    tx: Transaction,
  ): Promise<Actor>;
  setAgentRole(
    source: DelegationSource,
    actorId: string,
    role: Exclude<Role, 'operator'>,
    tx: Transaction,
  ): Promise<void>;
  retireSessionActor(actorId: string, reason: string, tx: Transaction): Promise<void>;
  /** Verified delegation owner for scoped remote grants; does not change request attribution. */
  authorityActor(caller: Caller, tx?: Transaction): Promise<Actor>;
  bootstrap(input: { projectName: string; actorName: string }): Promise<Credentials>;
  authenticate(token: string): Promise<AuthenticatedActor>;
  authenticateKey(token: string): Promise<UserKey>;
  /** Recognize any issued local digest, including revoked/expired credentials. */
  recognizesCredential(token: string): Promise<boolean>;
  /** Verified owners can inspect/revoke their own keys even after losing project membership. */
  keys(principal: Principal, projectId?: string): Promise<UserKey[]>;
  createKey(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<IssuedUserKey>;
  /** Rotation preserves owner/grant/project; it requires a current membership within that grant. */
  rotateKey(
    principal: Principal,
    input: { keyId: string; expiresAt?: string | null },
  ): Promise<IssuedUserKey>;
  /** Revoke the selected key and all of its rotation descendants atomically. */
  revokeKey(principal: Principal, keyId: string): Promise<void>;
  /** Trusted provider output only; accepting an invitation does not verify an identity. */
  acceptVerifiedIdentity(identity: VerifiedIdentity): Promise<HumanPrincipal>;
  caller(principal: Principal, projectId?: string): Promise<Caller>;
  projects(principal: Principal): Promise<Project[]>;
  createProject(principal: Principal, input: { name: string; requestId: string }): Promise<Project>;
  memberships(principal: Principal, projectId: string): Promise<ProjectMembership[]>;
  addMember(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  removeMember(principal: Principal, projectId: string, subject: string): Promise<void>;
  /** Local administrator migration only. This is deliberately absent from HTTP/MCP. */
  adoptProject(
    principal: HumanPrincipal,
    projectId: string,
    options?: { repairReason: string },
  ): Promise<ProjectMembership>;
  require(caller: Caller, permission: Permission, tx?: Transaction): Promise<Actor>;
  eligible(
    projectId: string,
    actorId: string,
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean>;
  project(caller: Caller, tx?: Transaction): Promise<Project>;
  updateProjectContext(
    caller: Caller,
    input: ProjectContextUpdate,
    tx?: Transaction,
  ): Promise<Project>;
  issueActor(
    caller: Caller,
    input: { name: string; role: Role; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  actorCredentials(caller: Caller, actorId?: string): Promise<ActorCredential[]>;
  issueActorCredential(
    caller: Caller,
    input: { actorId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  rotateCredential(
    caller: Caller,
    input: { credentialId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  revokeCredential(caller: Caller, credentialId: string): Promise<void>;
  actors(caller: Caller): Promise<Actor[]>;
  revokeActor(caller: Caller, actorId: string): Promise<void>;
}
export interface ArtifactInput {
  title: string;
  content: string;
  mediaType?: string;
  encoding?: 'utf8' | 'base64';
}
export interface ArtifactUploadInput {
  title: string;
  size: number;
  sha256: string;
  mediaType: string;
  requestId?: string;
}
export interface ArtifactUploadStatus {
  uploadId: string;
  partSize: number;
  partCount: number;
  parts: { partNumber: number; url: string; size: number; headers: Record<string, string> }[];
  completedParts: number[];
  nextPart: number | null;
}
export interface LargeArtifactStorage {
  begin(
    projectId: string,
    uploadId: string,
    input: ArtifactUploadInput,
  ): Promise<{ objectId: string; status: ArtifactUploadStatus }>;
  resume(projectId: string, objectId: string, startPart: number): Promise<ArtifactUploadStatus>;
  complete(
    projectId: string,
    objectId: string,
  ): Promise<{ objectId: string; size: number; sha256: string; state: string }>;
  download(projectId: string, objectId: string): Promise<{ url: string; expiresAt: string }>;
}
export interface Artifacts {
  readonly downloadSupported: boolean;
  canDownload(artifact: Artifact): boolean;
  readonly largeUploadAvailable: boolean;
  bindLarge(storage: LargeArtifactStorage): () => void;
  uploadBegin(caller: Caller, input: ArtifactUploadInput): Promise<ArtifactUploadStatus>;
  uploadResume(caller: Caller, uploadId: string, startPart?: number): Promise<ArtifactUploadStatus>;
  uploadComplete(caller: Caller, uploadId: string): Promise<Artifact>;
  download(
    caller: Caller,
    artifactId: string,
  ): Promise<{
    artifact: Artifact;
    download: { url: string; expiresAt: string };
  }>;
  /** Metadata-only output receipts for the authenticated session worker. */
  authored(caller: Caller, tx?: Transaction): Promise<Artifact[]>;
  create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact>;
  get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact>;
  /** With offset or length, `content` is that part of the content, in characters, and `offset`
   * and `total` say where it starts and how long the whole is. */
  read(
    caller: Caller,
    artifactId: string,
    range?: { offset?: number; length?: number },
  ): Promise<{
    artifact: Artifact;
    content: string;
    encoding: 'utf8' | 'base64';
    offset?: number;
    total?: number;
  }>;
  list(caller: Caller): Promise<Artifact[]>;
}
export interface WorkflowDefinition {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  edges: { from: string; action: string; to: string }[];
  managed?: boolean;
  /** While an instance is nonterminal, pause creation of these workflow types in its project. */
  blocksStarts?: string[];
}
export interface WorkflowStart {
  workflow: string;
  version?: number;
  requestId: string;
  data?: Data;
  dependsOn?: string[] | string | null;
}
export interface WorkflowAddDependencies {
  instanceId: string;
  dependsOn: string[] | string | null;
  /** Edges to remove in the same change: an owner reselecting the work it depends on. */
  drop?: string[] | string | null;
  expectedRevision: number;
  requestId: string;
}
export interface WorkflowTransition {
  instanceId: string;
  expectedRevision: number;
  action: string;
  requestId: string;
  data?: Data;
  /** Proposed command arguments for registered checks; not merged into workflow state. */
  input?: Data;
}
export interface WorkflowCheckContext {
  caller: Caller;
  snapshot: WorkflowSnapshot;
  tx: Transaction;
  input?: Data;
  transition?: string;
  dependencies?: WorkflowDependency[];
}
/** Read-only domain rules; awaited inside the graph owner's transaction. */
export interface WorkflowActionRule {
  name: string;
  states: string[];
  tool: string;
  instruction: string;
  transitions?: string[];
  requiredInput?: string[] | ((context: WorkflowCheckContext) => string[] | Promise<string[]>);
  suggested?: boolean;
  requiresDependencies?: boolean;
  check(context: WorkflowCheckContext): void | Promise<void>;
  arguments?(context: WorkflowCheckContext): Data | Promise<Data>;
}
/**
 * A cap on how often one instance may take a returning edge. `max` is the sum of recorded
 * traversals allowed across `actions`, every one of which leaves `from` for another state.
 */
export interface WorkflowLoopLimit {
  name: string;
  from: string;
  actions: string[];
  max: number;
}
/** An admin's append-only allowance; an owner's resume hook may also advance suspended work. */
export interface WorkflowExtendLimit {
  instanceId: string;
  limit: string;
  additional: number;
  reason: string;
  requestId: string;
}
export interface WorkflowPolicy {
  actions: WorkflowActionRule[];
  assignments?: WorkflowAssignmentRule[];
  /**
   * Not fingerprinted with the graph: a cap is deployed policy, a number operators tune, and
   * it governs every live instance of the version at once, counted from its whole history.
   */
  limits?: WorkflowLoopLimit[];
  /** The owner may resume suspended work in the same transaction as a human's allowance. */
  limitExtended?(context: WorkflowCheckContext, status: WorkflowLimitStatus): Promise<void>;
  /** Immutable per version; only these terminal states satisfy downstream work. */
  successStates?: string[];
  /** Optional explicit recovery action suggested when a required prerequisite fails. */
  dependencyFailureAction?: string;
  /**
   * Instances this one fans work out to without a dependency edge, such as a reflection's
   * lenses. A usage rollup over a dependency closure unions them in, so the sessions they
   * cost are not lost from the figure of the cycle that caused them. It only reads.
   */
  children?(context: {
    caller: Caller;
    instanceId: string;
    tx: Transaction;
  }): string[] | Promise<string[]>;
  describe?(context: WorkflowCheckContext):
    | {
        label: string;
        references: WorkflowReference[];
        gate?: string;
        waiting?: string;
      }
    | Promise<{
        label: string;
        references: WorkflowReference[];
        gate?: string;
        waiting?: string;
      }>;
}
export interface WorkflowAssignmentRule {
  state: string;
  requiresDependencies?: boolean;
  /** Admission to do node work, independent of exit-action readiness. */
  check(context: WorkflowCheckContext): void | Promise<void>;
  build(
    context: WorkflowCheckContext,
  ): WorkflowAssignmentContent | Promise<WorkflowAssignmentContent>;
  /** Fixed declared grants. Absence explicitly means no workflow dispatch authority. */
  execution?: WorkflowExecutionPolicy;
  /** Awaited metadata only; never render context or read artifact bytes here. */
  references?(
    context: WorkflowCheckContext,
  ): WorkflowExecutionReferences | Promise<WorkflowExecutionReferences>;
  /** Program-owned resource reservation for one credentialless session worker. */
  lease?: {
    /** Optional metadata-only queue label; never render assignment context here. */
    label?(context: WorkflowCheckContext): string | Promise<string>;
    role(context: WorkflowCheckContext): Role | Promise<Role>;
    /** Whether this worker actor would be refused the assignment, so it is never offered it. */
    excludes?(context: WorkflowCheckContext, actorId: string): boolean | Promise<boolean>;
    acquire(
      context: WorkflowCheckContext & { source: Caller; leaseId: string },
    ): Data | Promise<Data>;
    check(context: WorkflowCheckContext, receipt: Data): void | Promise<void>;
    /** Program-owned worker outputs may extend declared resource arrays for this lease. */
    outputs?(
      context: WorkflowCheckContext,
      receipt: Data,
    ): Record<string, string[]> | Promise<Record<string, string[]>>;
    release(context: {
      lease: WorkflowLease;
      reason: string;
      tx: Transaction;
    }): void | Promise<void>;
  };
}
export type WorkflowExecutionBinding =
  | { kind: 'literal'; value: Json }
  | { kind: 'target'; field: 'instanceId' | 'revision' | 'projectId' }
  | { kind: 'reference'; name: string }
  | { kind: 'oneOf'; name: string }
  | { kind: 'subset'; name: string };
export type WorkflowExecutionReferences = Record<string, string | string[]>;
/** The argument bindings an execution policy grants a tool with. */
export const target = (field: 'instanceId' | 'revision'): WorkflowExecutionBinding => ({
  kind: 'target',
  field,
});
export const reference = (name: string): WorkflowExecutionBinding => ({ kind: 'reference', name });
export const literal = (value: string): WorkflowExecutionBinding => ({ kind: 'literal', value });
export const grant = (
  name: string,
  ...alternatives: Record<string, WorkflowExecutionBinding>[]
) => ({
  name,
  alternatives,
});
/** JSON declarations, separate from guidance and deployed callback implementations. */
export interface WorkflowExecutionPolicy {
  /** Describes the work environment; explicit protocol/checkpoint writes remain permitted. */
  readOnly: boolean;
  /** Omission preserves old manifest hashes and means scratch space with no repository. */
  workspace?: WorkflowWorkspacePolicy;
  tools: {
    name: string;
    /** A tool is admitted when one complete argument-binding alternative matches. */
    alternatives: Record<string, WorkflowExecutionBinding>[];
  }[];
}
/** Do not materialize this compatibility default into a persisted execution manifest. */
export function effectiveWorkspace(policy: WorkflowExecutionPolicy): WorkflowWorkspacePolicy {
  return structuredClone(policy.workspace ?? { mode: 'none' });
}
export interface WorkflowLease extends WorkflowExecutionTarget {
  leaseId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  policyHash: string;
  registrationId: string;
  receipt: Data;
}
export interface WorkflowLeaseOffer {
  lease: WorkflowLease;
  assignment: WorkflowAssignment;
  execution: WorkflowExecution;
}
export interface WorkflowExecution {
  instanceId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  /** Pins declared grants, not the implementation of trusted metadata callbacks. */
  policyHash: string;
  /** Opaque registration-generation fence. This is not a bearer credential. */
  registrationId: string;
  policy: WorkflowExecutionPolicy;
  references: WorkflowExecutionReferences;
}
export interface WorkflowExecutionDispatch extends WorkflowExecutionTarget {
  policyHash: string;
  registrationId: string;
  tool: string;
  input: Data;
  /** The tool only reads, so the project is its bound rather than the policy. */
  read?: boolean;
}
export interface WorkflowDispatchAdmission {
  tool: string;
  input: Data;
}
export interface WorkflowAssignmentContent {
  role: string;
  label: string;
  brief: string;
  references: WorkflowReference[];
  handoff: { instruction: string; tools: string[] };
  /** Assignment instructions; these do not mint a per-session capability. */
  execution: {
    readOnly: boolean;
    tools: { name: string; arguments: Data }[];
    policy?: WorkflowExecutionPolicy;
    policyHash?: string;
    registrationId?: string;
  };
  context: ContextPreview | null;
}
export interface WorkflowAssignment extends WorkflowAssignmentContent {
  instanceId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  workStart: WorkflowWorkStart | null;
}
export interface WorkflowBegin {
  instanceId: string;
  expectedRevision: number;
}
export interface WorkflowEvaluationInput {
  /** Optional preflight of one action against proposed command arguments. */
  action?: string;
  input?: Data;
}
export interface Workflows {
  /** Metadata-only, project-scoped readiness. Does not reserve work or render assignment bytes. */
  /** Candidates a source may dispatch; with `worker`, only those that worker may take. */
  dispatchCandidates(
    source: Caller,
    tx?: Transaction,
    worker?: string,
  ): Promise<WorkflowDispatchCandidate[]>;
  leaseRole(source: Caller, target: WorkflowExecutionTarget, tx?: Transaction): Promise<Role>;
  offerLease(
    source: Caller,
    worker: Caller,
    target: WorkflowExecutionTarget & { leaseId: string },
    tx?: Transaction,
  ): Promise<WorkflowLeaseOffer>;
  checkLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowExecution>;
  authorizeLeaseDispatch(
    worker: Caller,
    lease: WorkflowLease,
    frozen: WorkflowExecution,
    input: { tool: string; input: Data; read?: boolean },
    tx?: Transaction,
  ): Promise<WorkflowDispatchAdmission>;
  activateLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowWorkStart>;
  /** Trusted exact resource cleanup; deliberately independent of caller's expired authority. */
  releaseLease(lease: WorkflowLease, input: { reason: string }, tx?: Transaction): Promise<void>;
  execution(
    caller: Caller,
    target: WorkflowExecutionTarget,
    tx?: Transaction,
  ): Promise<WorkflowExecution>;
  /** Internal dispatch admission; ordinary caller credentials remain unchanged. */
  authorizeDispatch(
    caller: Caller,
    dispatch: WorkflowExecutionDispatch,
    tx?: Transaction,
  ): Promise<WorkflowDispatchAdmission>;
  assignment(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowAssignment>;
  begin(caller: Caller, input: WorkflowBegin, tx?: Transaction): Promise<WorkflowAssignment>;
  workStarts(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowWorkStart[]>;
  register(
    definition: WorkflowDefinition,
    policy?: WorkflowPolicy,
  ): Promise<{
    dispose(): void;
    start(caller: Caller, input: WorkflowStart, tx?: Transaction): Promise<WorkflowSnapshot>;
    transition(
      caller: Caller,
      input: WorkflowTransition,
      tx?: Transaction,
    ): Promise<WorkflowSnapshot>;
    /** Program-owned additive DAG composition; not an agent-facing mutation. */
    addDependencies(
      caller: Caller,
      input: WorkflowAddDependencies,
      tx?: Transaction,
    ): Promise<WorkflowSnapshot>;
  }>;
  start(caller: Caller, input: WorkflowStart, tx?: Transaction): Promise<WorkflowSnapshot>;
  transition(
    caller: Caller,
    input: WorkflowTransition,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot>;
  get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot>;
  list(caller: Caller, tx?: Transaction): Promise<WorkflowSnapshot[]>;
  history(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowHistoryEntry[]>;
  catalog(): WorkflowDefinition[];
  /**
   * Derived on read from the definition and the record; never pinned, never authored. With
   * `checks: false` no program callback runs, so no edge carries a status: for a view that
   * draws only where the work stands.
   */
  process(
    caller: Caller,
    instanceId: string,
    options?: { checks?: boolean },
  ): Promise<ProcessGraph>;
  evaluate(
    caller: Caller,
    instanceId: string,
    input?: WorkflowEvaluationInput,
    tx?: Transaction,
  ): Promise<WorkflowDecision>;
  overview(caller: Caller): Promise<WorkflowOverview>;
  /** Only a project admin who is not a leased worker may allow a capped loop more rounds. */
  extendLimit(
    caller: Caller,
    input: WorkflowExtendLimit,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus>;
  limitStatus(
    caller: Caller,
    instanceId: string,
    name: string,
    tx: Transaction,
  ): Promise<WorkflowLimitStatus>;
  dependencies(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<{
    dependencies: WorkflowDependency[];
    dependents: WorkflowDependency[];
  }>;
  /**
   * What each of several instances depends on, for a view of many that draws prerequisites
   * only: each one's `dependencies` as dependencies() reads it, without what depends on it,
   * in a fixed number of reads. An id the project does not hold depends on nothing.
   */
  prerequisites(
    caller: Caller,
    instanceIds: readonly string[],
    tx: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>>;
  /**
   * limitStatus of one limit for each of several instances, in a fixed number of reads per
   * definition. An instance whose definition has no such limit is left out, not refused.
   */
  limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    tx: Transaction,
  ): Promise<Map<string, WorkflowLimitStatus>>;
  checkDependencies(caller: Caller, instanceId: string, tx?: Transaction): Promise<void>;
  /**
   * The instance, everything it transitively depends on, and the children their policies
   * declare: the grouping a research cycle's usage and budget are read over.
   */
  dependencyClosure(caller: Caller, instanceId: string, tx?: Transaction): Promise<string[]>;
  /** Roots whose current dependency or child closure contains this work, frozen by its provider. */
  sponsoringRoots(projectId: string, instanceIds: string[], tx: Transaction): Promise<string[]>;
  /**
   * A provider's whole current opinion of one instance: the keys given are written, its other
   * keys for that instance are removed. Transaction-only, like releaseLease, so no tool route
   * reaches it; an ended instance keeps none.
   */
  replaceBlockers(
    input: {
      projectId: string;
      instanceId: string;
      provider: string;
      blockers: WorkflowProvidedBlockerInput[];
    },
    tx: Transaction,
  ): Promise<void>;
  /** Published blockers of one instance, or of the whole project when it is left out. */
  blockers(
    caller: Caller,
    instanceId?: string,
    tx?: Transaction,
  ): Promise<WorkflowProvidedBlocker[]>;
  /** Internal provider capability; never exposed through a tool or a lease. */
  systemPrerequisites(provider: string): {
    replace(
      input: { projectId: string; instanceId: string; requestId: string; dependencies: string[] },
      tx: Transaction,
    ): Promise<void>;
  };
  /**
   * The dependency edges a provider derives from, read inside its caller's transaction and
   * under that caller's already-checked authority. Null when the project holds no such instance.
   */
  dependencyRelations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowProviderRelations | null>;
}
import type { Verdict } from './types.js';
export type { Verdict } from './types.js';
export type ReviewFinding = {
  criterionNumber: number;
  status: 'met' | 'not_met' | 'not_verified' | 'waived';
  evidenceIds: string[];
  notes: string;
};
/** Owner-derived identities and a digest of the retained records that justify them. */
export interface ReviewProvenance {
  /** Recompute this certificate inside claim and verdict transactions; absence keeps legacy review rules. */
  revalidate?: true;
  formatVersion: 1;
  provider: string;
  reference: string;
  sourceHash: string;
  excludedActorIds: string[];
  hash: string;
}
export type ReviewProvenanceResolver = (
  projectId: string,
  subjectId: string,
  tx: Transaction,
) => Promise<ReviewProvenance>;
export interface ReviewRequest {
  provenance?: ReviewProvenance;
  /** Why no independent reviewer can currently take this request. */
  waiting?: string;
  id: string;
  projectId: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  pinnedInputIds?: string[];
  /** Immutable contributor exclusions in addition to the primary producer. Omitted for legacy reviews. */
  excludedActorIds?: string[];
  /** Immutable numbers of the criteria a pass can never waive. Omitted for reviews requested without any. */
  requiredCriteria?: number[];
  /** Whether the reader of this answer may claim it now. Present on reads, not on writes. */
  claimable?: boolean;
  /** Claimed by the project's owner as owner, past the independence rule; its reviewer is that person. */
  override?: true;
  /** On reads: the reader is the signed-in owner, or their agent, and may decide it as owner. */
  overridable?: true;
  criteria: string[];
  formatVersion: 2;
  snapshotHash: string;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  claimId: string | null;
  claimGeneration: number;
  recovery: {
    eventId: number;
    previousActorId: string;
    previousClaimId: string | null;
    reason: string;
  } | null;
  verdict: Verdict | null;
  /** Explicit return route chosen and validated by the owning domain, when applicable. */
  returnTo?: string;
  notes: string | null;
  synopsis: string | null;
  findings: ReviewFinding[];
  evidence: Data;
  createdAt: string;
}
export interface ReviewInput {
  /** Trusted owner capability; callers never provide a certificate or its identities. */
  provenanceOwner?: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  /** Explicit input provenance; all remaining evidence must be authored by producerId. */
  pinnedInputIds?: string[];
  /** Authors of pinned manifest evidence who must not claim or judge this review. */
  excludedActorIds?: string[];
  criteria: string[];
  /**
   * Numbers of the criteria a pass can never waive: each must be met with retained evidence.
   * The requesting domain sets it, so a reviewer cannot wave through the check the domain
   * depends on.
   */
  requiredCriteria?: number[];
  /** The only verdict format: a synopsis and one finding per criterion. */
  formatVersion?: 2;
  requestId: string;
}
export interface ReviewSubmit {
  reviewId: string;
  claimId: string;
  verdict: Verdict;
  /** Optional bounded identifier; the owning domain decides valid/required return routes. */
  returnTo?: string;
  notes: string;
  synopsis?: string;
  findings?: ReviewFinding[];
  /** Structured observations/metrics; evidence.outcome may name the resulting outcome. */
  evidence?: Data;
  requestId: string;
}
export interface ReviewApplication extends ReviewSubmit {
  /** Reviewer-authored Methods/Results edits, applied with an experiment or reflection verdict. */
  paperChanges?: import('./paper-models.js').PaperChanges;
  expectedRevision: number;
}
/** Trusted synchronous domain callbacks; ownership checks read metadata only. */
export interface ReviewSubmitOwner {
  id: string;
  owns(review: Readonly<ReviewRequest>, tx: Transaction): boolean | Promise<boolean>;
  submit(caller: Caller, input: ReviewApplication, tx: Transaction): Promise<unknown>;
  /** Refuses a claim of an owned review that the owner's rules could never let finish. */
  claim?(caller: Caller, review: Readonly<ReviewRequest>, tx: Transaction): Promise<void>;
  /**
   * The gate each owned review among these was read at ('Design', 'Results'), for a domain
   * whose records are reviewed at more than one. Read-only; ids it does not own are left out.
   */
  gates?(reviewIds: readonly string[], sql: Sql): Promise<Readonly<Record<string, string>>>;
}
export interface Reviews {
  provenance(provider: string): { register(resolve: ReviewProvenanceResolver): () => void };
  registerSubmitOwner(owner: ReviewSubmitOwner): () => void;
  /** Select one current domain owner and apply its verdict/transition in the same writer. */
  apply(caller: Caller, input: ReviewApplication, tx?: Transaction): Promise<unknown>;
  request(caller: Caller, input: ReviewInput, tx?: Transaction): Promise<ReviewRequest>;
  reissue(
    caller: Caller,
    input: { reviewId: string; subjectRevision: number; requestId: string },
    tx?: Transaction,
  ): Promise<ReviewRequest>;
  /** Trusted cleanup of exactly one worker claim, without reviving expired caller authority. */
  releaseClaim(
    input: {
      projectId: string;
      reviewId: string;
      claimId: string;
      actorId: string;
      reason: string;
    },
    tx: Transaction,
  ): Promise<void>;
  get(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  list(caller: Caller): Promise<ReviewRequest[]>;
  /** `override` claims it as the project's owner: only that person, signed in, may. */
  start(
    caller: Caller,
    reviewId: string,
    tx?: Transaction,
    override?: boolean,
  ): Promise<ReviewRequest>;
  checkStart(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  checkSubmit(
    caller: Caller,
    reviewId: string,
    input?: Omit<ReviewSubmit, 'requestId'>,
    tx?: Transaction,
  ): Promise<ReviewRequest>;
  submit(caller: Caller, input: ReviewSubmit, tx?: Transaction): Promise<ReviewRequest>;
  supersede(caller: Caller, reviewId: string, tx?: Transaction): Promise<void>;
  /**
   * The Running sidebar's Review sections for each subject that has a review: how the current
   * review stands, and its earlier rounds. Waiting stays operator-only, as get() keeps it.
   */
  running(
    caller: Caller,
    subjectIds: readonly string[],
    tx?: Transaction,
  ): Promise<import('./running.js').RunningSection[]>;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  checks: string[];
  evidenceVersion: 2;
  acceptanceChecks: { number: number; text: string }[];
  deliveryConfirmations: TaskConfirmation[];
  deliveryAssessmentId: string | null;
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  reviewId: string | null;
  workflow: WorkflowSnapshot;
  guidance: WorkflowDecision;
  failure: TaskFailure | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  workStarts: WorkflowWorkStart[];
  createdAt: string;
  type: string;
  typeVersion: number;
  contextInputs: Record<string, string[]>;
  /** Present only on a Git task, so every earlier record reads back unchanged. */
  workspace?: 'git';
  /** The accepted Git task whose delivered commit is the base of this task's checkout. */
  baseTaskId?: string;
  /** The commit the current delivery names; the review pins its rendered record. */
  deliveryCode?: TaskDeliveryCode;
  deliveryCodeArtifactId?: string;
}
/**
 * The commit a Git task delivered. The receipt stays resolvable through its ref, so the record
 * keeps only what a later check compares: who produced it, at which revision, and what it is.
 */
export interface TaskDeliveryCode {
  ref: { kind: 'code-commit'; commandId: string };
  sessionId: string;
  /** The task revision the commit was produced at; later revisions never move it. */
  revision: number;
  headOid: string;
  treeOid: string | null;
}
export interface TaskFailure {
  reason: string;
  actorId: string;
  createdAt: string;
  reviewId: string | null;
}
/** Domain metadata only; safe to compose without evaluating interactive guidance. */
export type TaskRecord = Omit<Task, 'guidance'>;
export interface ContextRecipe {
  instructions: string;
  sections: { key: string; title: string; required: boolean }[];
  outputInstructions: string;
  maxChars: number;
}
export interface TaskTypeDefinition {
  name: string;
  version: number;
  kind: 'work' | 'review';
  recipe: ContextRecipe;
}
export type ContextInput =
  | { text: string; omitted?: string[] }
  | {
      artifactIds: string[];
      /** Text is strict UTF-8; auto retains binary references; references never embeds bytes. */
      mode?: 'text' | 'auto' | 'references';
    };
export interface ContextBuild {
  subject: { id: string; revision: number; claimId?: string };
  inputs: Record<string, ContextInput>;
  requestId: string;
}
export interface ContextPackage {
  id: string;
  projectId: string;
  actorId: string;
  type: string;
  typeVersion: number;
  recipeHash: string;
  subject: ContextBuild['subject'];
  prompt: string;
  sources: Artifact[];
  omitted: string[];
  hash: string;
  createdAt: string;
}
export type ContextPreview = Omit<ContextPackage, 'id' | 'createdAt'>;
export interface ContextRegistration {
  preview(
    caller: Caller,
    input: Omit<ContextBuild, 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPreview>;
  build(caller: Caller, input: ContextBuild, tx?: Transaction): Promise<ContextPackage>;
  /** Replay an existing assignment request before rebuilding its live inputs. */
  replay(
    caller: Caller,
    input: Pick<ContextBuild, 'subject' | 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPackage | null>;
  dispose(): void;
}
export interface ContextBuilder {
  register(definition: TaskTypeDefinition): Promise<ContextRegistration>;
  /** Text documents are embedded while they leave the recipe `room` for the rest of the
   *  context; past that they are listed and the reader opens them itself. */
  mode(
    caller: Caller,
    ids: string[],
    room: number,
    tx: Transaction,
  ): Promise<'auto' | 'references'>;
}
export interface TaskContext {
  taskId: string;
  purpose: 'work' | 'review';
  expectedRevision: number;
  claimId?: string;
  requestId: string;
}
export interface TaskCheckpointInput extends TaskContext {
  notes: string;
  artifactIds?: string[];
}
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  actorId: string;
  purpose: 'work' | 'review';
  revision: number;
  reviewId: string | null;
  claimId: string | null;
  notes: string;
  artifactIds: string[];
  createdAt: string;
}
export interface TaskCreate {
  title: string;
  goal: string;
  checks: string[];
  briefId?: string;
  requestId: string;
  type?: string;
  typeVersion?: number;
  contextInputs?: Record<string, string[]>;
  dependsOn?: string[] | string | null;
  /** Omission preserves the original scratch task and its command hash. */
  workspace?: 'none' | 'git';
  /** A Git task only: an accepted Git task, also a prerequisite, whose delivered commit is the base. */
  baseTaskId?: string;
}
export interface TaskDelivery {
  taskId: string;
  /** May be empty for a Git task, which delivers its commit. */
  artifactIds: string[];
  /** A Git task only: this worker's own succeeded code.commit operation. */
  commandId?: string;
  /** Required: one per acceptance check. These are producer claims. */
  confirmations?: TaskConfirmation[];
  expectedRevision: number;
  requestId: string;
}
export type TaskConfirmation = {
  checkNumber: number;
  status: 'met' | 'not_met';
  evidenceIds: string[];
  notes: string;
};
export interface TaskReview extends ReviewApplication {}
export interface TaskReissue {
  taskId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
export interface TaskMarkFailed {
  taskId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
/** An owner capability passed between server plugins; no public task input selects it. */
export interface ServiceTaskCreator {
  create(
    input: {
      projectId: string;
      requestId: string;
      title: string;
      goal: string;
      checks: string[];
    } & (
      | { baseReference: string; dependsOn?: never }
      /** Prerequisites of the same project; Code derives the base from them as for a public task. */
      | { dependsOn: string[]; baseReference?: never }
    ),
    tx: Transaction,
  ): Promise<{ id: string }>;
}

import type { RunningNode, RunningPanelPart } from './running.js';
export interface Tasks {
  registerType(definition: TaskTypeDefinition): Promise<() => void>;
  context(caller: Caller, input: TaskContext): Promise<ContextPackage>;
  checkpoint(caller: Caller, input: TaskCheckpointInput): Promise<TaskCheckpoint>;
  create(caller: Caller, input: TaskCreate, transaction?: Transaction): Promise<Task>;
  get(caller: Caller, taskId: string): Promise<Task>;
  list(caller: Caller): Promise<TaskRecord[]>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, taskId: string): Promise<ProcessGraph>;
  /** What the optional Code plugin holds for a Git task; null without it. */
  codeUnit(caller: Caller, taskId: string): Promise<CodeUnit | null>;
  record(caller: Caller, taskId: string, tx?: Transaction): Promise<TaskRecord>;
  records(caller: Caller, tx?: Transaction): Promise<TaskRecord[]>;
  submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task>;
  submitReview(caller: Caller, input: TaskReview, tx?: Transaction): Promise<Task>;
  reissueReview(caller: Caller, input: TaskReissue): Promise<Task>;
  markFailed(caller: Caller, input: TaskMarkFailed, tx?: Transaction): Promise<Task>;
  /** The owner capability another plugin creates service tasks with, under its own provider name. */
  serviceTasks(provider: string): ServiceTaskCreator;
  /**
   * The Running page's work lane: a node for every task still in flight, and for each ended
   * one whose key another owner holds there (`include`, as Running keys). Reads only.
   */
  running(caller: Caller, include?: Iterable<string>): Promise<RunningNode[]>;
  /** A task's sidebar on the Running page; null when no task of this project has the id. Reads only. */
  runningPanel(caller: Caller, taskId: string): Promise<RunningPanelPart | null>;
}
declare module 'cordis' {
  interface Context {
    state: State;
    domainEvents: DomainEvents;
    contextBuilder: ContextBuilder;
    blobs: Blobs;
    scope: Scope;
    artifacts: Artifacts;
    workflows: Workflows;
    reviews: Reviews;
    tasks: Tasks;
    composition: Composition;
  }
}

export {
  githubRevisionSchema,
  githubRepositoryInputSchema,
  githubAutomationSchema,
  githubBranchSchema,
} from './code-github.js';
export type {
  CodeGitHub,
  GitHubRepository,
  GitHubRepositoryInput,
  GitHubStatus,
} from './code-github.js';
export type {
  GitHubBranch,
  GitHubCommit,
  GitHubPullRequest,
  GitHubChangedFile,
  GitHubCheck,
  GitHubReview,
  GitHubPullDetails,
  GitHubAutomationInput,
} from './github-models.js';

/** The caller a delegation source acts as, for work done later on its behalf. */
export function sourceCaller(source: DelegationSource): Caller {
  const base = { actorId: source.actorId, projectId: source.projectId };
  if (source.kind === 'actor') return { ...base, credentialId: source.credentialId };
  if (source.kind === 'key')
    return { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
  if (source.kind === 'service') return { ...base, service: { vouchedBy: source.vouchedBy } };
  // Delegation follows the captured membership epoch, not the original short-lived login JWT.
  return {
    ...base,
    human: {
      issuer: source.issuer,
      subject: source.subject,
      membershipId: source.membershipId,
      expiresAt: '9999-12-31T23:59:59.999Z',
    },
  };
}
/** When a delegation lapses by itself: a person's never, a service's with its voucher's. */
export const delegationEnd = (source: DelegationSource): number =>
  source.kind === 'service'
    ? delegationEnd(source.vouchedBy)
    : source.kind !== 'human' && source.expiresAt
      ? Date.parse(source.expiresAt)
      : Infinity;
