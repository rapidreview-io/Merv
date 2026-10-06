import { OperationJournal } from '../operation-journal.js';
import {
  canonical,
  check,
  digest,
  eventSource,
  newId,
  now,
  type Caller,
  type Sql,
  type Transaction,
  requireHuman,
} from '@merv/contracts';
import {
  codeRepositoryRebindInputSchema,
  type CodeRepositoryRebindInput,
  type CodeStoreOperation,
} from './protocol.js';
import { parseCodeInput } from '../input.js';
import { CodeExporter } from './export.js';
import { columns, held, type OperationRow, type RebindPayload } from './receive.js';

/** A commit this project retains as authoritative, with what retains it. */
interface RetainedRef {
  kind: 'main' | 'retained' | 'work' | 'base-pin';
  id: string;
  oid: string;
}
/** The write-once proof a completed rebind retains; its hash is stamped into the binding. */
interface RebindProof {
  formatVersion: 1;
  repositoryId: string;
  previousRepositoryId: string;
  mainOid: string;
  previousMainOid: string;
  mainAhead: boolean;
  acknowledgedPreviousMain?: string;
  refs: RetainedRef[];
  count: number;
  markerIds: string[];
}

/** Rebinding a hosted project to another repository identity. */
export class CodeRebinder extends CodeExporter {
  /**
   * Bind a hosted project to another repository identity. Nothing is moved and nothing is
   * published: Code's own repository is keyed by the project alone, so it stays where it is and
   * keeps every object it holds, and the linked GitHub repository is not touched. What is
   * proved first, with no transaction open, is that Code's repository holds every commit the
   * project retains as authoritative; one transaction then writes the new binding. It lives
   * beside importRepository because it needs Git and the repositories directory, and reaches
   * units only through the existing `imported` hook.
   */
  async rebindRepository(caller: Caller, value: unknown): Promise<CodeStoreOperation> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeRepositoryRebindInputSchema, value);
    const { requestId, ...body } = input;
    const inputHash = digest(body);
    const principal = `actor:${caller.actorId}`;
    const payload: RebindPayload = {
      format: 1,
      source: 'rebind',
      actorId: caller.actorId,
      repositoryId: input.repositoryId,
      mainOid: input.mainOid,
      reason: input.reason,
    };
    // Phase 1 — prepare. No Git, no network, one small transaction; `unit_id` stays null so
    // code_operations_unit_open does not apply, and one prepared rebind per project is what
    // the read below enforces inside this transaction rather than an index.
    const prepared = await this.state.transaction(async (tx) => {
      await this.humanAdministrator(caller, tx);
      const journal = new OperationJournal(tx, caller.projectId, principal, requestId, inputHash);
      const previous = await journal.previous<OperationRow>(columns);
      if (previous) {
        // A finished rebind replays its own answer; the refusals below are about work in
        // flight, and one of them — the identity this project is bound to — it has itself made.
        if (previous.status !== 'prepared') return previous;
      }
      await this.rebindable(caller, input, tx);
      if (previous) return previous;
      const at = now();
      // An unfinished rebind of this project is not a wall for its administrator: everything it
      // wrote is an idempotent marker append, so a new request supersedes it rather than
      // waiting for a row that nothing else will ever move.
      for (const stale of await tx.all<{ id: string }>(
        "SELECT id FROM code_operations WHERE project_id=? AND kind='rebind' AND status='prepared'",
        caller.projectId,
      ))
        await tx.run(
          "UPDATE code_operations SET status='failed',error=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
          'code_rebind_superseded',
          at,
          at,
          stale.id,
        );
      const id = newId('cop');
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,phase,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id,
        caller.projectId,
        principal,
        requestId,
        'rebind',
        inputHash,
        canonical(payload),
        'prepared',
        at,
        'verifying',
        at,
      );
      return (await this.row(tx, id))!;
    });
    if (prepared.status !== 'prepared') return this.view(prepared);
    await this.owned(() =>
      this.repositories.run(prepared.project_id, () => this.rebind(caller, prepared, input)),
    );
    return this.view((await this.state.read((sql) => this.row(sql, prepared.id)))!);
  }

  /**
   * Phase 2 (verify and record the marker, outside every transaction) and phase 3 (activate,
   * in the one transaction that writes). Replaying the same request re-verifies from scratch,
   * which is what makes a crash between the two harmless.
   */
  private async rebind(
    caller: Caller,
    row: OperationRow,
    input: CodeRepositoryRebindInput,
  ): Promise<void> {
    const bound = (await this.state.read((sql) => this.bound(sql, row.project_id)))!;
    const previousMain = (JSON.parse(bound.main_json) as { oid: string }).oid;
    const refs = await this.retained(row.project_id, previousMain, input.mainOid);
    const missing = await this.absent(
      row.project_id,
      refs.map((ref) => ref.oid),
    );
    check(
      !missing.size,
      'code_rebind_incomplete',
      `Code’s repository does not hold ${missing.size} commit(s) this project retains as authoritative, so it cannot carry its history to another identity: ${refs
        .filter((ref) => missing.has(ref.oid))
        .slice(0, 50)
        .map((ref) => `${ref.kind} ${ref.id} ${ref.oid}`)
        .join(', ')}`,
      409,
    );
    // Both commits are now known to be held, so the ancestry question is always answerable.
    const mainAhead =
      input.mainOid === previousMain ||
      (await this.ancestor(row.project_id, previousMain, input.mainOid));
    check(
      mainAhead || input.acknowledgePreviousMain === previousMain,
      'code_rebind_main_diverged',
      `The named main is not ahead of the main this project is leaving behind (${previousMain}); name that commit exactly as acknowledgePreviousMain to let it go`,
      409,
    );
    // What the binding row itself holds, oldest first: the marker is rewritten from this, so a
    // rebind that never reached its transaction leaves no identity behind in the file.
    const lineage = [
      ...(
        (JSON.parse(bound.binding_json) as { previous?: { repositoryId: string }[] }).previous ?? []
      ).map((entry) => entry.repositoryId),
      bound.repository_id,
    ];
    const markerIds = await this.repositories.rebind(row.project_id, lineage, input.repositoryId);
    this.fault('after_rebind_marker');
    const proof: RebindProof = {
      formatVersion: 1,
      repositoryId: input.repositoryId,
      previousRepositoryId: bound.repository_id,
      mainOid: input.mainOid,
      previousMainOid: previousMain,
      mainAhead,
      ...(mainAhead ? {} : { acknowledgedPreviousMain: previousMain }),
      refs,
      count: refs.length,
      markerIds,
    };
    await this.state.transaction(async (tx) => {
      const current = await this.row(tx, row.id);
      if (current?.status !== 'prepared') return;
      await this.humanAdministrator(caller, tx);
      await this.rebindable(caller, input, tx);
      const at = now();
      const held = (await this.bound(tx, row.project_id))!;
      check(
        held.repository_id === bound.repository_id &&
          (JSON.parse(held.main_json) as { oid: string }).oid === previousMain,
        'code_operation_changed',
        'The binding moved while this rebind was being verified; call it again with the same requestId',
        409,
      );
      const binding = JSON.parse(held.binding_json) as {
        boundBy: string;
        boundAt: string;
        operationId: string;
        previous?: unknown[];
      };
      const written = await tx.run(
        'UPDATE code_projects SET repository_id=?,binding_json=?,main_json=?,updated_at=? WHERE project_id=? AND repository_id=?',
        input.repositoryId,
        canonical({
          boundBy: caller.actorId,
          boundAt: at,
          operationId: row.id,
          proof: digest(proof),
          previous: [
            ...(binding.previous ?? []),
            {
              repositoryId: held.repository_id,
              boundBy: binding.boundBy,
              boundAt: binding.boundAt,
              operationId: binding.operationId,
              reboundBy: caller.actorId,
              reboundAt: at,
              reason: input.reason,
            },
          ],
        }),
        // Phase 2 proved Code holds this commit, so it is stored without asking Git again.
        canonical({
          oid: input.mainOid,
          stored: true,
          admittedBy: caller.actorId,
          admittedAt: at,
          operationId: row.id,
        }),
        at,
        row.project_id,
        bound.repository_id,
      );
      // A WHERE that excludes the row fires no trigger and reports no change, so the miss is
      // silent unless it is read: without this the operation would complete over no write.
      check(
        written.changes === 1,
        'code_operation_changed',
        'The binding moved while this rebind was being applied; call it again with the same requestId',
        409,
      );
      // Every unpinned unit is derived again under the new binding. Pure SQL: no Git and no
      // network enter this transaction.
      await this.hooks.imported(tx, row.project_id);
      // Last, because the relaxed code_projects_binding trigger requires this operation to
      // still be prepared while code_projects is written.
      await tx.run(
        "UPDATE code_operations SET status='completed',result_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'",
        canonical(proof),
        at,
        at,
        row.id,
      );
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: caller.actorId,
        type: 'code.repository_rebound',
        subjectId: row.project_id,
        data: {
          ...eventSource(caller),
          operationId: row.id,
          repositoryId: input.repositoryId,
          previousRepositoryId: bound.repository_id,
          mainOid: input.mainOid,
          previousMainOid: previousMain,
          reason: input.reason,
          refs: refs.length,
        },
      });
    });
  }

  /** Verbatim the code.local.bind rule: a leased session never gains a human-only power. */
  private async humanAdministrator(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'admin', tx);
    requireHuman(
      caller,
      'code_human_required',
      'A signed-in project administrator rebinds the repository',
    );
  }

  /** The binding row a rebind reads and writes; `project()` does not carry binding_json. */
  private async bound(sql: Sql, projectId: string) {
    return await sql.get<{ repository_id: string; binding_json: string; main_json: string }>(
      'SELECT repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    );
  }

  /**
   * Everything a rebind refuses for, read in phase 1 and read again inside the transaction that
   * writes. There is no drain and no queue: this refusal is the whole mechanism for work in
   * flight, so it has to name every kind of it.
   */
  private async rebindable(
    caller: Caller,
    input: CodeRepositoryRebindInput,
    tx: Transaction,
  ): Promise<void> {
    const bound = await this.bound(tx, caller.projectId);
    check(bound, 'code_project_unbound', 'This project has no Code binding', 409);
    const project = await this.project(tx, caller.projectId);
    check(
      project?.store_json,
      'code_rebind_unhosted',
      'Import this project’s repository into Code before rebinding it',
      409,
    );
    check(
      bound.repository_id !== input.repositoryId,
      'code_rebind_unchanged',
      'This project is already bound to that repository; code.local.bind moves main',
      409,
    );
    const named = async (what: string, sql: string) =>
      held(
        what,
        (await tx.all<Record<string, string>>(sql, caller.projectId)).map(
          (row) => Object.values(row)[0],
        ),
      );
    const busy = [
      ...(await named(
        'open writer generations:',
        "SELECT unit_id FROM code_workspaces WHERE project_id=? AND writer_state IN ('reserved','active','closing') ORDER BY unit_id",
      )),
      ...(await named(
        'unfinished transfers:',
        "SELECT id FROM code_operations WHERE project_id=? AND status='prepared' AND kind IN ('import','upload','retain-ref') ORDER BY created_at,id",
      )),
      ...(await named(
        'repository holds:',
        'SELECT hold_key FROM code_repository_holds WHERE project_id=? ORDER BY hold_key',
      )),
    ];
    // Consumers holding repository-scoped snapshots must release them before rebinding.
    const listed = [
      ...busy,
      ...held('sessions holding a workspace:', await this.hooks.workspaces(caller.projectId, tx)),
    ];
    check(
      !listed.length,
      'code_rebind_busy',
      `A rebind waits for the work this project has in flight — ${listed.join('; ')}`,
      409,
    );
  }

  /**
   * Every commit this project retains: current and proposed main, opaque retained commits,
   * workspace heads and immutable input pins. Pins retain the original input even after
   * a later binding operation moves main.
   */
  private async retained(
    projectId: string,
    previousMain: string,
    mainOid: string,
  ): Promise<RetainedRef[]> {
    const read = await this.state.read(async (sql) => ({
      units: await sql.all<{ unit_id: string; base_json: string | null; head_oid: string | null }>(
        'SELECT unit_id,base_json,head_oid FROM code_workspaces WHERE project_id=? ORDER BY unit_id',
        projectId,
      ),
      commits: await sql.all<{ retention_key: string; commit_oid: string }>(
        'SELECT retention_key,commit_oid FROM code_retained_commits WHERE project_id=? ORDER BY retention_key',
        projectId,
      ),
    }));
    const refs: RetainedRef[] = [{ kind: 'main', id: 'main', oid: previousMain }];
    if (mainOid !== previousMain) refs.push({ kind: 'main', id: 'named', oid: mainOid });
    for (const unit of read.units) {
      if (unit.base_json)
        refs.push({
          kind: 'base-pin',
          id: unit.unit_id,
          oid: (JSON.parse(unit.base_json) as { reference: string }).reference,
        });
      if (unit.head_oid) refs.push({ kind: 'work', id: unit.unit_id, oid: unit.head_oid });
    }
    for (const retained of read.commits)
      refs.push({ kind: 'retained', id: retained.retention_key, oid: retained.commit_oid });
    return refs;
  }

  /** Whether `tip` has `base` in its history, asked of the project's own repository. */
  private async ancestor(projectId: string, base: string, tip: string): Promise<boolean> {
    return (
      (
        await this.repositories.git.run(['merge-base', '--is-ancestor', base, tip], {
          env: this.repositories.environment(projectId),
        })
      ).code === 0
    );
  }
}
