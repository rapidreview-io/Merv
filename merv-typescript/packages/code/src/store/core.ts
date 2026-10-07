import {
  check,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import {
  CODE_PART_MAX_BYTES,
  type CodeFinding,
  type CodeRepositoryImportInput,
  type CodeAdmissionLimits,
  type CodeStoreOperation,
} from './protocol.js';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriterFence } from '../writers.js';
import { defaultLimits } from './admission.js';
import type { CodeRepositories, CodeRepositoryConfig, ObjectFormat } from './repository.js';

export interface CodeStoreConfig extends CodeRepositoryConfig {
  /** How often unfinished operations are taken up again and leftovers are swept. */
  sweepSeconds: number;
  /** How long unloading waits for running operations before it ends their Git children. */
  drainSeconds: number;
  /** The part size the server asks machines to send. */
  partBytes: number;
  /** A transfer nobody sent a byte to for this long is given up. */
  abandonSeconds: number;
  /** How many transfers of one project may be receiving at once. */
  receiving: number;
  /** What a project may keep of bundles admission refused; the oldest make room. */
  heldBundles: number;
  heldBytes: number;
  /** How long a completing call waits for admission before it answers with the state so far. */
  settleMs: number;
  limits: typeof defaultLimits;
}
export const defaultStoreConfig: Omit<CodeStoreConfig, 'root'> = {
  quotaBytes: 10 * 1024 * 1024 * 1024,
  reservedFreeBytes: 2 * 1024 * 1024 * 1024,
  sweepSeconds: 300,
  drainSeconds: 45,
  partBytes: CODE_PART_MAX_BYTES,
  abandonSeconds: 24 * 3600,
  receiving: 4,
  heldBundles: 8,
  heldBytes: 1024 * 1024 * 1024,
  settleMs: 5_000,
  limits: defaultLimits,
};

/** The boundaries between the database and Git at which a test ends the process. */
export type FaultPoint =
  | 'after_part'
  | 'after_index'
  | 'after_admitting'
  | 'after_migrate'
  | 'after_objects_durable'
  | 'after_ref'
  | 'after_refs_applied'
  | 'after_rebind_marker'
  | 'before_ack';

/** How Code reads the repository a project is linked to; the credential ends with the call. */
export interface CodeImportRemote {
  read<T>(
    caller: Caller,
    use: (target: {
      url: string;
      protocol: 'https' | 'file';
      repository: { id: number; fullName: string };
      env: Record<string, string>;
    }) => Promise<T>,
    binding?: CodeRepositoryImportInput['githubBinding'],
  ): Promise<T>;
}
/** What a machine needs to read a download, or the word that it already has the head. */
export interface CodeStoreHooks {
  /** A project's repository gained history or a binding: what waited for it is derived again. */
  changed(tx: Transaction, projectId: string): Promise<void>;
  /**
   * Sessions of the project that hold a workspace in Code's repository right now, read-only
   * ones included. Rebinding refuses while any is in flight. It is asked by project on the
   * rebind's own transaction: who is asking for the rebind must not narrow what it is refused for.
   */
  workspaces(projectId: string, tx: Transaction): Promise<string[]>;
  /** The writer fence, asked when an upload begins (`begin`), continues and before any ref
   *  moves. Only a live writer begins one; one in flight may finish after its session closed. */
  fenced(
    tx: Transaction,
    fence: WriterFence,
    kind: 'checkpoint' | 'final',
    begin?: boolean,
  ): Promise<unknown>;
  advanced(
    tx: Transaction,
    fence: WriterFence,
    input: { head: string; operationId: string; final: boolean },
  ): Promise<void>;
  quarantined(tx: Transaction, fence: WriterFence, operationId: string): Promise<void>;
  /** Runs with every maintenance pass, for what only time moves. */
  maintained?(): Promise<void>;
}
export interface OperationRow {
  id: string;
  project_id: string;
  principal_scope: string;
  request_id: string;
  kind: string;
  input_hash: string;
  payload_json: string;
  status: 'prepared' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  unit_id: string | null;
  generation: number | string | null;
  phase: string | null;
  progress_json: string | null;
  detail_json: string | null;
  updated_at: string | null;
}
export type Bundle = { sha256: string; bytes: number };
export type ImportPayload = { format: 1; actorId: string } & (
  | { source: 'bundle'; tip: string; bundle: Bundle }
  | {
      source: 'github';
      ref: string;
      expectedHead?: string;
      githubBinding?: CodeRepositoryImportInput['githubBinding'];
    }
);
/**
 * An upload pins everything its later calls are compared with: who began it, from which
 * machine and launch, and the whole writer fence. `tip` is the head it proposes.
 */
export interface UploadPayload {
  format: 1;
  source: 'upload';
  actorId: string;
  kind: 'checkpoint' | 'final';
  runnerId: string;
  hostRef: string;
  sessionId: string;
  leaseId: string;
  unitId: string;
  generation: number;
  commandId: string | null;
  expectedHead: string;
  tip: string;
  treeOid: string;
  bundle: Bundle | null;
}
/** A retained ref whose objects are already durable. */
export type RetainRefPayload = {
  format: 1;
  source: 'retain-ref';
  actorId: string;
  unitId: string;
  tip: string;
  retentionKey?: string;
  ref?: string;
  mirror?: boolean;
};
/**
 * The identity a project is being rebound to. The database trigger reads `repositoryId` out of
 * this payload and refuses any other value in the row, and `code_operations_identity` makes the
 * payload immutable, so the operation is what fixes the value the binding may take.
 */
export interface RebindPayload {
  format: 1;
  source: 'rebind';
  actorId: string;
  repositoryId: string;
  mainOid: string;
  reason: string;
}
export type Payload = ImportPayload | UploadPayload | RetainRefPayload | RebindPayload;
export const kinds = ['import', 'upload', 'retain-ref'];
export interface Progress {
  received: number;
  merge?: { plan: string; left: string; right: string; firstMerge: string | null };
  /** Fixed before any ref moves; recovery applies exactly this and never another target. */
  expectedOld?: string | null;
  target?: string;
  receiptRef?: string;
  tree?: string;
  objects?: number;
  bytes?: number;
  objectFormat?: ObjectFormat;
  github?: { id: number; fullName: string };
  waiting?: CodeStoreOperation['waiting'];
}
export interface ProjectRow {
  repository_id: string;
  main_json: string;
  limits_json: string;
  store_json: string | null;
}

export const columns =
  'id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,error,created_at,completed_at,unit_id,generation,phase,progress_json,detail_json,updated_at';
export const journalled = ['admitting', 'objects_durable', 'refs_applied'];
/** One job at a time per key, in the order asked; a job runs whatever the one before ended in. */
export function serial<T>(
  chains: Map<string, Promise<void>>,
  key: string,
  job: () => Promise<T>,
): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(job);
  const settled = run.then(
    () => {},
    () => {},
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}
export const FETCH_TIMEOUT_MS = 10 * 60_000;
/** One line of a busy refusal: what is in flight, how much of it, and the first twenty names. */
export const held = (what: string, names: string[]) =>
  names.length ? [`${what} ${names.length} (${names.slice(0, 20).join(', ')})`] : [];

/**
 * What every part of the store shares: the services it was opened with, the journal's rows, who
 * may touch them, and the work it owns until it closes. Receiving, downloads and rebinding are
 * collaborators that take it, and `CodeStore` composes them (operations.ts).
 */
export class StoreCore {
  readonly config: CodeStoreConfig;
  closed = false;
  readonly cancellation = new AbortController();
  readonly active = new Set<Promise<unknown>>();
  constructor(
    readonly state: State,
    readonly scope: Scope,
    config: Pick<CodeStoreConfig, 'root'> & Partial<CodeStoreConfig>,
    readonly hooks: CodeStoreHooks,
    /** Opened and closed by their owner, which holds the writer lock. */
    readonly repositories: CodeRepositories,
    readonly remote?: CodeImportRemote,
    /** Throws at a named boundary, which is how a test ends the process there. */
    readonly fault: (point: FaultPoint) => void = () => {},
  ) {
    this.config = { ...defaultStoreConfig, ...config };
  }
  owned<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.repositories.git.scoped(this.cancellation.signal, operation);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  /** Which of these commits the project's repository does not hold, asked in one Git call. */
  async absent(projectId: string, oids: string[]): Promise<Set<string>> {
    const distinct = [...new Set(oids)].sort();
    if (!distinct.length || !(await this.repositories.exists(projectId))) return new Set(distinct);
    const found = await this.repositories.git.run(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      {
        env: this.repositories.environment(projectId),
        input: distinct.join('\n') + '\n',
      },
    );
    const held = new Set(
      found.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line.endsWith(' commit'))
        .map((line) => line.split(' ')[0]),
    );
    return new Set(distinct.filter((oid) => !held.has(oid)));
  }

  assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }

  managedSession(caller: Caller, sessionId: string): void {
    check(
      !caller.managed || caller.managed.boundSessionId === sessionId,
      'managed_runner_forbidden',
      'A managed runner may transfer code only for its bound session',
      403,
    );
  }

  async managedRead(caller: Caller, sessionId: string): Promise<void> {
    if (!caller.managed) return;
    await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        await this.scope.require(caller, 'read', tx);
        this.managedSession(caller, sessionId);
      }),
    );
  }

  async administrator(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'admin', tx);
    check(
      !caller.session,
      'session_forbidden',
      'A leased worker cannot change the project’s repository',
      403,
    );
  }

  async row(sql: Sql, id: string): Promise<OperationRow | undefined> {
    return await sql.get<OperationRow>(`SELECT ${columns} FROM code_operations WHERE id=?`, id);
  }

  async project(sql: Sql, projectId: string): Promise<ProjectRow | undefined> {
    return await sql.get<ProjectRow>(
      'SELECT repository_id,main_json,limits_json,store_json FROM code_projects WHERE project_id=?',
      projectId,
    );
  }

  limits(project: ProjectRow | undefined): CodeAdmissionLimits {
    const stored = JSON.parse(project?.limits_json ?? '{}') as Partial<CodeAdmissionLimits>;
    return {
      format: 1,
      denyGlobs: stored.denyGlobs ?? [],
      secretExemptGlobs: stored.secretExemptGlobs ?? [],
    };
  }

  declared(row: OperationRow): number | null {
    const payload = JSON.parse(row.payload_json) as Payload;
    return payload.source === 'bundle' || payload.source === 'upload'
      ? (payload.bundle?.bytes ?? null)
      : null;
  }

  view(row: OperationRow): CodeStoreOperation {
    const payload = JSON.parse(row.payload_json) as { tip?: string };
    const progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    const detail = JSON.parse(row.detail_json ?? '{}') as {
      findings?: CodeFinding[];
      message?: string;
    };
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      phase: row.phase,
      unitId: row.unit_id,
      generation: row.generation === null ? null : Number(row.generation),
      received: progress.received ?? 0,
      bytes: this.declared(row),
      partBytes: this.config.partBytes,
      head: progress.target ?? payload.tip ?? null,
      error:
        row.error ??
        (row.kind === 'initialize' && detail.message ? 'code_initialization_failed' : null),
      findings: detail.findings ?? [],
      waiting: row.status === 'prepared' ? (progress.waiting ?? null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      completedAt: row.completed_at,
    };
  }

  /** Take away the leftover locks of the refs one transaction writes; says whether any was there. */
  async clearRefLocks(repository: string, refs: string[]): Promise<boolean> {
    let cleared = false;
    for (const ref of refs) {
      const lock = join(repository, `${ref}.lock`);
      if (!(await lstat(lock).catch(() => null))) continue;
      await rm(lock, { force: true });
      cleared = true;
    }
    return cleared;
  }
}
