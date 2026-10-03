export { nativeMcpConnectionsSchema, type NativeMcpConnection } from './launch-connections.js';
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
} from './tool-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import 'cordis';

export type { Json, Data } from './data.js';
export { clip, itemTitle, visible } from './text.js';
export { mainAgentGuide } from './agent-guide.js';
export { folded, idPattern, idSchema, sha256Hex } from './schemas.js';
export { ordered } from './order.js';
export { reviewHistory, REVIEW_HISTORY_LIMITS } from './review-history.js';
export { boundedPaperContext } from './paper-context.js';
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
  CodeMirrorStatus,
  CodeWorkspaceManifestInput,
  CodeWorkspaceManifest,
  CodeUploadBegin,
  CodeUploadFinalize,
  CodeDownloadBegin,
  CodeDownloadRead,
  CodeUnitFenceInput,
  CodeMirrorRetryInput,
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
export {
  codexHandoffGraceMs,
  hostedCodexCapabilities,
  hostedCodexPlatform,
  MAX_TRANSCRIPT_BYTES,
  RUNNER_HARNESSES,
  sessionSecretPattern,
} from './session-inputs.js';
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
import type { Artifact, ArtifactFile } from './artifact-models.js';
export type { Artifact, ArtifactFile } from './artifact-models.js';
import { clip, visible } from './text.js';
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
  WorkflowRelations,
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
  WorkflowRelations,
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
/** One decoded URL path segment: 400 `invalid_input` when it is blank, malformed or holds a
 *  slash or NUL. */
export function pathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.trim() || decoded.includes('/') || decoded.includes('\0')) throw new Error();
    return decoded;
  } catch {
    throw new MervError('invalid_input', 'Malformed resource identifier');
  }
}
/**
 * Whether State raised this error about its own scope, transaction or store, rather than an
 * operation refusing its input: a write under a read, a nested or closed transaction, a
 * conflict, timeout or outage. A caller that turns refusals into answers must not turn these.
 */
export const stateFault = (error: unknown): error is MervError =>
  error instanceof MervError &&
  (error.code === 'read_only_scope' ||
    error.code === 'nested_transaction' ||
    /^(transaction|state)_/.test(error.code));
/** Every role a member, an actor or a lease may hold. */
export const ROLES = [
  'operator',
  'producer',
  'reviewer',
  'reader',
] as const satisfies readonly Role[];
// Fails the typecheck when Role gains a role that ROLES does not list.
true satisfies [Exclude<Role, (typeof ROLES)[number]>] extends [never] ? true : false;
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
 * by a project); a Sessions grant is its own receipt, so the secret digest commits with it;
 * createProject keys on the user, since no actor exists yet; ContextBuilder replays before it
 * rebuilds live inputs. Derived requests that one command makes of another name themselves
 * with childRequest().
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
  /** A positive integer that fits PostgreSQL INTEGER. */
  version: number;
  /**
   * PostgreSQL text; its digest() is pinned in component_migrations.hash. It runs inside the
   * migration's transaction and schema, so it never issues BEGIN, COMMIT, ROLLBACK or
   * SET search_path.
   */
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
  /**
   * Reads on the current scope, or on a connection of its own outside one. While a transaction
   * or snapshot the read started is open, it owns the connection, and a query on the read's own
   * `sql` from outside it is refused (`transaction_busy`). To join a caller's transaction without
   * holding a read, use `ambient`.
   */
  read<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T>;
  /**
   * A read-only snapshot scope: nested component transactions never take the writer lock.
   * Outside any scope it opens a snapshot of its own; inside a transaction or a snapshot it
   * runs `fn` there, which sees that transaction's uncommitted rows; inside a plain read it
   * opens the snapshot on that read's connection, as the one transaction the read may have open.
   */
  snapshot<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Whether the current async context is inside such a snapshot, where nothing may write. */
  readonly readScope: boolean;
  /**
   * The transaction this async context runs in (read-only inside a snapshot), if any: undefined
   * at top level, in a plain read and at a snapshot's root. Never opens a connection, so a
   * component can join the caller's transaction or open its own without holding a read.
   */
  readonly ambient: Transaction | undefined;
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
/**
 * Where one component read or command runs, chosen in one place.
 * - An explicit `tx` is used as it is, once asserted.
 * - Inside a transaction, a snapshot's open read transaction included, that one is reused.
 * - Without `place`, a plain read runs on `state.read`.
 * - With `place` the work needs a transaction. For 'read' it is a snapshot's read-only one, which
 *   takes no writer lock and refuses writes; for any other permission a write transaction. Inside
 *   a bare snapshot both are read-only transactions of that snapshot. Inside a plain read both run
 *   on the read's own connection, a 'read' one as a read-only snapshot of its own.
 */
export async function within<T>(
  state: State,
  tx: Transaction | undefined,
  fn: (sql: Sql) => Promise<T>,
  place?: Permission,
): Promise<T> {
  if (tx) {
    state.assertTransaction(tx);
    return await fn(tx);
  }
  const ambient = state.ambient;
  if (ambient) return await fn(ambient);
  if (!place) return await state.read(fn);
  return place === 'read'
    ? await state.snapshot(() => state.transaction(fn))
    : await state.transaction(fn);
}
/** A pure read that needs a transaction: it runs wherever a read decision would run. */
export async function forRead<T>(state: State, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  // With a place, `within` always hands over a transaction.
  return await within(state, undefined, (sql) => fn(sql as Transaction), 'read');
}
/** The most bytes Blobs moves by signed URL, and so the largest artifact. */
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
export interface Blobs {
  put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }>;
  get(namespace: string, hash: string): Promise<Buffer>;
  /**
   * Signed GET valid 60 s, served as identity-encoded application/octet-stream whatever the
   * uploader sent, saved as `filename` (default: the hash): `blob_not_found` when nothing is
   * stored, `blob_corrupt` when the stored size is not expectedSize. Never expands the inline
   * content limit.
   */
  download?(
    namespace: string,
    hash: string,
    expectedSize: number,
    filename?: string,
  ): Promise<{ url: string; expiresAt: string }>;
  /**
   * Signed PUT valid 1 h, sent with `headers`. The store accepts it only for exactly `size` bytes
   * whose SHA-256 is `hash`, and only while nothing is stored at the key. Local signing, no I/O.
   * A provider with `upload` also has `stored`.
   */
  upload?(
    namespace: string,
    hash: string,
    size: number,
  ): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  /** The stored object's size (HEAD), or null when none is stored. */
  stored?(namespace: string, hash: string): Promise<number | null>;
}
export type Permission = 'read' | 'write' | 'review' | 'admin';
/**
 * Who a call acts as. At most one authority field may be set. A bare `{ actorId, projectId }`
 * names an independent machine actor or a producing service actor directly: it is trusted
 * in-process authority, carries that actor's full role and checks no credential's liveness, so
 * transports never build one (they attach `credentialId`, `human`, `key`, `session`,
 * `conversation` or `managed`). A member actor still needs its person's `human` or `key`
 * authority, and a worker its session.
 */
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
  session?: {
    id: string;
    agentSessionId?: string;
    agentCredentialHash?: string;
    invocationId?: string;
  };
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
  require(caller: Caller, tx: Transaction, permission: Permission): Promise<DelegationSource>;
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
/**
 * Append a domain event stamped with the caller's source. That source is audit provenance only:
 * authority is still rechecked by Scope inside the operation.
 */
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
/** The columns every domain's lease table shares. */
export interface LeaseRow {
  id: string;
  project_id: string;
  actor_id: string;
  receipt: string;
  released_at: string | null;
  review_id: string | null;
  claim_id: string | null;
}
/**
 * Release a domain's lease row by its exact ownership receipt. `where` adds the domain's
 * columns. A missing row or another receipt is a stale lease.
 */
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
  const row = await tx.get<LeaseRow>(
    `SELECT * FROM ${table} WHERE ${Object.keys(match)
      .map((column) => `${column}=?`)
      .join(' AND ')}`,
    ...Object.values(match),
  );
  checkReceipt(row, lease.receipt, 'Release must name the exact ownership receipt');
  await releaseLeaseRow(tx, reviews, table, row, reason);
}
/**
 * Release a domain's lease row the caller already trusts: the worker's review claim goes back
 * with it, and a row already released is left alone. It checks no receipt, so it never fails
 * as stale.
 */
export async function releaseLeaseRow(
  tx: Transaction,
  reviews: Pick<Reviews, 'releaseClaim'>,
  table: string,
  row: LeaseRow,
  reason: string,
): Promise<void> {
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
/**
 * A lease owner's durable release: when a worker session closes, release the lease row it names.
 * A session's id is its lease's id, so the row is found without the workflow registration or a
 * receipt. A close logged while the owner was unloaded, or before this consumer existed, is
 * released when it next runs; a row already released, or gone with a retired instance, is left.
 */
export const leaseReleaseConsumer = (
  id: string,
  table: string,
  reviews: Pick<Reviews, 'releaseClaim'>,
): EventConsumer => ({
  id,
  types: ['session.closed'],
  from: 'beginning',
  handle: async (event, tx) => {
    const row = await tx.get<LeaseRow>(
      `SELECT * FROM ${table} WHERE id=? AND released_at IS NULL`,
      event.subjectId,
    );
    if (row)
      await releaseLeaseRow(
        tx,
        reviews,
        table,
        row,
        clip(String(event.data.reason ?? 'closed'), 500),
      );
  },
});
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
  /** Supply exactly one baseline from project.get. Whitespace is significant in text mode. */
  expectedSummary?: string;
  expectedContextRevision?: number;
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
  /** Each project's owner: its longest-standing signed-in operator, as a person, who directs
   * and pays for its work on Fleet's machines. A project with none is left out. */
  projectOwners(tx?: Transaction): Promise<{ projectId: string; source: DelegationSource }[]>;
  /** A credential-free producer owned by a server provider, scoped to one project; only
   * Fleet's review director, 'fleet-review', is a reviewer instead. `provider` is a lowercase
   * slug, and `role` defaults to the provider's own. */
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
  /** Changes an agent's role within what `source` may delegate. Scope does not know who owns an
   * agent: the caller must already have proven it controls this one (Sessions:
   * `AgentDirectory.controlled`). */
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
  /** Membership administration names subjects of the operator's own identity issuer only. */
  addMember(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  /** A role change ends the membership and starts a new one. Every delegation source and resolved
   * caller naming the old membership, a worker's lease source included, stops working with it. */
  changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  removeMember(principal: Principal, projectId: string, subject: string): Promise<void>;
  /** Host-authority break-glass for the local CLI only, deliberately absent from HTTP/MCP. It
   * makes a verified person the operator of a project with no membership history; with a
   * `repairReason` it restores their operator membership whatever the project's members say,
   * and records why. */
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
/** The most bytes an artifact holds inline: created whole, or read whole or in ranges. */
export const MAX_ARTIFACT_BYTES = 2_000_000;
/** The most ids one `Artifacts.getMany` call looks up; `getArtifacts` takes any number. */
export const MAX_ARTIFACT_IDS = 2000;
export interface ArtifactInput {
  title: string;
  content: string;
  mediaType?: string;
  encoding?: 'utf8' | 'base64';
}
export interface ArtifactCollectionInput {
  title: string;
  sourceKey: string;
  files: (ArtifactFile & { reference: string })[];
  metadata?: Record<string, unknown>;
}
export interface ArtifactFileProvider {
  download(projectId: string, reference: string): Promise<{ url: string; expiresAt: string }>;
}
/** Artifact bytes as tool text; `offset` and `total` are set for a range. */
export interface ArtifactContent {
  artifact: Artifact;
  content: string;
  encoding: 'utf8' | 'base64';
  offset?: number;
  total?: number;
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
  /** Set once the upload is complete; parts is then [] and nextPart null. */
  artifactId?: string;
}
/**
 * Immutable project files. A row implies its bytes: up to the inline limit they are in the row,
 * where a database CHECK verifies their size and SHA-256; every other row's bytes are in blobs at
 * (projectId, sha256). Rows never change. Bytes gone from behind a row are
 * `artifact_bytes_missing` (500), never a 404. `create` and reads do no network I/O. The one
 * write a read may cause: the first `download` of bytes kept in the row mirrors them into blobs
 * (content-addressed).
 *
 * Every call authorises once, at its start. A revocation that lands while a download link is
 * signed is enforced by the ToolRegistry, which reauthorises read tools after the handler; domain
 * callers act on bytes inside their own write transactions, which authorise again.
 */
export interface Artifacts {
  readonly downloadAvailable: boolean;
  readonly largeUploadAvailable: boolean;
  /** Backend-only provider registration; the disposer removes only this registration. */
  registerFileProvider(name: string, provider: ArtifactFileProvider): () => void;
  /** Database-only immutable manifest. The caller must verify and pin every referenced file first.
   * One row per project/sourceKey; a retry with different content is refused. */
  createCollection(
    caller: Caller,
    input: ArtifactCollectionInput,
    tx?: Transaction,
  ): Promise<Artifact>;
  /** Idempotent per actor and requestId. After completion, begin and resume return the
   * status with `artifactId` and call no storage. */
  uploadBegin(caller: Caller, input: ArtifactUploadInput): Promise<ArtifactUploadStatus>;
  uploadResume(caller: Caller, uploadId: string): Promise<ArtifactUploadStatus>;
  uploadComplete(caller: Caller, uploadId: string): Promise<Artifact>;
  download(
    caller: Caller,
    artifactId: string,
    fileName?: string,
  ): Promise<{
    artifact: Artifact;
    download: { url: string; expiresAt: string };
  }>;
  /** Database only: the bytes are stored in the row, in `tx`, else the ambient transaction, else
   * a transaction of its own. No network I/O. Not idempotent. */
  create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact>;
  get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact>;
  /** One authorisation and one query for up to MAX_ARTIFACT_IDS ids: the artifacts in input
   * order, duplicates kept; `not_found` for the first id that is not in this project. */
  getMany(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]>;
  /** Exactly `artifact.size` bytes whose SHA-256 is `artifact.hash`; `artifact_size` above the
   * inline limit. Bytes kept in the row are read locally; older rows fetch them from storage. */
  bytes(
    caller: Caller,
    artifactId: string,
    tx?: Transaction,
  ): Promise<{ artifact: Artifact; bytes: Buffer }>;
  /** The bytes as tool text: valid UTF-8 without NUL is utf8, anything else base64. A range is
   * in UTF-16 units (utf8) or base64 characters; each boundary moves forward to the next whole
   * code point or 4-character group, so pages at offset += length tile exactly, and so does
   * continuing from the returned offset + content.length. `offset` is the snapped start and
   * `total` the length of the whole. */
  read(
    caller: Caller,
    artifactId: string,
    range?: { offset?: number; length?: number },
    tx?: Transaction,
  ): Promise<ArtifactContent>;
  /** Newest first, at most `limit` (1-1000, default 1000). `before` is an artifact id of this
   * project (`not_found` if it is not) and the page starts after it; `session` keeps only the
   * artifacts created by that session. */
  list(
    caller: Caller,
    query?: { before?: string; limit?: number; session?: string },
    tx?: Transaction,
  ): Promise<Artifact[]>;
}
/**
 * `Artifacts.getMany` for any number of ids, MAX_ARTIFACT_IDS at a time: the artifacts in input
 * order, duplicates kept; `not_found` for the first id that is not in this project.
 */
export async function getArtifacts(
  artifacts: Pick<Artifacts, 'getMany'>,
  caller: Caller,
  ids: readonly string[],
  tx?: Transaction,
): Promise<Artifact[]> {
  const found: Artifact[] = [];
  for (let start = 0; start < ids.length; start += MAX_ARTIFACT_IDS)
    found.push(
      ...(await artifacts.getMany(caller, ids.slice(start, start + MAX_ARTIFACT_IDS), tx)),
    );
  return found;
}
/**
 * The outputs of the calling session worker's execution: the artifacts its session created as
 * this actor, oldest first, metadata only. Scope refuses a session caller whose actor is not
 * that session's worker; any other caller is refused here.
 */
export async function executionOutputs(
  artifacts: Pick<Artifacts, 'list'>,
  caller: Caller,
  tx?: Transaction,
): Promise<Artifact[]> {
  // The session and actor are read after awaits.
  caller = structuredClone(caller);
  check(
    caller.session,
    'forbidden',
    'Output receipts require an authenticated session worker',
    403,
  );
  const outputs: Artifact[] = [];
  const limit = 1000;
  let page: Artifact[] = [];
  do {
    const before = page.at(-1)?.id;
    page = await artifacts.list(caller, { session: caller.session.id, before, limit }, tx);
    outputs.push(...page.filter((artifact) => artifact.createdBy === caller.actorId));
  } while (page.length === limit);
  return outputs.reverse();
}
export interface WorkflowDefinition {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  edges: { from: string; action: string; to: string }[];
  /** Every graph is managed: only its program's handle changes an instance. */
  managed?: true;
  /** While an instance is nonterminal, pause creation of these workflow types in its project. */
  blocksStarts?: string[];
}
/** The immutable contract of one name@version, whether or not a program has it loaded. */
export interface WorkflowPinned {
  definition: WorkflowDefinition;
  /** Null pins their absence. */
  successStates: string[] | null;
  /**
   * Each nonterminal state's fixed execution manifest; null pins that it has none. Only a contract
   * that is not final can lack a state.
   */
  execution: Record<string, WorkflowExecutionPolicy | null>;
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
  /**
   * Immutable per version, their absence included: the first registration of a version pins
   * them, or pins that there are none. Only these terminal states satisfy downstream work, and
   * work of a version without them cannot be depended on.
   */
  successStates?: string[];
  /** Optional explicit recovery action suggested when a required prerequisite fails. */
  dependencyFailureAction?: string;
  /**
   * The instances each of `instanceIds` fans work out to without a dependency edge, such as a
   * reflection's lenses, by instance id; one left out has none. A usage rollup over a
   * dependency closure unions them in, so the sessions they cost are not lost from the figure
   * of the cycle that caused them. It is asked for up to 1,000 instances at once, never an
   * empty list, on behalf of no caller, and only reads.
   */
  children?(context: {
    projectId: string;
    instanceIds: readonly string[];
    tx: Transaction;
  }): Record<string, string[]> | Promise<Record<string, string[]>>;
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
export interface WorkflowDispatchAdmission {
  tool: string;
  input: Data;
}
/** The value a fixed binding gives its argument; a oneOf or subset choice gives none. */
export function executionArgument(
  binding: WorkflowExecutionBinding,
  execution: WorkflowExecution,
): unknown {
  if (binding.kind === 'literal') return binding.value;
  if (binding.kind === 'target') return execution[binding.field];
  if (binding.kind === 'reference') {
    const reference = Object.hasOwn(execution.references, binding.name)
      ? execution.references[binding.name]
      : undefined;
    check(
      typeof reference === 'string',
      'execution_reference_unavailable',
      `Execution reference ${binding.name} is unavailable`,
      409,
    );
    return reference;
  }
  return undefined;
}
/**
 * Admits one tool call under an execution: a declared tool, with arguments its bindings allow
 * and fill in. The input is a detached JSON object its caller has bounded; each alternative
 * binds its own copy.
 */
export function admitDispatch(
  execution: WorkflowExecution,
  tool: string,
  original: Data,
): WorkflowDispatchAdmission {
  const grant = execution.policy.tools.find((grant) => grant.name === tool);
  check(grant, 'execution_tool_forbidden', 'Tool is not declared for this workflow state', 403);
  const matches = new Map<string, Data>();
  const errors: MervError[] = [];
  for (const alternative of grant.alternatives) {
    try {
      const result = structuredClone(original);
      for (const [field, binding] of Object.entries(alternative)) {
        if (binding.kind === 'oneOf' || binding.kind === 'subset') {
          const values = Object.hasOwn(execution.references, binding.name)
            ? execution.references[binding.name]
            : undefined;
          check(
            Array.isArray(values),
            'execution_reference_unavailable',
            `Execution reference ${binding.name} is unavailable`,
            409,
          );
          // Omitting a subset means selecting no resources, never all available resources.
          if (binding.kind === 'subset' && !Object.hasOwn(result, field)) result[field] = [];
          // A choice among one reference is no choice: an omitted field takes it.
          if (binding.kind === 'oneOf' && !Object.hasOwn(result, field) && values.length === 1)
            result[field] = values[0]!;
          check(
            Object.hasOwn(result, field),
            'execution_arguments_forbidden',
            `Choose ${field} from the declared execution references`,
            403,
          );
          const actual = result[field];
          check(
            binding.kind === 'oneOf'
              ? typeof actual === 'string' && values.includes(actual)
              : Array.isArray(actual) &&
                  actual.every((value) => typeof value === 'string' && values.includes(value)),
            'execution_arguments_forbidden',
            `${field} is outside the declared execution references`,
            403,
          );
        } else {
          const expected = executionArgument(binding, execution);
          if (Object.hasOwn(result, field))
            check(
              canonical(result[field]) === canonical(expected),
              'execution_arguments_forbidden',
              `${field} conflicts with this workflow assignment`,
              403,
            );
          else result[field] = structuredClone(expected) as Data[string];
        }
      }
      matches.set(canonical(result), result);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
      errors.push(error);
    }
  }
  check(
    matches.size <= 1,
    'execution_arguments_ambiguous',
    'Supply the fixed fields needed to select one execution alternative',
  );
  if (!matches.size)
    throw errors.find((error) => error.code === 'execution_arguments_forbidden') ?? errors[0]!;
  return { tool, input: [...matches.values()][0]! };
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
  /**
   * The lease still holds, under the returned registration generation. With `frozen`, the
   * execution the lease was offered, it also returns the references that execution grants
   * now: the frozen ones, extended by the lease's own outputs.
   */
  checkLease(
    worker: Caller,
    lease: WorkflowLease,
    tx?: Transaction,
    frozen?: WorkflowExecution,
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }>;
  activateLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowWorkStart>;
  /** Trusted exact resource cleanup; deliberately independent of caller's expired authority. */
  releaseLease(lease: WorkflowLease, input: { reason: string }, tx?: Transaction): Promise<void>;
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
  get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot>;
  list(caller: Caller, tx?: Transaction): Promise<WorkflowSnapshot[]>;
  history(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowHistoryEntry[]>;
  catalog(): WorkflowDefinition[];
  /**
   * The stored contract of a version, loaded or not, or null when none is stored. It never
   * changes, so it needs no caller. The object returned is shared and deeply frozen: a caller
   * that needs to change it copies it first.
   */
  pinned(workflow: string, version: number, tx?: Transaction): Promise<WorkflowPinned | null>;
  /**
   * Derived on read from the definition and the record; never pinned, never authored. With
   * `checks: false` no program callback runs, so no edge carries a status: for a view that
   * draws only where the work stands.
   */
  process(
    caller: Caller,
    instanceId: string,
    options?: { checks?: boolean },
    tx?: Transaction,
  ): Promise<ProcessGraph>;
  evaluate(
    caller: Caller,
    instanceId: string,
    input?: WorkflowEvaluationInput,
    tx?: Transaction,
  ): Promise<WorkflowDecision>;
  overview(caller: Caller, tx?: Transaction): Promise<WorkflowOverview>;
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
    tx?: Transaction,
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
    tx?: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>>;
  /**
   * limitStatus of one limit for each of several instances, in a fixed number of reads per
   * definition. An instance whose definition has no such limit is left out, not refused.
   */
  limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    tx?: Transaction,
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
  /**
   * Internal provider capability; never exposed through a tool or a lease. `replace` makes the
   * provider's edges from the instance exactly `dependencies`: replacing with the set already
   * held changes nothing, so a repeat is safe without a request id.
   */
  systemPrerequisites(provider: string): {
    replace(
      input: { projectId: string; instanceId: string; dependencies: string[] },
      tx: Transaction,
    ): Promise<void>;
  };
  /**
   * The instance and the dependency edges a provider derives from, read inside its caller's
   * transaction and under that caller's already-checked authority. Null when the project holds
   * no such instance.
   */
  relations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowRelations | null>;
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
  /** Recent compact managed GPU run summaries across work revisions, when ML is available. */
  compute?: { key: string; runId: string; generation: number; state: string; cost: unknown }[];
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
  /** A required section needs at least one item. */
  sections: { key: string; title: string; required: boolean }[];
  outputInstructions: string;
  /** The only budget, in UTF-16 code units (JavaScript string length). */
  maxChars: number;
  /** 2: the item renderer. Absent in retired versions, which register refuses; optional so their
   *  definitions keep their hashes. */
  format?: 2;
}
export interface TaskTypeDefinition {
  name: string;
  version: number;
  kind: 'work' | 'review';
  recipe: ContextRecipe;
}
/** A unit of a context. Every item is listed by one line or embedded as one block. */
export interface ContextItem {
  /** Printed on one line, clipped to 300; two IDs equal after that fail invalid_context. */
  id: string;
  /** Printed on one line, clipped to 200. */
  title: string;
  body: { text: string } | { artifactId: string };
  /**
   * `always` embeds the body or fails the build; `fit` (the default) embeds it while it fits,
   * reading an artifact only when its media type is textual; `never` lists the item only.
   */
  embed?: 'always' | 'fit' | 'never';
  /** Higher first when room runs out; default 0. */
  priority?: number;
  /** Printed on the item's line or its block's heading, folded to one line, clipped to 300. */
  note?: string;
  /** At most 8, printed as given on the item's line. */
  refs?: { tool: string; input: Record<string, string | number | boolean | null> }[];
}
export interface ContextInput {
  items: ContextItem[];
}
export interface ContextBuild {
  subject: { id: string; revision: number; claimId?: string };
  inputs: Record<string, ContextInput>;
  requestId: string;
}
/** An artifact a context draws on, as its package records it. */
export interface ContextSource {
  id: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
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
  /** Every artifact the build resolved, whether or not its bytes are in the prompt. A package
   *  saved before sources were narrowed keeps the full artifact rows it recorded. */
  sources: ContextSource[];
  omitted: string[];
  hash: string;
  createdAt: string;
}
export type ContextPreview = Omit<ContextPackage, 'id' | 'createdAt'>;
/** The input of `build`: a preview to save under a request ID. */
export interface ContextSave {
  requestId: string;
  preview: ContextPreview;
}
export interface ContextRegistration {
  /**
   * With `tx`, or without it inside a transaction, runs there: the caller chose the placement,
   * and a writer transaction holds the writer lock while bytes are read. Outside any
   * transaction, authorization and artifact metadata are read in a read-only snapshot and the
   * bytes after it closes, so the builder never takes the writer lock.
   */
  preview(
    caller: Caller,
    input: Omit<ContextBuild, 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPreview>;
  /**
   * Saves a preview this registration returned, unchanged, once per project, actor and request
   * ID. In-process only: a preview is recognised by object identity, so build can never be
   * offered over HTTP or MCP. A request ID already saved returns its package when the recipe and
   * subject match, whatever inputs produced it; any other recipe or subject fails
   * request_conflict.
   */
  build(caller: Caller, input: ContextSave, tx?: Transaction): Promise<ContextPackage>;
  /** Replay an existing assignment request before rebuilding its live inputs. Placed as
   *  `preview` is: outside any transaction it reads in a read-only snapshot. */
  replay(
    caller: Caller,
    input: Pick<ContextBuild, 'subject' | 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPackage | null>;
  dispose(): void;
}
export interface ContextBuilder {
  register(definition: TaskTypeDefinition): Promise<ContextRegistration>;
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
  /** New tasks always use Git. Retired values remain typed for historical request replay. */
  workspace?: 'none' | 'git';
  /** Historical request replay only; new work derives its base from dependsOn. */
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
/** Work owners grant access; Sandboxes owns the rented machine and its lifetime. */
export interface WorkComputeAccess {
  computeMachines(caller: Caller, ownerId: string): Promise<Json[]>;
  computeRent(
    caller: Caller,
    ownerId: string,
    input: { key: string; provider: string; offerId: string; minutes: number },
  ): Promise<unknown>;
  computeSsh(caller: Caller, ownerId: string, sandboxId: string, publicKey: string): Promise<Json>;
  computeRelease(caller: Caller, ownerId: string, sandboxId: string): Promise<unknown>;
  computeExtend(
    caller: Caller,
    ownerId: string,
    sandboxId: string,
    minutes: number,
  ): Promise<unknown>;
}
export interface Tasks extends WorkComputeAccess {
  computeOffers(caller: Caller): Promise<unknown>;
  computeStatus(
    caller: Caller,
    taskId: string,
    runId?: string,
    generation?: number,
  ): Promise<unknown>;
  computeRun(
    caller: Caller,
    input: {
      taskId: string;
      expectedRevision: number;
      key: string;
      provider?: string;
      offerId?: string;
      rentalKey?: string;
      purpose?: 'check';
      command: string;
      minutes: number;
      maxUsd: number;
      commandId?: string;
      outputs?: { files: { name: string; path: string }[]; maxBytes: number };
    },
  ): Promise<unknown>;
  computeCancel(caller: Caller, taskId: string, runId: string): Promise<unknown>;
  computeLogs(caller: Caller, taskId: string, runId: string, generation?: number): Promise<unknown>;
  computeOutput(
    caller: Caller,
    taskId: string,
    runId: string,
    name: string,
    generation?: number,
  ): Promise<unknown>;
  computeTick(): Promise<void>;
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
