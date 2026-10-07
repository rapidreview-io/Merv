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
/**
 * A read's refusal as "not there": a record another owner answers 404 for is simply not there
 * to speak of, so `.catch(absent)` turns it into null and rethrows anything else.
 */
export const absent = (error: unknown): null => {
  if (error instanceof MervError && error.status === 404) return null;
  throw error;
};
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
/** Where a domain keeps its receipts: the table and its column names. */
export interface ReceiptTable {
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
}
/** How receipted() compares and replays a table's receipts. */
interface Receipt<T> extends ReceiptTable {
  /** Runs between the work and its record, for a domain that rechecks authority after yielding. */
  after?: () => Promise<unknown>;
  /** Runs on a replayed answer: a recheck, or defaults for fields older answers lack. */
  replay?: (result: T) => T | Promise<T>;
}
/**
 * One request's receipt in a domain's table, keyed by (project, actor, requestId): a retry with
 * the same hash finds what it answered, a different one conflicts. receipted() runs a command
 * through it; a domain whose request outlives one transaction (prepared, then completed) reads
 * and records its receipt itself, adding the columns its own table carries.
 */
export class RequestJournal {
  constructor(
    private readonly tx: Sql,
    private readonly receipt: ReceiptTable,
    private readonly projectId: string,
    private readonly actor: string,
    private readonly requestId: string,
    private readonly hash: string,
  ) {}

  /** The receipt's `columns` (by default its result), or nothing when none was kept. */
  async previous<T extends object = Record<string, string>>(
    columns = this.receipt.result ?? 'result',
  ): Promise<T | undefined> {
    const { table, actor = 'actor_id', operation } = this.receipt;
    const found = await this.tx.get<T & { receipt_hash: string; receipt_operation?: string }>(
      `SELECT ${this.receipt.hash ?? 'input_hash'} AS receipt_hash${operation === undefined ? '' : ',operation AS receipt_operation'},${columns} FROM ${table} WHERE project_id=? AND ${actor}=? AND request_id=?`,
      this.projectId,
      this.actor,
      this.requestId,
    );
    if (!found) return undefined;
    const { receipt_hash: hash, receipt_operation: kept, ...previous } = found;
    check(
      (operation === undefined || kept === operation) &&
        (hash === this.hash ||
          (this.receipt.legacyHash !== undefined && hash === this.receipt.legacyHash)),
      'request_conflict',
      this.receipt.conflict ?? 'requestId was already used with different input',
      409,
    );
    return previous as unknown as T;
  }

  /** Keeps `result`, already serialized, with any further columns the table carries. */
  record(result: string, columns: Record<string, SqlValue> = {}) {
    const { actor = 'actor_id', operation } = this.receipt;
    const values: Record<string, SqlValue> = {
      project_id: this.projectId,
      [actor]: this.actor,
      request_id: this.requestId,
      ...(operation === undefined ? {} : { operation }),
      [this.receipt.hash ?? 'input_hash']: this.hash,
      [this.receipt.result ?? 'result']: result,
      ...columns,
    };
    const names = Object.keys(values);
    return this.tx.run(
      `INSERT INTO ${this.receipt.table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
      ...Object.values(values),
    );
  }
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
  const journal = new RequestJournal(
    tx,
    receipt,
    caller.projectId,
    caller.actorId,
    requestId,
    hash,
  );
  const previous = await journal.previous();
  if (previous) {
    const result = JSON.parse(previous[receipt.result ?? 'result']) as T;
    return receipt.replay ? await receipt.replay(result) : result;
  }
  const result = await execute();
  await receipt.after?.();
  await journal.record(JSON.stringify(result));
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
  /** nextEvent's id alone, for a reader that only asks whether one is due. */
  nextEventId(
    after: number,
    types: readonly string[],
    tx?: Transaction,
  ): Promise<number | undefined>;
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
/**
 * One installed session manager owns the authority of credentialless worker actors. It answers
 * the worker's source, and whether this worker may still read as an actor its session retired
 * (a visit that only reads, such as a question to an agent whose work has ended).
 */
export interface SessionAuthority {
  require(
    caller: Caller,
    tx: Transaction,
    permission: Permission,
  ): Promise<{ source: DelegationSource; readsRetired?: boolean }>;
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
export type * from './scope.js';
import type { Scope } from './scope.js';
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
/**
 * What an owner withholds from a session worker's reads: artifacts by id, and every artifact
 * the named sessions made. Null withholds nothing.
 */
export type ArtifactReadRule = (
  caller: Caller,
  tx: Transaction,
) => Promise<{ artifacts: readonly string[]; sessions: readonly string[] } | null>;
export interface Artifacts {
  readonly downloadAvailable: boolean;
  readonly largeUploadAvailable: boolean;
  /** Backend-only provider registration; the disposer removes only this registration. */
  registerFileProvider(name: string, provider: ArtifactFileProvider): () => void;
  /**
   * An owner's rule over what a session worker (an inquiry visit too) may read, one per name,
   * until disposed. Every read by a session caller asks each rule; what one withholds is not
   * found and not listed.
   */
  registerReadRule(name: string, rule: ArtifactReadRule): () => void;
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
   * project (`not_found` if it is not) and the page starts after it; `sessions` keeps only the
   * artifacts created by those sessions. */
  list(
    caller: Caller,
    query?: { before?: string; limit?: number; sessions?: readonly string[] },
    tx?: Transaction,
  ): Promise<Artifact[]>;
  /** The outputs of the calling session worker's execution: the artifacts its session created
   * as this actor, oldest first, metadata only. Scope refuses a session caller whose actor is
   * not that session's worker; any other caller is refused here. */
  executionOutputs(caller: Caller, tx?: Transaction): Promise<Artifact[]>;
}
export type * from './workflows.js';
import type { WorkflowExecutionPolicy, Workflows } from './workflows.js';
/** Do not materialize this compatibility default into a persisted execution manifest. */
export function effectiveWorkspace(policy: WorkflowExecutionPolicy): WorkflowWorkspacePolicy {
  return structuredClone(policy.workspace ?? { mode: 'none' });
}
export type * from './reviews.js';
import type { Reviews } from './reviews.js';
export type * from './context.js';
import type { ContextBuilder } from './context.js';
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
