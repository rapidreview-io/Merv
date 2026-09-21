import {
  canonical,
  check,
  CODE_BUNDLE_MAX_BYTES,
  CODE_PART_MAX_BYTES,
  codeRepositoryConfigureInputSchema,
  codeRepositoryImportInputSchema,
  digest,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeFinding,
  type CodeRepositoryImportInput,
  type CodeStoreLimits,
  type CodeStoreOperation,
  type CodeStoreStatus,
  type CodeUploadBegin,
  type CodeUploadFinalize,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodeInput } from '../input.js';
import type { WriterFence } from '../writers.js';
import { admit, AdmissionRejected, bundleHeader, defaultLimits } from './admission.js';
import { acceptedRef, workRef } from './refs.js';
import {
  CodeRepositories,
  diskBytes,
  EXPORT_TTL_MS,
  syncDirectory,
  type CodeRepositoryConfig,
  type ObjectFormat,
} from './repository.js';

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
  ): Promise<T>;
}
/** What a machine needs to read a download, or the word that it already has the head. */
export type CodeExport =
  | { upToDate: true; head: string }
  | {
      exportId: string;
      sha256: string;
      bytes: number;
      head: string;
      prerequisites: string[];
      partBytes: number;
      expiresAt: string;
    };
export interface CodeStoreHooks {
  /** A project's repository gained history: what waited for it is derived again. */
  imported(tx: Transaction, projectId: string): Promise<void>;
  /** The writer fence, asked when an upload begins, continues and before any ref moves. */
  fenced(tx: Transaction, fence: WriterFence, kind: 'checkpoint' | 'final'): Promise<unknown>;
  advanced(
    tx: Transaction,
    fence: WriterFence,
    input: { head: string; operationId: string; final: boolean },
  ): Promise<void>;
  quarantined(tx: Transaction, fence: WriterFence, operationId: string): Promise<void>;
  /** Runs with every maintenance pass, for what only time moves. */
  maintained?(): Promise<void>;
}

interface OperationRow {
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
type Bundle = { sha256: string; bytes: number };
type ImportPayload = { format: 1; actorId: string } & (
  { source: 'bundle'; tip: string; bundle: Bundle } | { source: 'github'; ref: string }
);
/**
 * An upload pins everything its later calls are compared with: who began it, from which
 * machine and launch, and the whole writer fence. `tip` is the head it proposes.
 */
interface UploadPayload {
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
/** The ref an acceptance is kept under; its objects are already in the repository. */
interface AcceptRefPayload {
  format: 1;
  source: 'accept-ref';
  actorId: string;
  unitId: string;
  tip: string;
}
type Payload = ImportPayload | UploadPayload | AcceptRefPayload;
const fenceOf = (row: { project_id: string }, payload: UploadPayload): WriterFence => ({
  projectId: row.project_id,
  unitId: payload.unitId,
  generation: payload.generation,
  sessionId: payload.sessionId,
  leaseId: payload.leaseId,
  expectedHead: payload.expectedHead,
  moves: payload.bundle !== null,
});
/** Refusals of the fence end an upload; nothing about them passes with time. */
const fenceRefusals = ['code_generation_stale', 'code_writer_closed', 'code_head_conflict'];
const kinds = ['import', 'upload', 'accept-ref'];
interface Progress {
  received: number;
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
interface ProjectRow {
  repository_id: string;
  main_json: string;
  limits_json: string;
  store_json: string | null;
}

const columns =
  'id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,error,created_at,completed_at,unit_id,generation,phase,progress_json,detail_json,updated_at';
const journalled = ['admitting', 'objects_durable', 'refs_applied'];
const FETCH_TIMEOUT_MS = 10 * 60_000;
const next: Record<string, string> = {
  code_store_full:
    'Free space on the Code volume or raise the project’s quota, then complete the operation again.',
  code_recovery_required:
    'An operator inspects the named ref in the project’s repository: it holds neither the value this operation expected nor the one it writes, and Code will not choose for them.',
  code_drain_pending: 'Nothing: the operation is journalled and the next start of Code replays it.',
  code_import_interrupted:
    'Call code.repository.import again with the same requestId; reading GitHub needs the administrator who asked for it.',
};
const resume = 'Complete the operation again; it resumes where it stopped.';
/** A full volume is a refusal that passes, not a fault of the operation that met it. */
const refusal = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOSPC'
    ? new MervError('code_store_full', 'The Code volume is full', 507)
    : error;

/**
 * The journal of everything that moves objects and refs in a project's repository. A database
 * transaction and a Git ref transaction cannot commit together, so each operation is a
 * `code_operations` row that walks
 *
 *   receiving → admitting → objects_durable → refs_applied → completed | failed
 *
 * and the database is the authority at every step: the files of a step can always be rebuilt
 * from the retained bundle, or are swept. The exact ref update is written down before it is
 * made, so a start after a crash either finds the receipt ref or retries that same update.
 */
export class CodeStore {
  readonly repositories: CodeRepositories;
  readonly config: CodeStoreConfig;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private waker?: NodeJS.Timeout;
  private woken = false;
  private maintaining?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly parts = new Map<string, Promise<unknown>>();
  private readonly exports = new Map<
    string,
    {
      key: string;
      projectId: string;
      sessionId: string;
      view: Exclude<CodeExport, { upToDate: true }>;
    }
  >();
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    config: Pick<CodeStoreConfig, 'root'> & Partial<CodeStoreConfig>,
    private readonly hooks: CodeStoreHooks,
    private readonly remote?: CodeImportRemote,
    /** Throws at a named boundary, which is how a test ends the process there. */
    private readonly fault: (point: FaultPoint) => void = () => {},
  ) {
    this.config = { ...defaultStoreConfig, ...config };
    this.repositories = new CodeRepositories(this.config);
  }

  /** Take the writer lock, then finish what an earlier process left between two steps. */
  async initialize(): Promise<void> {
    await this.repositories.open();
    try {
      await this.maintain();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.timer = setInterval(
      () => void this.maintain().catch(() => {}),
      this.config.sweepSeconds * 1000,
    );
    this.timer.unref();
    this.waker = setInterval(() => {
      if (!this.woken) return;
      this.woken = false;
      void (async () => {
        await this.maintaining?.catch(() => {});
        await this.maintain(false);
      })().catch(() => {});
    }, 200);
    this.waker.unref();
  }

  async importRepository(caller: Caller, value: unknown): Promise<CodeStoreOperation> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input: CodeRepositoryImportInput = parseCodeInput(codeRepositoryImportInputSchema, value);
    const { requestId, ...body } = input;
    const payload: ImportPayload =
      input.source === 'bundle'
        ? {
            format: 1,
            actorId: caller.actorId,
            source: 'bundle',
            tip: input.tip!,
            bundle: input.bundle!,
          }
        : { format: 1, actorId: caller.actorId, source: 'github', ref: input.ref! };
    const inputHash = digest(body);
    const principal = `actor:${caller.actorId}`;
    const begin = async (insert: boolean) =>
      await this.state.transaction(async (tx) => {
        await this.administrator(caller, tx);
        check(
          await this.project(tx, caller.projectId),
          'code_project_unbound',
          'Bind this project with code.local.bind before importing its repository',
          409,
        );
        const previous = await tx.get<OperationRow>(
          `SELECT ${columns} FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?`,
          caller.projectId,
          principal,
          requestId,
        );
        if (previous || !insert) {
          check(
            !previous || previous.input_hash === inputHash,
            'request_conflict',
            'This request id was used with different input',
            409,
          );
          return previous;
        }
        await this.assertReceiving(tx, caller.projectId);
        const id = newId('cop'),
          at = now();
        await tx.run(
          'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          caller.projectId,
          principal,
          requestId,
          'import',
          inputHash,
          canonical(payload),
          'prepared',
          at,
          'receiving',
          canonical({ received: 0 } satisfies Progress),
          at,
        );
        return (await this.row(tx, id))!;
      });
    let row = await begin(false);
    if (!row) {
      await this.repositories.assertRoom(
        caller.projectId,
        payload.source === 'bundle' ? payload.bundle.bytes : 0,
      );
      row = (await begin(true))!;
    }
    // GitHub is read as the administrator who asked, so only their own call can start it.
    if (input.source === 'github' && row.status === 'prepared')
      await this.settle(this.start(row, caller));
    return this.view((await this.state.read((sql) => this.row(sql, row.id)))!);
  }

  /**
   * Begin the upload of one commit or of the final capture of a unit, under its writer fence.
   * The caller has already shown that the session is theirs and runs on the machine they
   * name. An upload that moves nothing completes here; one that carries a bundle first ends
   * every transfer of the unit that was only receiving, because nobody will complete it.
   */
  async beginUpload(
    caller: Caller,
    input: CodeUploadBegin | CodeUploadFinalize,
  ): Promise<CodeStoreOperation> {
    this.assertOpen();
    caller = structuredClone(caller);
    const requestId = input.kind === 'final' ? `final:${input.sessionId}` : input.requestId;
    check(
      input.kind === 'final' || input.requestId === input.commandId,
      'invalid_input',
      'A checkpoint upload is requested under the id of its command',
    );
    check(
      (input.bundle === null) === (input.proposedHead === input.expectedHead),
      'invalid_input',
      'An upload carries a bundle exactly when it proposes another head than it expects',
    );
    const payload: UploadPayload = {
      format: 1,
      source: 'upload',
      actorId: caller.actorId,
      kind: input.kind,
      runnerId: input.runnerId,
      hostRef: input.hostRef,
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      unitId: input.unitId,
      generation: input.generation,
      commandId: input.kind === 'checkpoint' ? input.commandId : null,
      expectedHead: input.expectedHead,
      tip: input.proposedHead,
      treeOid: input.treeOid,
      bundle: input.bundle,
    };
    const inputHash = digest(payload);
    const principal = `session:${input.sessionId}`;
    const fence = fenceOf({ project_id: caller.projectId }, payload);
    // An upload that is past admission is never overtaken: it is finished first.
    for (const row of await this.state.read(
      async (sql) =>
        await sql.all<OperationRow>(
          `SELECT ${columns} FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared' AND phase<>'receiving'`,
          caller.projectId,
          input.unitId,
        ),
    ))
      await this.start(row).catch(() => {});
    if (input.bundle) await this.repositories.assertRoom(caller.projectId, input.bundle.bytes);
    const superseded: OperationRow[] = [];
    const id = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const previous = await tx.get<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?`,
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === inputHash,
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return previous.id;
      }
      await this.hooks.fenced(tx, fence, input.kind);
      const open = await tx.all<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared'`,
        caller.projectId,
        input.unitId,
      );
      check(
        open.every((row) => row.phase === 'receiving'),
        'code_operation_unresolved',
        'An admitted upload of this unit is unfinished; begin again once it has completed',
        409,
      );
      const at = now();
      for (const row of open) {
        await tx.run(
          "UPDATE code_operations SET status='failed',error=?,detail_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
          Number(row.generation) === input.generation
            ? 'code_upload_superseded'
            : 'code_generation_stale',
          canonical({ message: 'A later upload of this unit began' }),
          at,
          at,
          row.id,
        );
        superseded.push(row);
      }
      const id = newId('cop');
      const insert = async (status: 'prepared' | 'completed', result: string | null) =>
        await tx.run(
          'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id,generation,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          caller.projectId,
          principal,
          requestId,
          'upload',
          inputHash,
          canonical(payload),
          status,
          result,
          at,
          status === 'completed' ? at : null,
          input.unitId,
          input.generation,
          status === 'completed' ? 'refs_applied' : 'receiving',
          canonical({ received: 0 } satisfies Progress),
          at,
        );
      if (input.bundle) {
        await this.assertReceiving(tx, caller.projectId);
        await insert('prepared', null);
      } else {
        await insert(
          'completed',
          canonical({
            head: input.proposedHead,
            tree: input.treeOid,
            receiptRef: null,
            objects: 0,
            bytes: 0,
          }),
        );
        await this.admitted(tx, id, caller.projectId, payload);
      }
      return id;
    });
    for (const row of superseded)
      await this.hold((await this.state.read((sql) => this.row(sql, row.id)))!).catch(() => {});
    return this.view((await this.state.read((sql) => this.row(sql, id)))!);
  }

  /**
   * Write exactly one commit and what the machine does not have of its history into a bundle
   * a session may read in parts. A session has one export at a time: asking again for the
   * same thing finds it, asking for another replaces it. Only commits this repository holds
   * count as haves, so a machine that claims more than it has breaks only its own import.
   */
  async export(
    caller: Caller,
    input: { sessionId: string; head: string; haves: string[] },
  ): Promise<CodeExport> {
    this.assertOpen();
    const projectId = caller.projectId;
    const env = this.repositories.environment(projectId);
    const git = this.repositories.git;
    const checked = await git.ok(['cat-file', '--batch-check'], {
      env,
      input: [...new Set(input.haves)].map((oid) => `${oid}^{commit}\n`).join(''),
    });
    const haves = checked
      .toString('utf8')
      .split('\n')
      .map((line) => /^([0-9a-f]+) commit /.exec(line)?.[1])
      .filter((oid): oid is string => !!oid)
      .sort();
    if (haves.includes(input.head)) return { upToDate: true, head: input.head };
    const exportId = `exp${createHash('sha256').update(`${projectId}\0${input.sessionId}`).digest('hex').slice(0, 32)}`;
    const key = digest({ head: input.head, haves });
    const paths = this.repositories.paths(projectId);
    const file = join(paths.exports, `${exportId}.bundle`);
    const known = this.exports.get(exportId);
    if (
      known?.key === key &&
      Date.parse(known.view.expiresAt) > Date.now() + 60_000 &&
      (await lstat(file).catch(() => null))
    )
      return known.view;
    return await this.repositories.transfer(async () => {
      await this.repositories.assertRoom(projectId, 0);
      await mkdir(paths.exports, { recursive: true, mode: 0o700 });
      await rm(file, { force: true });
      const ref = `refs/merv/exports/${exportId}`;
      await git.ok(['update-ref', ref, input.head], { env });
      const made = await git.run(
        ['bundle', 'create', file, ref, ...(haves.length ? ['--not', ...haves] : [])],
        { env, timeoutMs: FETCH_TIMEOUT_MS },
      );
      if (made.code !== 0) {
        // Git refuses an empty bundle: everything the head reaches is beneath a have.
        await rm(file, { force: true });
        await git.run(['update-ref', '-d', ref], { env });
        this.exports.delete(exportId);
        return { upToDate: true as const, head: input.head };
      }
      await chmod(file, 0o600);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      const view = {
        exportId,
        sha256: hash.digest('hex'),
        bytes: (await stat(file)).size,
        head: input.head,
        prerequisites: (await bundleHeader(file)).prerequisites,
        partBytes: this.config.partBytes,
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS).toISOString(),
      };
      this.exports.set(exportId, { key, projectId, sessionId: input.sessionId, view });
      return view;
    });
  }

  /** One part of a session's own export; nothing else under the project's directory is served. */
  async readExport(
    caller: Caller,
    exportId: string,
    input: { sessionId: string; offset: number; length: number },
  ): Promise<Buffer> {
    this.assertOpen();
    const known = this.exports.get(exportId);
    check(
      known &&
        known.projectId === caller.projectId &&
        known.sessionId === input.sessionId &&
        Date.parse(known.view.expiresAt) > Date.now(),
      'code_export_not_found',
      'No such export for this session; ask for the download again',
      404,
    );
    const handle = await open(
      join(this.repositories.paths(caller.projectId).exports, `${exportId}.bundle`),
      'r',
    ).catch(() => null);
    check(handle, 'code_export_not_found', 'This export has expired; ask for it again', 404);
    try {
      const length = Math.min(input.length, this.config.partBytes, known.view.bytes - input.offset);
      check(length > 0, 'code_upload_offset', 'The export has no bytes at that offset', 409);
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, input.offset);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** Project limits admission applies on top of the fixed ones. */
  async configure(caller: Caller, value: unknown): Promise<CodeStoreLimits> {
    this.assertOpen();
    caller = structuredClone(caller);
    const { requestId, ...body } = parseCodeInput(codeRepositoryConfigureInputSchema, value);
    const limits: CodeStoreLimits = { format: 1, ...body };
    return await this.state.transaction(async (tx) => {
      await this.administrator(caller, tx);
      check(
        await this.project(tx, caller.projectId),
        'code_project_unbound',
        'Bind this project with code.local.bind before configuring its repository',
        409,
      );
      const principal = `actor:${caller.actorId}`;
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === digest(body),
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return JSON.parse(previous.result_json) as CodeStoreLimits;
      }
      const id = newId('cop'),
        at = now();
      await tx.run(
        'UPDATE code_projects SET limits_json=?,updated_at=? WHERE project_id=?',
        canonical(limits),
        at,
        caller.projectId,
      );
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id,
        caller.projectId,
        principal,
        requestId,
        'configure',
        digest(body),
        canonical(body),
        'completed',
        canonical(limits),
        at,
        at,
      );
      await recorded(this.state, tx, caller, 'code.repository_configured', caller.projectId, {
        operationId: id,
        denyGlobs: limits.denyGlobs.length,
        secretExemptGlobs: limits.secretExemptGlobs.length,
      });
      return limits;
    });
  }

  async operation(caller: Caller, operationId: string): Promise<CodeStoreOperation> {
    this.assertOpen();
    caller = structuredClone(caller);
    return this.view(
      await this.state.transaction(async (tx) => await this.authorized(caller, operationId, tx)),
    );
  }

  /**
   * Append one part of a bundle. The file's size is what was received, so a part at that
   * offset is appended, one that lies wholly inside it is a replay, and any other is refused
   * and the sender reads where to continue. Nothing is synced here: the whole file is hashed
   * against the promised sha256 before anything reads it.
   */
  async putPart(
    caller: Caller,
    operationId: string,
    offset: number,
    bytes: Buffer,
  ): Promise<{ received: number }> {
    this.assertOpen();
    caller = structuredClone(caller);
    check(
      bytes.length > 0 && bytes.length <= this.config.partBytes,
      'code_upload_part',
      `A part carries between 1 and ${this.config.partBytes} bytes`,
      413,
    );
    const job = (this.parts.get(operationId) ?? Promise.resolve()).then(async () => {
      const row = await this.state.transaction(async (tx) => {
        const row = await this.authorized(caller, operationId, tx);
        check(
          row.status === 'prepared' && row.phase === 'receiving',
          'code_upload_closed',
          'This operation no longer receives bytes',
          409,
        );
        return row;
      });
      const declared = this.declared(row);
      check(declared !== null, 'code_upload_closed', 'This operation receives no bundle', 409);
      await this.repositories.assertRoom(row.project_id, 0);
      const directory = join(this.repositories.paths(row.project_id).quarantine, row.id);
      const file = join(directory, 'bundle.part');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const held = await stat(file).then(
        (found) => found.size,
        () => 0,
      );
      check(
        !(await lstat(join(directory, 'bundle')).catch(() => null)),
        'code_upload_closed',
        'This operation already holds its whole bundle',
        409,
      );
      let received = held;
      if (offset === held) {
        check(
          held + bytes.length <= declared,
          'code_upload_too_large',
          'These bytes exceed what the operation was promised',
          413,
        );
        const handle = await open(file, 'a', 0o600);
        try {
          await handle.write(bytes);
        } finally {
          await handle.close();
        }
        received = held + bytes.length;
      } else
        check(
          offset + bytes.length <= held,
          'code_upload_offset',
          `This operation holds ${held} bytes; send the part that starts there`,
          409,
        );
      this.fault('after_part');
      await this.state.transaction(async (tx) => {
        const current = await this.row(tx, row.id);
        if (current?.status === 'prepared' && current.phase === 'receiving')
          await this.progress(tx, current, { received });
      });
      return { received };
    });
    const settled = job.then(
      () => {},
      () => {},
    );
    this.parts.set(operationId, settled);
    void settled.then(() => {
      if (this.parts.get(operationId) === settled) this.parts.delete(operationId);
    });
    return await job.catch((error: unknown) => {
      throw refusal(error);
    });
  }

  /**
   * Ask for a received bundle to be admitted. Admission runs in the project's turn and may
   * outlast any request, so this answers with the operation as it stands after a short wait
   * and the caller asks again; asking again never starts a second admission.
   */
  async complete(caller: Caller, operationId: string): Promise<CodeStoreOperation> {
    this.assertOpen();
    caller = structuredClone(caller);
    const row = await this.state.transaction(
      async (tx) => await this.authorized(caller, operationId, tx),
    );
    if (row.status === 'prepared') await this.settle(this.start(row, caller));
    return this.view((await this.state.read((sql) => this.row(sql, row.id)))!);
  }

  /** Whether the project's repository holds this commit. */
  async contains(projectId: string, oid: string): Promise<boolean> {
    if (!(await this.repositories.exists(projectId))) return false;
    const found = await this.repositories.git.run(['cat-file', '-e', `${oid}^{commit}`], {
      env: this.repositories.environment(projectId),
    });
    return found.code === 0;
  }

  /** The repository and its operations, for a caller the project's reads already admitted. */
  async describe(
    projectId: string,
  ): Promise<{ store: CodeStoreStatus; operations: CodeStoreOperation[] }> {
    this.assertOpen();
    const read = await this.state.read(async (sql) => ({
      project: await this.project(sql, projectId),
      open: await sql.all<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND status='prepared' AND phase IS NOT NULL ORDER BY created_at,id LIMIT 100`,
        projectId,
      ),
      failed: await sql.all<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND status='failed' AND phase IS NOT NULL ORDER BY completed_at DESC,id LIMIT 10`,
        projectId,
      ),
      imports: await sql.all<{ result_json: string }>(
        "SELECT result_json FROM code_operations WHERE project_id=? AND kind='import' AND status='completed' ORDER BY completed_at DESC,id LIMIT 50",
        projectId,
      ),
    }));
    const stored = read.project?.store_json
      ? (JSON.parse(read.project.store_json) as {
          objectFormat: ObjectFormat;
          rootOid: string;
          source: 'bundle' | 'github';
        })
      : null;
    return {
      store: {
        hosted: stored !== null,
        objectFormat: stored?.objectFormat ?? null,
        rootOid: stored?.rootOid ?? null,
        source: stored?.source ?? null,
        tips: read.imports.map((row) => (JSON.parse(row.result_json) as { head: string }).head),
        diskBytes: await this.repositories.usage(projectId),
        quotaBytes: this.config.quotaBytes,
        limits: this.limits(read.project),
      },
      operations: [...read.open, ...read.failed].map((row) => this.view(row)),
    };
  }

  /**
   * Take up every operation an earlier process left between two steps, give up transfers
   * nobody continues, and sweep. One that still cannot finish says why on its row; it never
   * keeps Code from starting.
   */
  async maintain(sweep = true): Promise<void> {
    if (this.closed) return;
    this.maintaining ??= (async () => {
      try {
        await this.hooks.maintained?.();
        const rows = await this.state.read(
          async (sql) =>
            await sql.all<OperationRow>(
              `SELECT ${columns} FROM code_operations WHERE status='prepared' AND phase IS NOT NULL ORDER BY created_at,id`,
            ),
        );
        const stale = new Date(Date.now() - this.config.abandonSeconds * 1000).toISOString();
        for (const row of rows) {
          if (!kinds.includes(row.kind)) continue;
          if (journalled.includes(row.phase!)) await this.start(row).catch(() => {});
          else if (row.kind === 'upload' && !this.jobs.has(row.id) && (await this.stale(row)))
            await this.repositories
              .run(row.project_id, () => this.fail(row, 'code_generation_stale', null))
              .catch(() => {});
          else if ((row.updated_at ?? row.created_at) < stale && !this.jobs.has(row.id))
            await this.repositories
              .run(row.project_id, () => this.fail(row, 'code_upload_abandoned', null))
              .catch(() => {});
        }
        if (!sweep) return;
        await this.repositories.sweep(async (operationId) => {
          const row = await this.state.read((sql) => this.row(sql, operationId));
          if (!row) return undefined;
          if (row.status === 'prepared') return false;
          await this.hold(row);
          return true;
        });
      } finally {
        this.maintaining = undefined;
      }
    })();
    await this.maintaining;
  }

  /**
   * Something was journalled inside another plugin's transaction. It is taken up by a timer
   * that was started outside every transaction, because work scheduled from inside one would
   * inherit it; by the time the timer looks, that transaction has committed or is gone.
   */
  wake(): void {
    this.woken = true;
  }

  /** Stop the timer, let running operations finish or end them at the deadline, release the lock. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.waker);
    await this.maintaining?.catch(() => {});
    await Promise.allSettled([...this.parts.values()]);
    await this.repositories.close(this.config.drainSeconds * 1000);
    await Promise.allSettled([...this.jobs.values()]);
  }

  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }

  private async administrator(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'admin', tx);
    check(
      !caller.session,
      'session_forbidden',
      'A leased worker cannot change the project’s repository',
      403,
    );
  }

  /**
   * Every later call on an operation is made by whoever began it. The row pins that
   * principal; its authority in the project is read again each time, because a transfer can
   * outlive it.
   */
  private async authorized(
    caller: Caller,
    operationId: string,
    tx: Transaction,
  ): Promise<OperationRow> {
    const row = await this.row(tx, operationId);
    check(
      row && row.project_id === caller.projectId && row.phase !== null,
      'code_operation_not_found',
      'No such Code operation in this project',
      404,
    );
    const payload = JSON.parse(row.payload_json) as Payload;
    if (payload.source === 'upload') {
      await this.scope.require(caller, 'read', tx);
      check(!caller.session, 'session_forbidden', 'A leased worker cannot move bundles', 403);
    } else await this.administrator(caller, tx);
    check(
      kinds.includes(row.kind) &&
        payload.source !== 'accept-ref' &&
        payload.actorId === caller.actorId,
      'code_operation_forbidden',
      'Only the principal that began this operation continues it',
      403,
    );
    // A transfer can outlive the generation it was begun for; one still receiving ends here.
    if (payload.source === 'upload' && row.status === 'prepared' && row.phase === 'receiving')
      await this.hooks.fenced(tx, fenceOf(row, payload), payload.kind);
    return row;
  }

  private async assertReceiving(tx: Transaction, projectId: string): Promise<void> {
    const open = await tx.get<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM code_operations WHERE project_id=? AND status='prepared' AND phase='receiving'",
      projectId,
    );
    check(
      Number(open?.count ?? 0) < this.config.receiving,
      'code_store_unavailable',
      'This project already has as many open transfers as it may; complete or wait for them',
      503,
    );
  }

  private async row(sql: Sql, id: string): Promise<OperationRow | undefined> {
    return await sql.get<OperationRow>(`SELECT ${columns} FROM code_operations WHERE id=?`, id);
  }

  private async project(sql: Sql, projectId: string): Promise<ProjectRow | undefined> {
    return await sql.get<ProjectRow>(
      'SELECT repository_id,main_json,limits_json,store_json FROM code_projects WHERE project_id=?',
      projectId,
    );
  }

  private limits(project: ProjectRow | undefined): CodeStoreLimits {
    const stored = JSON.parse(project?.limits_json ?? '{}') as Partial<CodeStoreLimits>;
    return {
      format: 1,
      denyGlobs: stored.denyGlobs ?? [],
      secretExemptGlobs: stored.secretExemptGlobs ?? [],
    };
  }

  private declared(row: OperationRow): number | null {
    const payload = JSON.parse(row.payload_json) as Payload;
    return payload.source === 'bundle' || payload.source === 'upload'
      ? (payload.bundle?.bytes ?? null)
      : null;
  }

  private async progress(tx: Transaction, row: OperationRow, change: Partial<Progress>) {
    const merged = { ...(JSON.parse(row.progress_json ?? '{}') as Progress), ...change };
    await tx.run(
      "UPDATE code_operations SET progress_json=?,updated_at=? WHERE id=? AND status='prepared'",
      canonical(merged),
      now(),
      row.id,
    );
    return merged;
  }

  private view(row: OperationRow): CodeStoreOperation {
    const payload = JSON.parse(row.payload_json) as { tip?: string };
    const progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    const detail = JSON.parse(row.detail_json ?? '{}') as { findings?: CodeFinding[] };
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
      error: row.error,
      findings: detail.findings ?? [],
      waiting: row.status === 'prepared' ? (progress.waiting ?? null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      completedAt: row.completed_at,
    };
  }

  /** One admission at a time for an operation, in its project's turn. */
  private start(row: OperationRow, caller?: Caller): Promise<void> {
    let job = this.jobs.get(row.id);
    if (!job) {
      job = this.repositories
        .run(row.project_id, () => this.advance(row.id, caller))
        .catch(async (failure: unknown) => {
          const error = refusal(failure);
          await this.stalled(row.id, error).catch(() => {});
          throw error;
        })
        .finally(() => this.jobs.delete(row.id));
      this.jobs.set(row.id, job);
      job.catch(() => {});
    }
    return job;
  }

  /** Wait a little for a job: its refusal is the caller's answer, its slowness is not an error. */
  private async settle(job: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        job,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.config.settleMs))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Say on the row why an unfinished operation stopped, and what would move it. */
  private async stalled(id: string, error: unknown): Promise<void> {
    const code = this.closed
      ? 'code_drain_pending'
      : error instanceof MervError
        ? error.code
        : 'internal_error';
    await this.state.transaction(async (tx) => {
      const row = await this.row(tx, id);
      if (row?.status === 'prepared')
        await this.progress(tx, row, {
          waiting: {
            code,
            message:
              code === 'code_drain_pending'
                ? 'Code was unloaded while this operation ran'
                : error instanceof MervError
                  ? error.message
                  : 'The operation stopped unexpectedly',
            next: next[code] ?? resume,
            at: now(),
          },
        });
    });
  }

  /**
   * Walk one operation as far as it goes. Every step first reads where the row stands, so
   * the same code serves a first run, a repeated completion and a start after a crash.
   */
  private async advance(id: string, caller?: Caller): Promise<void> {
    let row = await this.state.read((sql) => this.row(sql, id));
    if (!row || row.status !== 'prepared') return;
    const payload = JSON.parse(row.payload_json) as Payload;
    const upload = payload.source === 'upload' ? payload : null;
    const project = (await this.state.read((sql) => this.project(sql, row!.project_id)))!;
    const paths = this.repositories.paths(row.project_id);
    const directory = join(paths.quarantine, row.id);
    const env = this.repositories.environment(row.project_id);
    let progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    const examine = async (target: string) => {
      try {
        const header = await bundleHeader(join(directory, 'bundle'));
        await this.repository(row!, project, header.objectFormat);
        return await this.repositories.transfer(
          async () =>
            await admit({
              git: this.repositories.git,
              repository: paths.repository,
              quarantine: directory,
              bundle: join(directory, 'bundle'),
              head: target,
              expectedHead: upload?.expectedHead ?? null,
              prerequisites: upload ? [upload.expectedHead] : 'admitted',
              limits: { ...this.config.limits, ...this.limits(project) },
              indexed: () => this.fault('after_index'),
            }),
        );
      } catch (error) {
        if (
          error instanceof AdmissionRejected ||
          (error instanceof MervError && error.code === 'code_bundle_format')
        ) {
          await this.fail(row!, error.code, null, error.message);
          return null;
        }
        throw error;
      }
    };
    const refused = async (findings: CodeFinding[]) => {
      if (!findings.length) return false;
      await this.fail(row!, upload ? 'code_capture_quarantined' : 'code_import_rejected', findings);
      return true;
    };

    if (row.phase === 'receiving') {
      await this.repositories.assertRoom(row.project_id, 0);
      check(payload.source !== 'accept-ref', 'code_operation_changed', 'Nothing to receive', 409);
      const target =
        payload.source === 'github'
          ? await this.fetched(row, payload, project, directory, caller)
          : await this.received(row, { tip: payload.tip, bundle: payload.bundle! }, directory);
      if (target === null) return;
      const admission = await examine(target.oid);
      if (!admission || (await refused(admission.findings))) return;
      const admitted: Partial<Progress> = {
        expectedOld: null,
        target: target.oid,
        receiptRef: upload ? `refs/merv/receipts/${row.id}` : `refs/merv/imports/${row.id}`,
        tree: admission.tree,
        objects: admission.objects,
        bytes: admission.bytes,
        objectFormat: admission.objectFormat,
        ...(target.github ? { github: target.github } : {}),
        waiting: null,
      };
      try {
        progress = await this.state.transaction(async (tx) => {
          const current = await this.row(tx, id);
          check(
            current?.status === 'prepared' && current.phase === 'receiving',
            'code_operation_changed',
            'The operation changed while it was admitted',
            409,
          );
          // From here the generation cannot change, so the fence is asked one last time and
          // the branch's present value is written down as the only one this update replaces.
          if (upload) {
            const unit = (await this.hooks.fenced(tx, fenceOf(current, upload), upload.kind)) as {
              head_oid: string | null;
            };
            admitted.expectedOld = unit.head_oid;
          }
          await tx.run("UPDATE code_operations SET phase='admitting' WHERE id=?", id);
          return await this.progress(tx, current, admitted);
        });
      } catch (error) {
        if (!(error instanceof MervError) || !fenceRefusals.includes(error.code)) throw error;
        await this.fail(row, error.code, null, error.message);
        return;
      }
      this.fault('after_admitting');
    } else if (row.phase === 'admitting') {
      // The quarantine may be half written; it is rebuilt from the retained bundle.
      const admission = await examine(progress.target!);
      if (!admission || (await refused(admission.findings))) return;
    }
    row = (await this.state.read((sql) => this.row(sql, id)))!;
    if (row.phase === 'admitting') {
      await this.migrate(directory, paths.repository);
      this.fault('after_migrate');
      await this.phase(id, 'admitting', 'objects_durable');
      this.fault('after_objects_durable');
      row.phase = 'objects_durable';
    }
    if (row.phase === 'objects_durable') {
      const receipt = async () => {
        const found = await this.repositories.git.run(
          ['rev-parse', '--verify', '--quiet', `${progress.receiptRef}^{commit}`],
          { env },
        );
        return found.code === 0 ? found.stdout.toString('utf8').trim() : null;
      };
      let applied = await receipt();
      if (applied === null) {
        const zero = '0'.repeat(progress.target!.length);
        await this.repositories.git.run(['update-ref', '--stdin'], {
          env,
          input: [
            'start',
            ...(upload
              ? [
                  `update ${workRef(upload.unitId)} ${progress.target} ${progress.expectedOld ?? zero}`,
                ]
              : []),
            `create ${progress.receiptRef} ${progress.target}`,
            'prepare',
            'commit',
            '',
          ].join('\n'),
        });
        applied = await receipt();
      }
      // The receipt is the proof. One that names another commit was not written by this
      // operation, and recovery never invents a target.
      check(
        applied === progress.target,
        'code_recovery_required',
        `${progress.receiptRef} does not hold the commit this operation writes`,
        409,
      );
      this.fault('after_ref');
      await this.phase(id, 'objects_durable', 'refs_applied');
      this.fault('after_refs_applied');
      row.phase = 'refs_applied';
    }
    if (row.phase === 'refs_applied') {
      const main = (JSON.parse(project.main_json) as { oid: string }).oid;
      const mainStored = await this.contains(row.project_id, main);
      await this.state.transaction(async (tx) => {
        const current = await this.row(tx, id);
        if (current?.status !== 'prepared') return;
        const at = now();
        await tx.run(
          "UPDATE code_operations SET status='completed',result_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
          canonical(
            payload.source === 'accept-ref'
              ? { head: progress.target, receiptRef: progress.receiptRef }
              : {
                  head: progress.target,
                  tree: progress.tree,
                  receiptRef: progress.receiptRef,
                  objects: progress.objects,
                  bytes: progress.bytes,
                },
          ),
          at,
          at,
          id,
        );
        if (payload.source === 'accept-ref') return;
        if (upload) return await this.admitted(tx, id, row!.project_id, upload);
        await tx.run(
          'UPDATE code_projects SET store_json=?,updated_at=? WHERE project_id=? AND store_json IS NULL',
          canonical({
            format: 1,
            objectFormat: progress.objectFormat,
            rootOid: progress.target,
            source: payload.source,
            githubRepositoryId: progress.github?.id ?? null,
            importedBy: payload.actorId,
            importedAt: at,
            operationId: id,
          }),
          at,
          row!.project_id,
        );
        const bound = (await this.project(tx, row!.project_id))!;
        const named = JSON.parse(bound.main_json) as { oid: string; stored?: boolean };
        if (mainStored && named.oid === main && !named.stored)
          await tx.run(
            'UPDATE code_projects SET main_json=? WHERE project_id=?',
            canonical({ ...named, stored: true }),
            row!.project_id,
          );
        await this.state.appendEvent(tx, {
          projectId: row!.project_id,
          actorId: payload.actorId,
          type: 'code.repository_imported',
          subjectId: row!.project_id,
          data: { operationId: id, head: progress.target!, source: payload.source },
        });
        await this.hooks.imported(tx, row!.project_id);
      });
      this.fault('before_ack');
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** What the database learns when an upload is durable: the branch moved, and who moved it. */
  private async admitted(
    tx: Transaction,
    id: string,
    projectId: string,
    payload: UploadPayload,
  ): Promise<void> {
    const final = payload.kind === 'final';
    await this.hooks.advanced(tx, fenceOf({ project_id: projectId }, payload), {
      head: payload.tip,
      operationId: id,
      final,
    });
    await this.state.appendEvent(tx, {
      projectId,
      actorId: payload.actorId,
      type: 'code.capture_admitted',
      subjectId: payload.unitId,
      data: {
        operationId: id,
        unitId: payload.unitId,
        generation: payload.generation,
        sessionId: payload.sessionId,
        head: payload.tip,
        final,
      },
    });
  }

  /** Whether the writer generation an upload was begun for is no longer the unit's. */
  private async stale(row: OperationRow): Promise<boolean> {
    const payload = JSON.parse(row.payload_json) as UploadPayload;
    try {
      await this.state.transaction(
        async (tx) => await this.hooks.fenced(tx, fenceOf(row, payload), payload.kind),
      );
      return false;
    } catch (error) {
      // Any other refusal leaves the row to whoever continues or supersedes it.
      if (error instanceof MervError) return error.code === 'code_generation_stale';
      throw error;
    }
  }

  private async phase(id: string, from: string, to: string): Promise<void> {
    await this.state.transaction(async (tx) => {
      const changed = await tx.run(
        "UPDATE code_operations SET phase=?,updated_at=? WHERE id=? AND status='prepared' AND phase=?",
        to,
        now(),
        id,
        from,
      );
      check(
        changed.changes === 1,
        'code_operation_changed',
        'The operation changed while it was applied',
        409,
      );
    });
  }

  /** Create or check the project's repository for a bundle of this object format. */
  private async repository(row: OperationRow, project: ProjectRow, format: ObjectFormat) {
    const projectId = row.project_id;
    if (
      !project.store_json &&
      (await this.repositories.exists(projectId)) &&
      (await this.repositories.objectFormat(projectId)) !== format
    ) {
      // Nothing was ever admitted, so a repository made for an import that was then refused
      // is not worth keeping in the wrong format, unless another import is mid-way into it.
      const other = await this.state.read(
        async (sql) =>
          await sql.get(
            `SELECT id FROM code_operations WHERE project_id=? AND id<>? AND status='prepared' AND phase IN ('admitting','objects_durable','refs_applied')`,
            projectId,
            row.id,
          ),
      );
      if (!other) await this.repositories.discard(projectId);
    }
    await this.repositories.ensure(projectId, project.repository_id, format);
  }

  /** Check the received file against what was promised, and keep it as the retained bundle. */
  private async received(
    row: OperationRow,
    payload: { tip: string; bundle: Bundle },
    directory: string,
  ): Promise<{ oid: string; github?: undefined } | null> {
    const part = join(directory, 'bundle.part'),
      bundle = join(directory, 'bundle');
    if (await lstat(bundle).catch(() => null)) return { oid: payload.tip };
    const held = await stat(part).then(
      (found) => found.size,
      () => 0,
    );
    check(
      held === payload.bundle.bytes,
      'code_upload_incomplete',
      `This operation holds ${held} of ${payload.bundle.bytes} bytes`,
      409,
    );
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== payload.bundle.sha256) {
      await rm(part, { force: true });
      await this.state.transaction(async (tx) => {
        const current = await this.row(tx, row.id);
        if (current?.status === 'prepared') await this.progress(tx, current, { received: 0 });
      });
      throw new MervError(
        'code_bundle_hash_mismatch',
        'The received bytes do not have the promised sha256; they were dropped, send them again',
        409,
      );
    }
    // The retained bundle is what a start after a crash admits again, so it must be on disk.
    const handle = await open(part, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(part, bundle);
    await syncDirectory(directory);
    return { oid: payload.tip };
  }

  /**
   * Read one ref of the linked GitHub repository into this operation's quarantine and turn
   * what arrived into a bundle, which then takes exactly the path an uploaded one takes. The
   * project's repository is only ever borrowed from: no ref, FETCH_HEAD or tag is written to
   * it, and a fetch that grows past the transfer limit is ended.
   */
  private async fetched(
    row: OperationRow,
    payload: Extract<ImportPayload, { source: 'github' }>,
    project: ProjectRow,
    directory: string,
    caller: Caller | undefined,
  ): Promise<{ oid: string; github: { id: number; fullName: string } } | null> {
    const progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    const bundle = join(directory, 'bundle');
    if (progress.target && progress.github && (await lstat(bundle).catch(() => null)))
      return { oid: progress.target, github: progress.github };
    if (!caller || !this.remote)
      throw new MervError(
        'code_import_interrupted',
        'Reading GitHub stopped before the history arrived',
        409,
      );
    const git = this.repositories.git;
    const paths = this.repositories.paths(row.project_id);
    await this.repository(row, project, 'sha1');
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, 'objects'), { recursive: true, mode: 0o700 });
    const scratch = join(directory, 'scratch.git');
    await git.ok([
      'init',
      '--quiet',
      '--bare',
      `--template=${join(this.config.root, 'empty-template')}`,
      scratch,
    ]);
    const env = {
      GIT_DIR: scratch,
      GIT_OBJECT_DIRECTORY: join(directory, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(paths.repository, 'objects'),
    };
    const result = await this.repositories.transfer(
      async () =>
        await this.remote!.read(caller, async (target) => {
          const stop = new AbortController();
          const watch = setInterval(() => {
            void diskBytes(directory).then((bytes) => {
              if (bytes > CODE_BUNDLE_MAX_BYTES) stop.abort();
            });
          }, 1000);
          try {
            const fetch = await git
              .run(
                [
                  '-c',
                  'http.followRedirects=false',
                  '-c',
                  'fetch.fsckObjects=true',
                  '-c',
                  'fetch.unpackLimit=1',
                  '-c',
                  'gc.auto=0',
                  'fetch',
                  '--quiet',
                  '--no-tags',
                  '--no-write-fetch-head',
                  '--no-recurse-submodules',
                  target.url,
                  `+${payload.ref}:refs/merv/fetched`,
                ],
                {
                  env: { ...target.env, ...env },
                  protocol: target.protocol,
                  timeoutMs: FETCH_TIMEOUT_MS,
                  signal: stop.signal,
                },
              )
              .catch((error: unknown) => {
                if (error instanceof MervError && error.code === 'code_git_aborted') return null;
                throw error;
              });
            return { fetch, repository: target.repository };
          } finally {
            clearInterval(watch);
          }
        }),
    );
    if (!result.fetch || result.fetch.code !== 0) {
      await this.fail(
        row,
        result.fetch ? 'code_import_fetch_failed' : 'code_import_too_large',
        null,
        result.fetch
          ? 'GitHub did not deliver that ref'
          : 'The history is larger than one transfer may be; import it in steps with code-import',
      );
      return null;
    }
    const oid = (await git.ok(['rev-parse', '--verify', 'refs/merv/fetched^{commit}'], { env }))
      .toString('utf8')
      .trim();
    const tips = (
      await git.ok(['for-each-ref', '--format=%(objectname)', '--count=50', 'refs/merv/imports'], {
        env: this.repositories.environment(row.project_id),
      })
    )
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    const part = join(directory, 'bundle.part');
    const made = await git.run(
      ['bundle', 'create', part, 'refs/merv/fetched', ...(tips.length ? ['--not', ...tips] : [])],
      { env, timeoutMs: FETCH_TIMEOUT_MS },
    );
    const size = await stat(part).then(
      (found) => found.size,
      () => 0,
    );
    if (made.code !== 0 || size > CODE_BUNDLE_MAX_BYTES) {
      await this.fail(
        row,
        made.code !== 0 ? 'code_import_current' : 'code_import_too_large',
        null,
        made.code !== 0
          ? 'The repository already holds everything that ref reaches'
          : 'The history is larger than one transfer may be; import it in steps with code-import',
      );
      return null;
    }
    const github = { id: result.repository.id, fullName: result.repository.fullName };
    await this.state.transaction(async (tx) => {
      const current = await this.row(tx, row.id);
      if (current?.status === 'prepared')
        await this.progress(tx, current, { target: oid, github, received: size });
    });
    const handle = await open(part, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rm(scratch, { recursive: true, force: true });
    await rename(part, bundle);
    await syncDirectory(directory);
    return { oid, github };
  }

  /**
   * Make the quarantined packs part of the project's repository. A hard link neither copies
   * nor can it half-arrive; the index goes last, because Git sees a pack once its index is
   * there. Each file and the directory are synced before the journal says they are durable.
   */
  private async migrate(directory: string, repository: string): Promise<void> {
    const from = join(directory, 'objects', 'pack'),
      to = join(repository, 'objects', 'pack');
    const order = ['.pack', '.rev', '.idx'];
    const names = (await readdir(from))
      .filter((name) => /^pack-[0-9a-f]+\.(?:pack|rev|idx)$/.test(name))
      .sort(
        (left, right) =>
          order.indexOf(left.slice(left.lastIndexOf('.'))) -
          order.indexOf(right.slice(right.lastIndexOf('.'))),
      );
    for (const name of names) {
      try {
        await link(join(from, name), join(to, name));
      } catch (error) {
        // A pack is named by its content, so one already there is this one.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        check(
          (await stat(join(to, name))).size === (await stat(join(from, name))).size,
          'code_recovery_required',
          `${name} is already in the repository with other content`,
          409,
        );
      }
      const handle = await open(join(to, name), 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await syncDirectory(to);
  }

  /** End an operation without admitting anything. Findings keep their bundle for an operator. */
  private async fail(
    row: OperationRow,
    error: string,
    findings: CodeFinding[] | null,
    message?: string,
  ): Promise<void> {
    const payload = JSON.parse(row.payload_json) as Payload;
    const upload = payload.source === 'upload' ? payload : null;
    await this.state.transaction(async (tx) => {
      const at = now();
      const changed = await tx.run(
        "UPDATE code_operations SET status='failed',error=?,detail_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
        error,
        canonical(findings ? { findings } : { message: message ?? null }),
        at,
        at,
        row.id,
      );
      if (!changed.changes) return;
      // Findings in a final capture leave work nobody can hand over again: the unit waits.
      if (upload?.kind === 'final' && findings)
        await this.hooks.quarantined(tx, fenceOf(row, upload), row.id);
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: payload.actorId,
        type: !upload
          ? 'code.import_rejected'
          : findings
            ? 'code.capture_quarantined'
            : 'code.upload_rejected',
        subjectId: upload?.unitId ?? row.project_id,
        data: { operationId: row.id, error, findings: findings?.length ?? 0 },
      });
    });
    await this.hold((await this.state.read((sql) => this.row(sql, row.id)))!);
  }

  /**
   * Settle the files of a finished operation. A bundle admission found something in is moved
   * where no route serves it, for an operator to read from the disk; the oldest held bundles
   * make room, so refused transfers cannot fill the volume. Everything else is removed.
   */
  private async hold(row: OperationRow): Promise<void> {
    const paths = this.repositories.paths(row.project_id);
    const directory = join(paths.quarantine, row.id);
    const bundle = join(directory, 'bundle');
    const part = join(directory, 'bundle.part');
    // What a fenced generation left is kept too: it may be the only copy of that work.
    if (row.error === 'code_generation_stale' && (await lstat(part).catch(() => null)))
      await rename(part, bundle);
    if (
      ['code_import_rejected', 'code_capture_quarantined', 'code_generation_stale'].includes(
        row.error ?? '',
      ) &&
      (await lstat(bundle).catch(() => null))
    ) {
      await mkdir(paths.held, { recursive: true, mode: 0o700 });
      await chmod(bundle, 0o600);
      await rename(bundle, join(paths.held, `${row.id}.bundle`));
      const held = (
        await Promise.all(
          (await readdir(paths.held)).map(async (name) => ({
            name,
            ...(await stat(join(paths.held, name))),
          })),
        )
      ).sort((left, right) => right.mtimeMs - left.mtimeMs);
      let bytes = 0;
      for (const [index, file] of held.entries()) {
        bytes += file.size;
        if (index && (index >= this.config.heldBundles || bytes > this.config.heldBytes))
          await rm(join(paths.held, file.name), { force: true });
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
