import {
  canonical,
  check,
  MervError,
  now,
  type CodePendingMerge,
  type SessionWorkspace,
  type Transaction,
} from '@merv/contracts';
import type { CodeFinding } from './protocol.js';
import { chmod, link, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile, syncPath } from '../files.js';
import { pendingMerge, verifyResolution } from '../pending-merge.js';
import type { WriterFence } from '../writers.js';
import { admit, AdmissionRejected, bundleHeader } from './admission.js';
import { workRef } from './refs.js';
import { diffStats } from '../driver/git.js';
import { diskBytes, type ObjectFormat } from './repository.js';
import {
  type Bundle,
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
    'Free space on the Code volume or raise the project’s quota, then run maintenance again.',
  code_recovery_required:
    'An operator inspects the named ref in the project’s repository: it holds neither the value this operation expected nor the one it writes, and Code will not choose for them.',
  code_drain_pending: 'Nothing: the operation is journalled and the next start of Code replays it.',
  code_git_failed:
    'Read what Git said on this operation: the project’s repository on the Code volume could not take the step it names, and the operation replays once it can.',
  code_import_interrupted:
    'GitHub imports are retired. Push the history to the project Git remote.',
  code_upload_incomplete:
    'The legacy transfer is incomplete; finish its drain with the previous runtime before rollout.',
  code_bundle_hash_mismatch:
    'The retained legacy bundle is corrupt; an operator must restore its verified bytes.',
};

const resume = 'Run maintenance again; it resumes where it stopped.';

/** The frozen merge plan an upload carries, with the first merge its lineage holds. */
const mergeOf = (pending: CodePendingMerge, firstMerge: string | null): Progress['merge'] => ({
  plan: pending.plan,
  left: pending.firstParent,
  right: pending.secondParent,
  firstMerge,
});

/** A full volume is a refusal that passes, not a fault of the operation that met it. */
const refusal = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOSPC'
    ? new MervError('code_store_full', 'The Code volume is full', 507)
    : error;

/**
 * Recovery of legacy imports and uploads already present in the journal. New work reaches
 * Code through its native Git remote; this class has no transfer-construction API.
 */
export class CodeReceiver {
  readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly core: StoreCore) {}

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

  /** Merge a change into an unfinished operation's progress, in a transaction of its own. */
  private async note(id: string, change: Partial<Progress>): Promise<void> {
    await this.core.state.transaction(async (tx) => {
      const current = await this.core.row(tx, id);
      if (current?.status === 'prepared') await this.progress(tx, current, change);
    });
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
  start(row: OperationRow): Promise<void> {
    let job = this.jobs.get(row.id);
    if (!job) {
      job = this.core
        .owned(() => this.core.repositories.run(row.project_id, () => this.advance(row.id)))
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

  /** Say on the row why an unfinished operation stopped, and what would move it. */
  private async stalled(id: string, error: unknown): Promise<void> {
    const code = this.core.closed
      ? 'code_drain_pending'
      : error instanceof MervError
        ? error.code
        : 'internal_error';
    await this.note(id, {
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
  }

  /**
   * Walk one operation as far as it goes. Every step first reads where the row stands, so
   * the same code serves a first run, a repeated completion and a start after a crash.
   */
  private async advance(id: string): Promise<void> {
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
        return { ...admission, merge: mergeOf(pending, verified.firstMerge) };
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
          ? await this.fetched(row, directory)
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
      const branchHead = upload
        ? await this.core.repositories.resolve(row.project_id, workRef(upload.unitId))
        : null;
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

      const receipt = () =>
        this.core.repositories.resolve(row!.project_id, `${progress.receiptRef}^{commit}`);
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
        if (payload.source === 'retain-ref') return;
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
        await this.core.hooks.changed(tx, row!.project_id);
      });
      this.core.fault('before_ack');
      await rm(directory, { recursive: true, force: true });
    }
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
    const held = (await stat(part).catch(() => null))?.size ?? 0;
    if (held !== payload.bundle.bytes) {
      // The row may claim more than the file kept: the sender resumes from what it says.
      await this.note(row.id, { received: held });
      throw new MervError(
        'code_upload_incomplete',
        `This operation holds ${held} of ${payload.bundle.bytes} bytes`,
        409,
      );
    }
    if ((await hashFile(part)) !== payload.bundle.sha256) {
      await rm(part, { force: true });
      await this.note(row.id, { received: 0 });
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

  /** Only drain already-admitted legacy imports; retirement never contacts GitHub. */
  private async fetched(
    row: OperationRow,
    directory: string,
  ): Promise<{ oid: string; github?: { id: number; fullName: string } } | null> {
    const progress = JSON.parse(row.progress_json ?? '{}') as Progress;
    if (progress.target && (await lstat(join(directory, 'bundle')).catch(() => null)))
      return { oid: progress.target, github: progress.github };
    await this.fail(
      row,
      'github_integration_retired',
      null,
      'Push the history to the project Git remote.',
    );
    return null;
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
