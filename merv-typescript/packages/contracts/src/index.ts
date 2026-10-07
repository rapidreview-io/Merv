export { nativeMcpConnectionsSchema, type NativeMcpConnection } from './launch-connections.js';
export { mapAsync, filterAsync, everyAsync } from './async.js';
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
export { cleanText, clip, ellipsis, itemTitle, visible } from './text.js';
export { folded, idPattern, idSchema, oidPattern, oidSchema } from './schemas.js';
export { ordered } from './order.js';
export {
  allowedOrigin,
  allowedUrl,
  fetchJson,
  jsonBytes,
  MAX_ANSWER_BYTES,
  origin,
  OutboundError,
  outboundFailure,
  record,
  sized,
  Slots,
} from './outbound.js';
export { sessionWorkspaceSchema, type CodePendingMerge } from './workspace.js';
export { sessionUsageReportSchema } from './usage-report.js';
export type * from './sessions-models.js';
export type * from './running.js';
export {
  runningKeyPattern,
  runningKey,
  keyKind,
  keyId,
  sameOriginPath,
  workLink,
} from './running.js';
export * as runningSchema from './running-schema.js';
export { MAX_TRANSCRIPT_BYTES, sessionSecretPattern } from './session-inputs.js';
export { CODE_DRIVER, WorkspaceDeferred } from './workspace-driver.js';
import type { WorkflowWorkspacePolicy } from './sessions-models.js';
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
  codeCommandCompletionSchema,
  codeCommandRecordSchema,
  codeLocalBindInputSchema,
} from './code.js';
export type {
  CodeLocalBindInput,
  CodeProjectBinding,
  CodeCommitInput,
  CodeMergeInput,
  CodeCommitCommand,
  CodeCommitReceipt,
  CodeCommandRecord,
  CodeCommandControl,
  CodeCommandCompletion,
} from './code.js';
import type { Data, Json } from './data.js';
import type { Artifact, ArtifactContent, ArtifactFile } from './artifact-models.js';
export type { Artifact, ArtifactContent } from './artifact-models.js';
import type { Actor, IssuedUserKey, Project, UserKey } from './scope-models.js';
export type { Actor, IssuedUserKey, Project, UserKey } from './scope-models.js';
import { clip, visible } from './text.js';
import type { Caller, DelegationSource, Permission, Role } from './scope-models.js';
export type { Caller, DelegationSource, Permission, Role } from './scope-models.js';
import type {
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
  WorkflowTransitionCount,
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
} from '@merv/workflows/models';
export class MervError extends Error {
  /** Set by the refusing component when the refusal only means "not yet": nothing is wrong
   *  with what was asked, so whoever retries it does not count it as a failure. */
  wait?: boolean;
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
 * operation refusing its input: a write under a read, a nested, closed or foreign transaction,
 * SQL whose bind markers do not match, a conflict, timeout or outage. A caller that turns
 * refusals into answers must not turn these.
 */
export const stateFault = (error: unknown): error is MervError =>
  error instanceof MervError &&
  ([
    'read_only_scope',
    'nested_transaction',
    'invalid_transaction',
    'invalid_sql_parameters',
  ].includes(error.code) ||
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
/** Field names that steer prototypes, refused wherever a name becomes an object key. */
export const RESERVED_KEYS: readonly string[] = ['__proto__', 'prototype', 'constructor'];
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
        if (limits.keys !== 'any' && RESERVED_KEYS.includes(key))
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
interface Receipt<T> {
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
/** Hex SHA-256 of text, as UTF-8, or of bytes. */
export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export type SqlValue = string | number | bigint | null | Uint8Array;
/** Await initialization before publishing a storage-backed service. */
export async function createService<T extends { initialize(): Promise<void> }>(
  service: T,
): Promise<T> {
  await service.initialize();
  return service;
}
/** A service module's function run on one service, which it takes as its first argument. */
export const bound =
  <C, A extends unknown[], R>(ctx: C, run: (ctx: C, ...args: A) => R) =>
  (...args: A): R =>
    run(ctx, ...args);
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
/** A component's migrations as its `*.postgres.ts` exports them: `{ [version]: sql }`. */
export type MigrationRecord = Readonly<Record<number, string>>;
/** The `{ version, sql }` list State runs, from either form `State.migrate` accepts. */
export const migrationList = (migrations: Migration[] | MigrationRecord): Migration[] =>
  Array.isArray(migrations)
    ? migrations
    : Object.entries(migrations).map(([version, sql]) => ({ version: +version, sql }));
/**
 * `statements` between `ALTER TABLE <table> DISABLE TRIGGER <trigger>;` and the matching ENABLE,
 * one line per trigger. DISABLE TRIGGER is transactional, so other sessions never see a guard off,
 * and it names the one guard without copying its pinned DDL; it needs table ownership. The emitted
 * text is embedded in published migrations and frozen like the retirement ledger in `@merv/workflows/retired-instances`.
 */
export function withoutTriggers(
  table: string,
  triggers: readonly string[],
  statements: string,
): string {
  const alter = (action: 'DISABLE' | 'ENABLE') =>
    triggers.map((trigger) => `ALTER TABLE ${table} ${action} TRIGGER ${trigger};`);
  return [...alter('DISABLE'), statements, ...alter('ENABLE')].join('\n');
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
/** Fields an event must match, all of them; `source` names fields of its recorded source. */
export interface EventFilter {
  projectId: string;
  type?: string;
  subjectId?: string;
  actorId?: string;
  /** Only events after this id. */
  after?: number;
  /** Only events created at or after this time. */
  since?: string;
  source?: Record<string, string>;
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
  /** A read-only transaction in such a snapshot: `snapshot(() => transaction(fn))`. */
  snapshotTransaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
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
  /**
   * Inside a snapshot or a write transaction, the value it already holds for `key`, else
   * `compute()`'s, kept until the scope ends or, in a write transaction, its next statement that
   * may write (a failure is not kept). Elsewhere it just runs `compute`. Only for answers that
   * rest on nothing but the scope's rows and the key.
   */
  remember<T>(key: string, compute: () => Promise<T>): Promise<T>;
  assertTransaction(tx: Transaction): void;
  migrate(component: string, migrations: Migration[] | MigrationRecord): Promise<void>;
  appendEvent(tx: Transaction, event: Omit<StoredEvent, 'id' | 'createdAt'>): Promise<StoredEvent>;
  events(projectId: string, after?: number): Promise<StoredEvent[]>;
  latestEvents(projectId: string, before?: number): Promise<StoredEvent[]>;
  /** The oldest `limit` (at most 1000) events matching `filter`, in order. */
  findEvents(filter: EventFilter, limit: number, tx?: Transaction): Promise<StoredEvent[]>;
  /** The first event after `after` of one of `types`, in any project; undefined if none. */
  nextEvent(
    after: number,
    types: readonly string[],
    tx?: Transaction,
  ): Promise<StoredEvent | undefined>;
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
  return place === 'read' ? await state.snapshotTransaction(fn) : await state.transaction(fn);
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
   * Signed GET valid 1 h, served as identity-encoded application/octet-stream whatever the
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
/**
 * The person themself, signed in: human authority and no other. Never a key, which agents and
 * workers hold, a leased worker, a runner, a conversation, a service or an actor credential.
 */
export const isDirectHuman = (
  caller: Caller,
): caller is Caller & { human: NonNullable<Caller['human']> } =>
  !!caller.human &&
  [
    caller.credentialId,
    caller.key,
    caller.session,
    caller.managed,
    caller.conversation,
    caller.service,
  ].every((authority) => !authority);
/** Refuses (403) anyone but the person themself, signed in: see isDirectHuman. */
export function requireHuman(
  caller: Caller,
  code: string,
  message: string,
): asserts caller is Caller & { human: NonNullable<Caller['human']> } {
  check(isDirectHuman(caller), code, message, 403);
}
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
/** A plugin entry's lifecycle state as the composition root reports it. */
type PluginRunState =
  'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'disabled';
export interface PluginStatus {
  id: string;
  name: string;
  state: PluginRunState;
  required: boolean;
  missingDependencies: string[];
}
/** The composition root's plugin lifecycle report; every reader of plugin state shares it. */
interface Composition {
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
/** Scope's people: verified identities, the projects they create and their memberships. */
export interface ScopeMembers {
  /** Trusted provider output only; accepting an invitation does not verify an identity. */
  acceptVerifiedIdentity(identity: VerifiedIdentity): Promise<HumanPrincipal>;
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
}
/** Keys a person issues to their own machines, which act through the person's memberships. */
export interface ScopeUserKeys {
  authenticate(token: string): Promise<UserKey>;
  /** Verified owners can inspect/revoke their own keys even after losing project membership. */
  keys(principal: Principal, projectId?: string): Promise<UserKey[]>;
  create(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<IssuedUserKey>;
  /** Rotation preserves owner/grant/project; it requires a current membership within that grant. */
  rotate(
    principal: Principal,
    input: { keyId: string; expiresAt?: string | null },
  ): Promise<IssuedUserKey>;
  /** Revoke the selected key and all of its rotation descendants atomically. */
  revoke(principal: Principal, keyId: string): Promise<void>;
}
/** Independent machine actors and their credentials, and the bootstrap of a first project. */
export interface ScopeActorCredentials {
  bootstrap(input: { projectName: string; actorName: string }): Promise<Credentials>;
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
  revokeActor(caller: Caller, actorId: string): Promise<void>;
}
export interface Scope {
  readonly members: ScopeMembers;
  readonly userKeys: ScopeUserKeys;
  readonly credentials: ScopeActorCredentials;
  /** Each project's owner: its longest-standing signed-in operator, as a person, who directs
   * and pays for its work on Fleet's machines. A project with none is left out. */
  projectOwners(tx?: Transaction): Promise<{ projectId: string; source: DelegationSource }[]>;
  /** The person who created the project by signing in; for a bootstrapped or imported one, its
   * owner (see projectOwners); null while it has neither. */
  projectCreator(
    projectId: string,
    tx?: Transaction,
  ): Promise<{ issuer: string; subject: string } | null>;
  /** A credential-free service actor owned by a server provider, scoped to one project. `provider`
   * is a lowercase slug; `role` defaults to producer, and scope@9's trigger refuses a role the
   * provider may not hold. */
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
  /** The actor of a Sessions thread, which every visit of the thread acts as. */
  createSessionActor(
    source: DelegationSource,
    input: { threadId: string; role: Exclude<Role, 'operator'>; name: string },
    tx: Transaction,
  ): Promise<Actor>;
  /** Changes a thread's actor's role within what `source` may delegate. Scope does not know who
   * owns a thread: the caller must already have proven it controls this one (Sessions: the thread
   * an offer opens, or resumes for the same source). */
  setThreadRole(
    source: DelegationSource,
    actorId: string,
    role: Exclude<Role, 'operator'>,
    tx: Transaction,
  ): Promise<void>;
  retireSessionActor(actorId: string, reason: string, tx: Transaction): Promise<void>;
  /**
   * Whether this actor was revoked, or lost `permission` through a role change, after event
   * `after`: a restored membership authorizes new work, never what was taken before the loss.
   */
  permissionLost(
    projectId: string,
    actorId: string,
    permission: Permission,
    after: number,
    tx: Transaction,
  ): Promise<boolean>;
  /** Verified delegation owner for scoped remote grants; does not change request attribution. */
  authorityActor(caller: Caller, tx?: Transaction): Promise<Actor>;
  authenticate(token: string): Promise<AuthenticatedActor>;
  /** Recognize any issued local digest, including revoked/expired credentials. */
  recognizesCredential(token: string): Promise<boolean>;
  caller(principal: Principal, projectId?: string): Promise<Caller>;
  projects(principal: Principal): Promise<Project[]>;
  require(caller: Caller, permission: Permission, tx?: Transaction): Promise<Actor>;
  /** Whether this actor may act with `permission`; with `{ except }`, whether any actor but
   * those, and no worker session's, may. */
  eligible(
    projectId: string,
    actor: string | { except: readonly string[] },
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean>;
  project(caller: Caller, tx?: Transaction): Promise<Project>;
  actors(caller: Caller): Promise<Actor[]>;
}
/** The most bytes an artifact holds inline: created whole, or read whole or in ranges. */
export const MAX_ARTIFACT_BYTES = 2_000_000;
/** The most ids one `Artifacts.getMany` call looks up; `getAll` takes any number. */
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
  /** One authorisation and one query for up to MAX_ARTIFACT_IDS ids: those this project holds. */
  find(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Map<string, Artifact>>;
  /** One authorisation and one query for up to MAX_ARTIFACT_IDS ids: the artifacts in input
   * order, duplicates kept; `not_found` for the first id that is not in this project. */
  getMany(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]>;
  /** `getMany` for any number of ids, MAX_ARTIFACT_IDS at a time: the artifacts in input order,
   * duplicates kept; `not_found` for the first id that is not in this project. */
  getAll(caller: Caller, ids: readonly string[], tx?: Transaction): Promise<Artifact[]>;
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
  /** The outputs of the calling session worker's execution: the artifacts its session created
   * as this actor, oldest first, metadata only. Scope refuses a session caller whose actor is
   * not that session's worker; any other caller is refused here. */
  executionOutputs(caller: Caller, tx?: Transaction): Promise<Artifact[]>;
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
/** A deployed definition as the catalog reads it: each edge with the tool that takes it, if any. */
export interface WorkflowCatalogEntry extends Omit<WorkflowDefinition, 'edges'> {
  edges: (WorkflowDefinition['edges'][number] & { tool: string | null })[];
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
  describe?(context: WorkflowCheckContext): WorkflowDescription | Promise<WorkflowDescription>;
  /**
   * Before a read decides many instances of this version at once (guidance, an overview, a
   * dispatch scan), the program may read in one pass what its callbacks will ask of each, kept
   * where they look for it (`state.remember`), so they need not read it one instance at a time.
   * It only spares reads: it never changes an answer, and a refusal here is none, since each
   * instance's callbacks still answer for it. Read-only, in the read's own transaction.
   */
  prepare?(context: {
    caller: Caller;
    tx: Transaction;
    snapshots: readonly WorkflowSnapshot[];
  }): void | Promise<void>;
}
export interface WorkflowDescription {
  label: string;
  references: WorkflowReference[];
  gate?: string;
  waiting?: string;
  /** Whose own move the record is, which a decision answers for its reader as `yours`. */
  owner?: WorkflowOwner;
}
/**
 * Whose record an instance is, as its program says: the actor it belongs to; the actions that
 * are their move even where the gate refuses nothing, each with the sentence asking it of them
 * (`asks`); and the actions only a leased worker makes, which are never theirs (`leased`).
 */
export interface WorkflowOwner {
  actorId: string;
  asks?: Record<string, string>;
  leased?: string[];
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
export interface WorkflowAssignmentContent {
  role: string;
  /** For the agent, saying the purpose (`Work: …`); `name` is the record's own, for a person. */
  label: string;
  name?: string;
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
/** An instance as get() reads it, with its workStarts() and both directions of its edges. */
export interface WorkflowRecord {
  snapshot: WorkflowSnapshot;
  workStarts: WorkflowWorkStart[];
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
}
export interface Workflows {
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
  /** get() for several instances in one read; an id the project does not hold is left out. */
  find(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowSnapshot>>;
  /** The project's instances, oldest first; with `workflow`, only that workflow's. */
  list(caller: Caller, tx?: Transaction, workflow?: string): Promise<WorkflowSnapshot[]>;
  history(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowHistoryEntry[]>;
  /**
   * System reads for a caller already authorized for what it asks. `open`: the instances of
   * `workflow` in a nonterminal state of their own pinned version, in one project or (null)
   * every project, oldest first. `movedBy`: who moved an instance to `revision`, if anyone.
   * `revisions`: where each named instance of the project stands, without its data; an id the
   * project does not hold is left out. `moves`: how many moves by `action` in the project
   * recorded one of `values` under one of `keys` of their data.
   */
  open(workflow: string, projectId: string | null, tx?: Transaction): Promise<WorkflowSnapshot[]>;
  movedBy(instanceId: string, revision: number, tx?: Transaction): Promise<string | null>;
  revisions(
    projectId: string,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, Omit<WorkflowSnapshot, 'data'>>>;
  /** How often each instance made each move, without the moves' data, in one read per batch. */
  transitionCounts(
    projectId: string,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowTransitionCount[]>>;
  moves(
    projectId: string,
    match: { action: string; keys: readonly string[]; values: readonly string[] },
    tx?: Transaction,
  ): Promise<number>;
  catalog(): WorkflowCatalogEntry[];
  /**
   * The stored contract of a version, loaded or not, or null when none is stored. It never
   * changes, so it needs no caller. The object returned is shared and deeply frozen: a caller
   * that needs to change it copies it first.
   */
  pinned(workflow: string, version: number, tx?: Transaction): Promise<WorkflowPinned | null>;
  /**
   * How each instance stands against its own pinned contract, as a prerequisite's edge says it:
   * `settled` in one of its success states, `failed` in a terminal state outside them. Without
   * declared success states neither holds. Reads contracts only, so it needs no caller.
   */
  ends(
    instances: readonly Pick<WorkflowSnapshot, 'workflow' | 'version' | 'state'>[],
    tx?: Transaction,
  ): Promise<{ settled: boolean; failed: boolean }[]>;
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
  /** With `open`, only unended work and ended work a provider still holds with a blocker. */
  overview(
    caller: Caller,
    tx?: Transaction,
    options?: { open?: boolean },
  ): Promise<WorkflowOverview>;
  /**
   * Open work whose current state's loop limit is used up, or that waits in a state only
   * another round moves on (a rule there whose tool is workflow.extend_limit), with that limit,
   * and whether this reader may allow another round (a project admin who is not a leased worker).
   */
  escalated(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{
    admin: boolean;
    items: { instanceId: string; revision: number; limit: WorkflowLimitStatus }[];
  }>;
  /** Only a project admin who is not a leased worker may allow a capped loop more rounds. */
  extendLimit(
    caller: Caller,
    input: WorkflowExtendLimit,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus>;
  /**
   * get(), workStarts(), prerequisites() and what depends on each of several instances, for a
   * list of records, in a fixed number of reads however many. An id the project does not hold
   * is left out.
   */
  records(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowRecord>>;
  /**
   * What each of several instances depends on, without what depends on it, in a fixed number
   * of reads. An id the project does not hold depends on nothing; `requireDependencies` from
   * `@merv/workflows/rules` refuses work whose prerequisites have not all settled.
   */
  prerequisites(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>>;
  /**
   * Where one named loop limit stands for each of several instances, in a fixed number of reads
   * per definition. An instance whose definition has no such limit is left out, not refused.
   */
  limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    tx?: Transaction,
  ): Promise<Map<string, WorkflowLimitStatus>>;
  /**
   * The used-up limit leaving the instance's current state, if any: where nothing returns the
   * work again, so an owner rules out what would (a review's rejecting verdicts).
   */
  exhaustedLimit(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus | undefined>;
  /**
   * The instance (or each of several), everything it transitively depends on, and the children
   * their policies declare: the grouping a research cycle's usage and budget are read over.
   */
  dependencyClosure(
    caller: Caller,
    instanceIds: string | readonly string[],
    tx?: Transaction,
  ): Promise<string[]>;
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
import type {
  ReviewClaim,
  ReviewFinding,
  ReviewGuide,
  ReviewProvenance,
  ReviewRequest,
  ReviewReturn,
} from './review-models.js';
export type {
  ReviewClaim,
  ReviewFinding,
  ReviewGuide,
  ReviewProvenance,
  ReviewRequest,
  ReviewReturn,
} from './review-models.js';
export type ReviewProvenanceResolver = (
  projectId: string,
  subjectId: string,
  tx: Transaction,
) => Promise<ReviewProvenance>;
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
/** A held claim handed back, with why; review.release replays by requestId. */
export interface ReviewRelease {
  reviewId: string;
  reason: string;
  requestId: string;
}
/**
 * A verdict as the owning domain applies it. Fields the owner names in `fields` pass through
 * Reviews unread, and the owner validates them.
 */
export interface ReviewApplication extends ReviewSubmit {
  expectedRevision: number;
}
/** Trusted synchronous domain callbacks; ownership checks read metadata only. */
export interface ReviewSubmitOwner {
  id: string;
  owns(review: Readonly<ReviewRequest>, tx: Transaction): boolean | Promise<boolean>;
  submit(caller: Caller, input: ReviewApplication, tx: Transaction): Promise<unknown>;
  /** The owner's verdict rules, shown to a reviewer reading or claiming one of its reviews. */
  guidance?: string;
  /** Extra top-level verdict fields the owner accepts and validates itself; others are refused. */
  fields?: readonly string[];
  /** Refuses a claim of an owned review that the owner's rules could never let finish. */
  claim?(caller: Caller, review: Readonly<ReviewRequest>, tx: Transaction): Promise<void>;
  /** The codes of `claim`'s refusals that the project's owner, deciding as owner, lifts. */
  overrides?: readonly string[];
  /**
   * The verdicts that return the owned work to its producer. Once the limit leaving the work's
   * gate is used up (`Workflows.exhaustedLimit`), Reviews rules them out itself: the reviewer
   * is then told so, and offered no return route if no rejecting verdict is left.
   */
  returning?: readonly Verdict[];
  /** The verdicts this caller may submit on an owned review, where the owner's rules rule some out. */
  verdicts?(
    caller: Caller,
    review: Readonly<ReviewRequest>,
    tx: Transaction,
  ): Promise<readonly Verdict[]>;
  /** The routes a rejecting verdict on this review may choose, where the owner offers a choice. */
  returns?(review: Readonly<ReviewRequest>, tx: Transaction): Promise<readonly ReviewReturn[]>;
  /**
   * The gate each owned review among these was read at, for a domain whose records are
   * reviewed at more than one. Read-only; ids it does not own are left out.
   */
  gates?(reviewIds: readonly string[], sql: Sql): Promise<Readonly<Record<string, string>>>;
  /** What the delivery an owned review judges claimed of each check, where the owner keeps
   *  such claims; read-only, and empty for a review of anything but the newest delivery. */
  claims?(
    caller: Caller,
    review: Readonly<ReviewRequest>,
    tx: Transaction,
  ): Promise<readonly ReviewClaim[]>;
}
export interface Reviews {
  provenance(provider: string): { register(resolve: ReviewProvenanceResolver): () => void };
  registerSubmitOwner(owner: ReviewSubmitOwner): () => void;
  /** Select one current domain owner and apply its verdict/transition in the same writer. */
  apply(caller: Caller, input: ReviewApplication, tx?: Transaction): Promise<unknown>;
  /** What the one domain that owns this review tells its reviewer: its verdict rules, return
   * routes, the verdicts open to this reader, what deciding as owner lifts, the gate it reads
   * and what the delivery claimed, where it states them. A review the caller has just read (get, start) is not read again. */
  guide(caller: Caller, review: string | ReviewRequest, tx?: Transaction): Promise<ReviewGuide>;
  request(caller: Caller, input: ReviewInput, tx?: Transaction): Promise<ReviewRequest>;
  /** Trusted cleanup of exactly one worker claim, without reviving expired caller authority. */
  releaseClaim(
    input: {
      projectId: string;
      reviewId: string;
      claimId: string;
      actorId: string;
      reason: string;
      releasedBy?: string;
    },
    tx: Transaction,
  ): Promise<void>;
  /** Hands a claim back, by the reviewer who holds it or a project admin, never a leased worker. */
  release(caller: Caller, input: ReviewRelease, tx?: Transaction): Promise<ReviewRequest>;
  get(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  /**
   * Several reviews in one read, without what get() adds for an operator; an id the project
   * does not hold is left out.
   */
  find(
    caller: Caller,
    ids: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, ReviewRequest>>;
  /** With `subjectId`, only the reviews of that record. */
  list(caller: Caller, filter?: { subjectId?: string }): Promise<ReviewRequest[]>;
  /**
   * What Home and the rail poll: every open review, each subject's current review and newest
   * verdict, and the newest verdicts, oldest first; `list` holds every review.
   */
  home(caller: Caller): Promise<ReviewRequest[]>;
  /** How many of the project's reviews are requested or started. */
  open(caller: Caller): Promise<number>;
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
interface ContextRecipe {
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
export interface ContextRecipeDefinition {
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
interface ContextSave {
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
  register(definition: ContextRecipeDefinition): Promise<ContextRegistration>;
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
  GitHubPullDetails,
  GitHubAutomationInput,
} from './github-models.js';
