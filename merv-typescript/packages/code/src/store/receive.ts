import { OperationJournal } from '../request-journal.js';
import {
  canonical,
  check,
  digest,
  MervError,
  newId,
  now,
  type Caller,
  type Sql,
  type SessionWorkspace,
  type Transaction,
} from '@merv/contracts';
import {
  CODE_BUNDLE_MAX_BYTES,
  codeRepositoryImportInputSchema,
  type CodeFinding,
  type CodeRepositoryImportInput,
  type CodeStoreOperation,
  type CodeUpload,
} from './protocol.js';
import { appendFile, chmod, link, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile, syncPath } from '../files.js';
import { pendingMerge, verifyResolution } from '../pending-merge.js';
import { parseCodeInput } from '../input.js';
import type { WriterFence } from '../writers.js';
import { admit, AdmissionRejected, bundleHeader } from './admission.js';
import { enqueueMirror } from './mirror.js';
import { workRef } from './refs.js';
import { diffStats } from '../driver/git.js';
import { diskBytes, type ObjectFormat } from './repository.js';
import {
  columns,
  FETCH_TIMEOUT_MS,
  kinds,
  serial,
  type Bundle,
  type ImportPayload,
  type OperationRow,
  type Payload,
  type Progress,
  type ProjectRow,
  type RebindPayload,
  type StoreCore,
  type UploadPayload,
} from './core.js';

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

const next: Record<string, string> = {
  code_store_full:
    'Free space on the Code volume or raise the project’s quota, then complete the operation again.',
  code_recovery_required:
    'An operator inspects the named ref in the project’s repository: it holds neither the value this operation expected nor the one it writes, and Code will not choose for them.',
  code_drain_pending: 'Nothing: the operation is journalled and the next start of Code replays it.',
  code_git_failed:
    'Read what Git said on this operation: the project’s repository on the Code volume could not take the step it names, and the operation replays once it can.',
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
 * Receiving and admitting what an import or an upload sends, and walking each operation through
 * the journal's phases. Downloads (export.ts) and rebinding (rebind.ts) work on the same
 * StoreCore beside it, and `CodeStore` composes all three with the journal's lifecycle
 * (operations.ts).
 */
export class CodeReceiver {
  readonly jobs = new Map<string, Promise<void>>();
  readonly parts = new Map<string, Promise<void>>();
  constructor(private readonly core: StoreCore) {}

  async importRepository(caller: Caller, value: unknown): Promise<CodeStoreOperation> {
    this.core.assertOpen();
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
        : {
            format: 1,
            actorId: caller.actorId,
            source: 'github',
            ref: input.ref!,
            ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
            ...(input.githubBinding ? { githubBinding: input.githubBinding } : {}),
          };
    const inputHash = digest(body);
    const principal = `actor:${caller.actorId}`;
    const begin = async (insert: boolean) =>
      await this.core.state.transaction(async (tx) => {
        await this.core.administrator(caller, tx);
        check(
          await this.core.project(tx, caller.projectId),
          'code_project_unbound',
          'Bind this project with code.local.bind before importing its repository',
          409,
        );
        const journal = new OperationJournal(tx, caller.projectId, principal, requestId, inputHash);
        const previous = await journal.previous<OperationRow>(columns);
        if (previous || !insert) return previous;
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
        return (await this.core.row(tx, id))!;
      });
    let row = await begin(false);
    if (!row) {
      await this.core.repositories.assertRoom(
        caller.projectId,
        payload.source === 'bundle' ? payload.bundle.bytes : 0,
      );
      row = (await begin(true))!;
    }
    // GitHub is read as the administrator who asked, so only their own call can start it.
    if (input.source === 'github' && row.status === 'prepared')
      await this.settle(this.start(row, caller));
    return this.core.view((await this.core.state.read((sql) => this.core.row(sql, row.id)))!);
  }

  /** Whether the project's repository holds this commit. */
  async contains(projectId: string, oid: string): Promise<boolean> {
    return !(await this.core.owned(() => this.core.absent(projectId, [oid]))).size;
  }

  /** How far `head` is from `base` in the project's repository, as a workspace snapshot says. */
  async stats(projectId: string, base: string, head: string): Promise<SessionWorkspace['stats']> {
    return await this.core.owned(() =>
      diffStats(
        async (args) =>
          // A commit the repository does not hold fails rather than counting as no change.
          (
            await this.core.repositories.git.ok(args, {
              env: this.core.repositories.environment(projectId),
            })
          ).toString('utf8'),
        base,
        head,
      ),
    );
  }

  /**
   * Begin the upload of one commit or of the final capture of a unit, under its writer fence.
   * The caller has already shown that the session is theirs and runs on the machine they
   * name. An upload that moves nothing completes here; one that carries a bundle first ends
   * every transfer of the unit that was only receiving, because nobody will complete it.
   */
  async beginUpload(caller: Caller, input: CodeUpload): Promise<CodeStoreOperation> {
    this.core.assertOpen();
    caller = structuredClone(caller);
    await this.core.managedRead(caller, input.sessionId);
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
    for (const row of await this.core.state.read(
      async (sql) =>
        await sql.all<OperationRow>(
          `SELECT ${columns} FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared' AND phase<>'receiving'`,
          caller.projectId,
          input.unitId,
        ),
    ))
      await this.start(row).catch(() => {});
    const journal = (sql: Sql) =>
      new OperationJournal(sql, caller.projectId, principal, requestId, inputHash);
    // A replayed begin takes no more room: its bytes already count.
    if (input.bundle && !(await this.core.state.read((sql) => journal(sql).previous())))
      await this.core.repositories.assertRoom(caller.projectId, input.bundle.bytes);
    const superseded: OperationRow[] = [];
    const id = await this.core.state.transaction(async (tx) => {
      await this.core.scope.require(caller, 'read', tx);
      this.core.managedSession(caller, input.sessionId);
      const previous = await journal(tx).previous<OperationRow>(columns);
      if (previous) return previous.id;
      await this.core.hooks.fenced(tx, fence, input.kind);
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
            ...(await this.mergeReceipt(tx, caller.projectId, input.unitId)),
          }),
        );
        await this.admitted(tx, id, caller.projectId, payload);
      }
      return id;
    });
    for (const row of superseded)
      await this.hold((await this.core.state.read((sql) => this.core.row(sql, row.id)))!).catch(
        () => {},
      );
    return this.core.view((await this.core.state.read((sql) => this.core.row(sql, id)))!);
  }

  async operation(caller: Caller, operationId: string): Promise<CodeStoreOperation> {
    this.core.assertOpen();
    caller = structuredClone(caller);
    return this.core.view(
      await this.core.state.transaction(
        async (tx) => await this.authorized(caller, operationId, tx),
      ),
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
    this.core.assertOpen();
    caller = structuredClone(caller);
    check(
      bytes.length > 0 && bytes.length <= this.core.config.partBytes,
      'code_upload_part',
      `A part carries between 1 and ${this.core.config.partBytes} bytes`,
      413,
    );
    const job = serial(this.parts, operationId, async () => {
      const row = await this.core.state.transaction(async (tx) => {
        const row = await this.authorized(caller, operationId, tx);
        check(
          row.status === 'prepared' && row.phase === 'receiving',
          'code_upload_closed',
          'This operation no longer receives bytes',
          409,
        );
        return row;
      });
      const declared = this.core.declared(row);
      check(declared !== null, 'code_upload_closed', 'This operation receives no bundle', 409);
      await this.core.repositories.assertRoom(row.project_id, 0);
      const directory = join(this.core.repositories.paths(row.project_id).quarantine, row.id);
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
        await appendFile(file, bytes, { mode: 0o600 });
        received = held + bytes.length;
      } else
        check(
          offset + bytes.length <= held,
          'code_upload_offset',
          `This operation holds ${held} bytes; send the part that starts there`,
          409,
        );
      this.core.fault('after_part');
      await this.core.state.transaction(async (tx) => {
        const current = await this.core.row(tx, row.id);
        if (current?.status === 'prepared' && current.phase === 'receiving')
          await this.progress(tx, current, { received });
      });
      return { received };
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
    this.core.assertOpen();
    caller = structuredClone(caller);
    const row = await this.core.state.transaction(
      async (tx) => await this.authorized(caller, operationId, tx),
    );
    if (row.status === 'prepared') await this.settle(this.start(row, caller));
    return this.core.view((await this.core.state.read((sql) => this.core.row(sql, row.id)))!);
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
    const row = await this.core.row(tx, operationId);
    check(
      row && row.project_id === caller.projectId && row.phase !== null,
      'code_operation_not_found',
      'No such Code operation in this project',
      404,
    );
    const payload = JSON.parse(row.payload_json) as Payload;
    if (payload.source === 'upload') {
      await this.core.scope.require(caller, 'read', tx);
      this.core.managedSession(caller, payload.sessionId);
      check(!caller.session, 'session_forbidden', 'A leased worker cannot move bundles', 403);
    } else await this.core.administrator(caller, tx);
    check(
      kinds.includes(row.kind) &&
        payload.source !== 'retain-ref' &&
        payload.actorId === caller.actorId,
      'code_operation_forbidden',
      'Only the principal that began this operation continues it',
      403,
    );
    // A transfer can outlive the generation it was begun for; one still receiving ends here.
    if (payload.source === 'upload' && row.status === 'prepared' && row.phase === 'receiving')
      await this.core.hooks.fenced(tx, fenceOf(row, payload), payload.kind);
    return row;
  }

  private async assertReceiving(tx: Transaction, projectId: string): Promise<void> {
    const open = await tx.get<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM code_operations WHERE project_id=? AND status='prepared' AND phase='receiving'",
      projectId,
    );
    check(
      Number(open?.count ?? 0) < this.core.config.receiving,
      'code_store_unavailable',
      'This project already has as many open transfers as it may; complete or wait for them',
      503,
    );
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

  /** One admission at a time for an operation, in its project's turn. */
  start(row: OperationRow, caller?: Caller): Promise<void> {
    let job = this.jobs.get(row.id);
    if (!job) {
      job = this.core
        .owned(() => this.core.repositories.run(row.project_id, () => this.advance(row.id, caller)))
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
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.core.config.settleMs))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Say on the row why an unfinished operation stopped, and what would move it. */
  private async stalled(id: string, error: unknown): Promise<void> {
    const code = this.core.closed
      ? 'code_drain_pending'
      : error instanceof MervError
        ? error.code
        : 'internal_error';
    await this.core.state.transaction(async (tx) => {
      const row = await this.core.row(tx, id);
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
    let row = await this.core.state.read((sql) => this.core.row(sql, id));
    if (!row || row.status !== 'prepared') return;
    // A rebind moves no object and is never journalled through these phases: it finishes in the
    // call that asked for it, and the sweep passes over it for the same reason.
    const payload = JSON.parse(row.payload_json) as Exclude<Payload, RebindPayload>;
    const upload = payload.source === 'upload' ? payload : null;
    const project = (await this.core.state.read((sql) => this.core.project(sql, row!.project_id)))!;
    const paths = this.core.repositories.paths(row.project_id);
    const directory = join(paths.quarantine, row.id);
    const env = this.core.repositories.environment(row.project_id);
    let progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    if (payload.source === 'retain-ref')
      check(
        payload.ref === progress.receiptRef && payload.tip === progress.target,
        'code_retention_intent_changed',
        'The retained ref differs from its immutable intent',
        409,
      );

    const examine = async (target: string) => {
      try {
        const header = await bundleHeader(join(directory, 'bundle'));
        await this.repository(row!, project, header.objectFormat);
        const pending = upload
          ? await this.core.state.read((sql) => pendingMerge(sql, row!.project_id, upload.unitId))
          : null;
        const admission = await this.core.repositories.transfer(
          async () =>
            await admit({
              git: this.core.repositories.git,
              repository: paths.repository,
              quarantine: directory,
              bundle: join(directory, 'bundle'),
              head: target,
              expectedHead: upload?.expectedHead ?? null,
              prerequisites: upload
                ? [
                    upload.expectedHead,
                    ...(pending ? [pending.firstParent, pending.secondParent] : []),
                  ]
                : 'admitted',
              prerequisiteAncestors: !!pending,
              limits: { ...this.core.config.limits, ...this.core.limits(project) },
              indexed: () => this.core.fault('after_index'),
            }),
        );
        if (!pending) return { ...admission, merge: undefined };
        const verified = await verifyResolution(
          this.core.repositories.git,
          {
            ...env,
            GIT_OBJECT_DIRECTORY: join(directory, 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(paths.repository, 'objects'),
          },
          pending.firstParent,
          pending.secondParent,
          target,
        );
        if (verified.error) throw new AdmissionRejected('code_resolution_parents', verified.error);
        return {
          ...admission,
          merge: {
            plan: pending.plan,
            left: pending.firstParent,
            right: pending.secondParent,
            firstMerge: verified.firstMerge,
          },
        };
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
      await this.core.repositories.assertRoom(row.project_id, 0);
      check(payload.source !== 'retain-ref', 'code_operation_changed', 'Nothing to receive', 409);
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
        ...(admission.merge ? { merge: admission.merge } : {}),
        objects: admission.objects,
        bytes: admission.bytes,
        objectFormat: admission.objectFormat,
        ...(target.github ? { github: target.github } : {}),
        waiting: null,
      };
      const branch = upload
        ? await this.core.repositories.git.run(
            ['rev-parse', '--verify', '--quiet', workRef(upload.unitId)],
            { env },
          )
        : null;
      const branchHead = branch?.code === 0 ? branch.stdout.toString('utf8').trim() : null;
      try {
        progress = await this.core.state.transaction(async (tx) => {
          const current = await this.core.row(tx, id);
          check(
            current?.status === 'prepared' && current.phase === 'receiving',
            'code_operation_changed',
            'The operation changed while it was admitted',
            409,
          );
          // From here the generation cannot change, so the fence is asked one last time and
          // the branch's present value is written down as the only one this update replaces.
          if (upload) {
            const unit = (await this.core.hooks.fenced(
              tx,
              fenceOf(current, upload),
              upload.kind,
            )) as {
              head_oid: string | null;
              base_json: string;
            };
            // A no-op initial checkpoint records a head without creating a branch ref.
            const base = (JSON.parse(unit.base_json) as { reference: string }).reference;
            check(
              branchHead === unit.head_oid || (branchHead === null && unit.head_oid === base),
              'code_head_conflict',
              'The work ref differs from its recorded head',
              409,
            );
            admitted.expectedOld = branchHead;
          }
          await tx.run("UPDATE code_operations SET phase='admitting' WHERE id=?", id);
          return await this.progress(tx, current, admitted);
        });
      } catch (error) {
        if (!(error instanceof MervError) || !fenceRefusals.includes(error.code)) throw error;
        await this.fail(row, error.code, null, error.message);
        return;
      }
      this.core.fault('after_admitting');
    } else if (row.phase === 'admitting') {
      // The quarantine may be half written; it is rebuilt from the retained bundle.
      const admission = await examine(progress.target!);
      if (!admission || (await refused(admission.findings))) return;
    }
    row = (await this.core.state.read((sql) => this.core.row(sql, id)))!;
    if (row.phase === 'admitting') {
      await this.migrate(directory, paths.repository);
      this.core.fault('after_migrate');
      await this.phase(id, 'admitting', 'objects_durable');
      this.core.fault('after_objects_durable');
      row.phase = 'objects_durable';
    }
    if (row.phase === 'objects_durable') {
      // The intent was checked against its progress above; a retained ref never receives.
      if (payload.source === 'retain-ref')
        check(
          !(await this.core.absent(row.project_id, [progress.target!])).size,
          'code_retention_missing',
          'The retained commit must exist in Code before its ref is created',
          409,
        );

      const receipt = async () => {
        const found = await this.core.repositories.git.run(
          ['rev-parse', '--verify', '--quiet', `${progress.receiptRef}^{commit}`],
          { env },
        );
        return found.code === 0 ? found.stdout.toString('utf8').trim() : null;
      };
      let applied = await receipt();
      if (applied === null) {
        const zero = '0'.repeat(progress.target!.length);
        const refs = [...(upload ? [workRef(upload.unitId)] : []), progress.receiptRef!];
        const input = [
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
        ].join('\n');
        let result = await this.core.repositories.git.run(['update-ref', '--stdin'], {
          env,
          input,
        });
        // A Git child ended between `prepare` and `commit` leaves the lock files of exactly
        // these refs on disk, and Git refuses every replay of the transaction while they are
        // there. This operation holds its project's turn and nothing else writes these two
        // refs, so a lock still lying on them once Git has given up is that leftover.
        if (result.code !== 0 && (await this.core.clearRefLocks(paths.repository, refs)))
          result = await this.core.repositories.git.run(['update-ref', '--stdin'], { env, input });
        applied = await receipt();
        // Git's own words about a transaction that did not happen. Without them the failure
        // was read as a ref holding something unexpected, which is a different trouble with a
        // different recovery, and the message named a value the repository did not hold.
        check(
          result.code === 0 || applied === progress.target,
          'code_git_failed',
          `git update-ref failed: ${result.stderr.split('\n')[0] ?? ''}`.trim(),
          500,
        );
      }
      // The receipt is the proof. One that names another commit was not written by this
      // operation, and recovery never invents a target.
      check(
        applied === progress.target,
        'code_recovery_required',
        `${progress.receiptRef} does not hold the commit this operation writes`,
        409,
      );
      this.core.fault('after_ref');
      await this.phase(id, 'objects_durable', 'refs_applied');
      this.core.fault('after_refs_applied');
      row.phase = 'refs_applied';
    }
    if (row.phase === 'refs_applied') {
      const main = (JSON.parse(project.main_json) as { oid: string }).oid;
      const mainStored = await this.contains(row.project_id, main);
      await this.core.state.transaction(async (tx) => {
        const current = await this.core.row(tx, id);
        if (current?.status !== 'prepared') return;
        const at = now();
        await tx.run(
          "UPDATE code_operations SET status='completed',result_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
          canonical(
            payload.source === 'retain-ref'
              ? { head: progress.target, receiptRef: progress.receiptRef }
              : {
                  head: progress.target,
                  tree: progress.tree,
                  receiptRef: progress.receiptRef,
                  objects: progress.objects,
                  bytes: progress.bytes,
                  ...(progress.merge ? { merge: progress.merge } : {}),
                },
          ),
          at,
          at,
          id,
        );
        if (payload.source === 'retain-ref') {
          if (payload.mirror && payload.retentionKey)
            await enqueueMirror(
              tx,
              row!.project_id,
              'mirror-retained',
              payload.retentionKey,
              progress.target!,
              progress.receiptRef,
            );
          return;
        }
        if (upload) return await this.admitted(tx, id, row!.project_id, upload, progress.merge);
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
        const bound = (await this.core.project(tx, row!.project_id))!;
        const named = JSON.parse(bound.main_json) as { oid: string; stored?: boolean };
        if (mainStored && named.oid === main && !named.stored)
          await tx.run(
            'UPDATE code_projects SET main_json=? WHERE project_id=?',
            canonical({ ...named, stored: true }),
            row!.project_id,
          );
        await this.core.state.appendEvent(tx, {
          projectId: row!.project_id,
          actorId: payload.actorId,
          type: 'code.repository_imported',
          subjectId: row!.project_id,
          data: { operationId: id, head: progress.target!, source: payload.source },
        });
        await this.core.hooks.imported(tx, row!.project_id);
      });
      this.core.fault('before_ack');
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async mergeReceipt(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<{ merge?: Progress['merge'] }> {
    const pending = await pendingMerge(tx, projectId, unitId);
    return pending
      ? {
          merge: {
            plan: pending.plan,
            left: pending.firstParent,
            right: pending.secondParent,
            firstMerge: pending.firstMerge,
          },
        }
      : {};
  }

  /** What the database learns when an upload is durable: the branch moved, and who moved it. */
  private async admitted(
    tx: Transaction,
    id: string,
    projectId: string,
    payload: UploadPayload,
    merge?: Progress['merge'],
  ): Promise<void> {
    const pending = await pendingMerge(tx, projectId, payload.unitId);
    if (pending) {
      check(
        !payload.bundle ||
          (merge?.plan === pending.plan &&
            merge.left === pending.firstParent &&
            merge.right === pending.secondParent),
        'code_resolution_unverified',
        'The upload must verify the frozen merge plan',
        409,
      );
      const advanced = await tx.run(
        'UPDATE code_pending_merges SET head_oid=?,first_merge=? WHERE project_id=? AND unit_id=? AND head_oid=? AND plan_key=?',
        payload.tip,
        merge?.firstMerge ?? pending.firstMerge,
        projectId,
        payload.unitId,
        payload.expectedHead,
        pending.plan,
      );
      check(
        advanced.changes === 1,
        'code_resolution_checkpoint_changed',
        'The pending merge no longer names the expected checkpoint',
        409,
      );
    }
    const final = payload.kind === 'final';
    await this.core.hooks.advanced(tx, fenceOf({ project_id: projectId }, payload), {
      head: payload.tip,
      operationId: id,
      final,
    });
    // The branch is durable here, which is what a handoff needs; publishing it is the
    // server's own asynchronous work and is never on anybody's path.
    if (payload.bundle)
      await enqueueMirror(tx, projectId, 'mirror-work', payload.unitId, payload.tip);
    await this.core.state.appendEvent(tx, {
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
  async stale(row: OperationRow): Promise<boolean> {
    const payload = JSON.parse(row.payload_json) as UploadPayload;
    try {
      await this.core.state.transaction(
        async (tx) => await this.core.hooks.fenced(tx, fenceOf(row, payload), payload.kind),
      );
      return false;
    } catch (error) {
      // Any other refusal leaves the row to whoever continues or supersedes it.
      if (error instanceof MervError) return error.code === 'code_generation_stale';
      throw error;
    }
  }

  private async phase(id: string, from: string, to: string): Promise<void> {
    await this.core.state.transaction(async (tx) => {
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
      (await this.core.repositories.exists(projectId)) &&
      (await this.core.repositories.objectFormat(projectId)) !== format
    ) {
      // Nothing was ever admitted, so a repository made for an import that was then refused
      // is not worth keeping in the wrong format, unless another import is mid-way into it.
      const other = await this.core.state.read(
        async (sql) =>
          await sql.get(
            `SELECT id FROM code_operations WHERE project_id=? AND id<>? AND status='prepared' AND phase IN ('admitting','objects_durable','refs_applied')`,
            projectId,
            row.id,
          ),
      );
      if (!other) await this.core.repositories.discard(projectId);
    }
    await this.core.repositories.ensure(projectId, project.repository_id, format);
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
    if ((await hashFile(part)) !== payload.bundle.sha256) {
      await rm(part, { force: true });
      await this.core.state.transaction(async (tx) => {
        const current = await this.core.row(tx, row.id);
        if (current?.status === 'prepared') await this.progress(tx, current, { received: 0 });
      });
      throw new MervError(
        'code_bundle_hash_mismatch',
        'The received bytes do not have the promised sha256; they were dropped, send them again',
        409,
      );
    }
    // The retained bundle is what a start after a crash admits again, so it must be on disk.
    await syncPath(part);
    await rename(part, bundle);
    await syncPath(directory);
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
    if (!caller || !this.core.remote)
      throw new MervError(
        'code_import_interrupted',
        'Reading GitHub stopped before the history arrived',
        409,
      );
    const git = this.core.repositories.git;
    const paths = this.core.repositories.paths(row.project_id);
    await this.repository(row, project, 'sha1');
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, 'objects'), { recursive: true, mode: 0o700 });
    const scratch = join(directory, 'scratch.git');
    await git.ok([
      'init',
      '--quiet',
      '--bare',
      `--template=${join(this.core.config.root, 'empty-template')}`,
      scratch,
    ]);
    const env = {
      GIT_DIR: scratch,
      GIT_OBJECT_DIRECTORY: join(directory, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(paths.repository, 'objects'),
    };
    const result = await this.core.repositories.transfer(
      async () =>
        await this.core.remote!.read(
          caller,
          async (target) => {
            const stop = new AbortController();
            const watch = setInterval(() => {
              // A measurement that fails is only skipped; the next one is a second away.
              void diskBytes(directory).then(
                (bytes) => {
                  if (bytes > CODE_BUNDLE_MAX_BYTES) stop.abort();
                },
                () => {},
              );
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
                  if (
                    error instanceof MervError &&
                    error.code === 'code_git_aborted' &&
                    stop.signal.aborted &&
                    !this.core.cancellation.signal.aborted
                  )
                    return null;
                  throw error;
                });
              return { fetch, repository: target.repository };
            } finally {
              clearInterval(watch);
            }
          },
          payload.githubBinding,
        ),
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
    if (payload.expectedHead && oid !== payload.expectedHead) {
      await this.fail(
        row,
        'code_branch_changed',
        null,
        'The selected remote ref moved before it was imported',
      );
      return null;
    }
    const part = join(directory, 'bundle.part');
    // What every earlier import reached is held: the repository is the scratch's alternate.
    const made = await git.run(
      [
        '-c',
        'core.alternateRefsPrefixes=refs/merv/imports/',
        'bundle',
        'create',
        part,
        'refs/merv/fetched',
        '--not',
        '--alternate-refs',
      ],
      { env, timeoutMs: FETCH_TIMEOUT_MS },
    );
    const size = await stat(part).then(
      (found) => found.size,
      () => 0,
    );
    // Only Git's refusal to write an empty bundle means the repository already holds that
    // history. Any other failure reported as "already current" would send an administrator
    // away from the retry the import actually needs.
    if (made.code !== 0 && !/empty bundle/i.test(made.stderr)) {
      await this.fail(
        row,
        'code_import_fetch_failed',
        null,
        `git bundle failed: ${made.stderr.split('\n')[0] ?? ''}`.trim(),
      );
      return null;
    }
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
    await this.core.state.transaction(async (tx) => {
      const current = await this.core.row(tx, row.id);
      if (current?.status === 'prepared')
        await this.progress(tx, current, { target: oid, github, received: size });
    });
    await syncPath(part);
    await rm(scratch, { recursive: true, force: true });
    await rename(part, bundle);
    await syncPath(directory);
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
      await syncPath(join(to, name));
    }
    await syncPath(to);
  }

  /** End an operation without admitting anything. Findings keep their bundle for an operator. */
  async fail(
    row: OperationRow,
    error: string,
    findings: CodeFinding[] | null,
    message?: string,
  ): Promise<void> {
    const payload = JSON.parse(row.payload_json) as Payload;
    const upload = payload.source === 'upload' ? payload : null;
    await this.core.state.transaction(async (tx) => {
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
        await this.core.hooks.quarantined(tx, fenceOf(row, upload), row.id);
      await this.core.state.appendEvent(tx, {
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
    await this.hold((await this.core.state.read((sql) => this.core.row(sql, row.id)))!);
  }

  /**
   * Settle the files of a finished operation. A bundle admission found something in is moved
   * where no route serves it, for an operator to read from the disk; the oldest held bundles
   * make room, so refused transfers cannot fill the volume. Everything else is removed.
   */
  async hold(row: OperationRow): Promise<void> {
    const paths = this.core.repositories.paths(row.project_id);
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
        if (index && (index >= this.core.config.heldBundles || bytes > this.core.config.heldBytes))
          await rm(join(paths.held, file.name), { force: true });
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
