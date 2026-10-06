import { OperationJournal } from './operation-journal.js';
import {
  canonical,
  check,
  codeLocalBindInputSchema,
  digest,
  inTransaction,
  newId,
  now,
  recorded,
  type Caller,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeStoreWarning,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  requireHuman,
  oidPattern,
} from '@merv/contracts';
import { parseCodeInput } from './input.js';
import type { CodeWriterService } from './writers.js';
import { retainedRef, validRetentionRef } from './store/refs.js';
import { initializeCodeStorage } from './storage-schema.js';
interface ProjectRow {
  project_id: string;
  repository_id: string;
  binding_json: string;
  main_json: string;
  store_json: string | null;
}
/** Technical workspace identities and retained Git facts; owner policy stays with its caller. */
export class CodeUnitStore {
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly writers: CodeWriterService,
  ) {}
  async initialize(): Promise<void> {
    await initializeCodeStorage(this.state);
  }
  close(): void {
    this.closed = true;
  }
  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }
  async blockWorkspace(
    tx: Transaction,
    input: { projectId: string; unitId: string; reason: string | null },
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    if (input.reason !== null)
      await tx.run(
        "UPDATE code_workspaces SET blocked_by=?,writer_state=CASE WHEN writer_state IN ('reserved','active','closing') THEN 'recovery_required' ELSE writer_state END WHERE project_id=? AND unit_id=?",
        input.reason,
        input.projectId,
        input.unitId,
      );
    else
      await tx.run(
        'UPDATE code_workspaces SET blocked_by=NULL WHERE project_id=? AND unit_id=?',
        input.projectId,
        input.unitId,
      );
  }
  async declareWorkspace(
    caller: Caller,
    input: { unitId: string },
    tx: Transaction,
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    await this.scope.require(caller, 'write', tx);
    await tx.run(
      'INSERT INTO code_workspaces(project_id,unit_id,declared_at) VALUES (?,?,?) ON CONFLICT(project_id,unit_id) DO NOTHING',
      caller.projectId,
      input.unitId,
      now(),
    );
  }
  async pinWorkspace(
    caller: Caller,
    input: { unitId: string; reference: string },
    tx: Transaction,
  ): Promise<void> {
    this.assertOpen();
    check(oidPattern.test(input.reference), 'invalid_base', 'The workspace input must be a commit');
    await this.declareWorkspace(caller, input, tx);
    const existing = await tx.get<{ base_json: string | null }>(
      'SELECT base_json FROM code_workspaces WHERE project_id=? AND unit_id=?',
      caller.projectId,
      input.unitId,
    );
    check(
      !existing?.base_json || JSON.parse(existing.base_json).reference === input.reference,
      'code_base_conflict',
      'The workspace input is immutable',
      409,
    );
    await tx.run(
      'UPDATE code_workspaces SET base_json=? WHERE project_id=? AND unit_id=? AND base_json IS NULL',
      canonical({ reference: input.reference }),
      caller.projectId,
      input.unitId,
    );
  }
  /** Trusted in-process Git consumers retain an obligation; execution verifies its commit. */
  async retainStoredCommit(
    tx: Transaction,
    input: {
      projectId: string;
      key: string;
      unitId: string;
      commit: string;
      receipt?: string;
      storage?: 'code' | 'external';
      mirror?: boolean;
      ref?: string;
      createdAt?: string;
      actorId?: string;
    },
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const caller = { projectId: input.projectId, actorId: input.actorId ?? 'system:code' };
    check(oidPattern.test(input.commit), 'invalid_commit', 'Retention requires a commit');
    const reference = input.ref ?? retainedRef(input.key);
    check(
      validRetentionRef(reference),
      'invalid_ref',
      'The retained ref must be a safe name in Code’s namespace',
    );
    const storage = input.storage ?? 'code',
      at = input.createdAt ?? now();
    check(
      storage !== 'external' || (!input.mirror && input.ref === undefined),
      'code_retention_transport_invalid',
      'External retention cannot request Code ref transport',
      409,
    );
    if (input.mirror)
      check(
        await tx.get(
          'SELECT unit_id FROM code_workspaces WHERE project_id=? AND unit_id=?',
          caller.projectId,
          input.unitId,
        ),
        'code_workspace_required',
        'Mirroring retained commits requires its workspace',
        409,
      );
    if (input.receipt) {
      const receipt = await tx.get<{
        unit_id: string | null;
        status: string;
        result_json: string | null;
      }>(
        'SELECT unit_id,status,result_json FROM code_operations WHERE project_id=? AND id=?',
        caller.projectId,
        input.receipt,
      );
      check(
        receipt?.unit_id === input.unitId &&
          receipt.status === 'completed' &&
          receipt.result_json !== null &&
          JSON.parse(receipt.result_json).head === input.commit,
        'code_retention_receipt_invalid',
        'The receipt must prove this workspace commit was admitted',
        409,
      );
    }
    const existing = await tx.get<{
      commit_oid: string;
      storage: string;
      unit_id: string;
      receipt: string | null;
    }>(
      'SELECT commit_oid,storage,unit_id,receipt FROM code_retained_commits WHERE project_id=? AND retention_key=?',
      caller.projectId,
      input.key,
    );
    check(
      !existing ||
        (existing.commit_oid === input.commit &&
          existing.storage === storage &&
          existing.unit_id === input.unitId &&
          existing.receipt === (input.receipt ?? null)),
      'code_retention_conflict',
      'The retained commit is immutable',
      409,
    );
    if (existing) {
      const intent = await tx.get<{ payload_json: string; progress_json: string }>(
        "SELECT payload_json,progress_json FROM code_operations WHERE project_id=? AND principal_scope='system:code' AND request_id=?",
        caller.projectId,
        `retain:${input.key}`,
      );
      check(
        !intent ||
          (Boolean(JSON.parse(intent.payload_json).mirror) === Boolean(input.mirror) &&
            JSON.parse(intent.payload_json).ref === reference &&
            JSON.parse(intent.progress_json).receiptRef === reference),
        'code_retention_conflict',
        'The retained ref transport request is immutable',
        409,
      );
      return;
    }
    await tx.run(
      'INSERT INTO code_retained_commits(project_id,retention_key,unit_id,commit_oid,storage,receipt,created_at) VALUES (?,?,?,?,?,?,?)',
      caller.projectId,
      input.key,
      input.unitId,
      input.commit,
      storage,
      input.receipt ?? null,
      at,
    );
    if (storage === 'code') {
      const payload = {
        format: 1,
        source: 'retain-ref',
        ref: reference,
        retentionKey: input.key,
        mirror: input.mirror ?? false,
        actorId: caller.actorId,
        unitId: input.unitId,
        tip: input.commit,
      };
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        'system:code',
        `retain:${input.key}`,
        'retain-ref',
        digest(payload),
        canonical(payload),
        'prepared',
        at,
        null,
        'objects_durable',
        canonical({
          received: 0,
          expectedOld: null,
          target: input.commit,
          receiptRef: reference,
        }),
        at,
      );
    }
  }
  /** An authorized owner admits a stored Git observation, compared with its current main. */
  async setMainStored(
    tx: Transaction,
    input: {
      projectId: string;
      expectedOid: string;
      oid: string;
      actorId: string;
      operationId?: string;
    },
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    check(
      oidPattern.test(input.oid) && oidPattern.test(input.expectedOid),
      'invalid_commit',
      'Main must name a commit',
    );
    const at = now();
    const changed = await tx.run(
      "UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=? AND main_json::jsonb->>'oid'=?",
      canonical({
        oid: input.oid,
        stored: true,
        admittedBy: input.actorId,
        admittedAt: at,
        ...(input.operationId ? { operationId: input.operationId } : {}),
      }),
      at,
      input.projectId,
      input.expectedOid,
    );
    check(
      changed.changes === 1,
      'code_main_changed',
      'Main changed since its stored observation was prepared',
      409,
    );
  }
  async bindLocal(
    caller: Caller,
    value: CodeLocalBindInput,
    stored = false,
    tx?: Transaction,
  ): Promise<CodeProjectBinding> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeLocalBindInputSchema, value);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      requireHuman(
        caller,
        'code_human_required',
        'A signed-in project administrator binds the repository and names its main',
      );
      const principal = `actor:${caller.actorId}`;
      const { requestId, ...payload } = input;
      const inputHash = digest(payload);
      const journal = new OperationJournal(tx, caller.projectId, principal, requestId, inputHash);
      const previous = await journal.previous();
      if (previous) {
        // Every bind journalled before the lineage existed stored a result without `previous`,
        // and the contract now says the field is always there: the journal stays byte-identical
        // and the answer is normalised on the way out.
        const replayed = JSON.parse(previous.result_json) as CodeProjectBinding;
        return { ...replayed, previous: replayed.previous ?? [] };
      }
      const operationId = newId('cop'),
        at = now();
      const main = canonical({
        oid: input.mainOid,
        admittedBy: caller.actorId,
        admittedAt: at,
        operationId,
        ...(stored ? { stored: true } : {}),
      });
      const bound = await this.project(tx, caller.projectId);
      if (!bound) {
        check(
          input.expectedMainOid === undefined,
          'code_main_changed',
          'This project has no main yet; bind it without expectedMainOid',
          409,
        );
        await tx.run(
          'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          caller.projectId,
          'local',
          input.repositoryId,
          canonical({ boundBy: caller.actorId, boundAt: at, operationId }),
          main,
          '{}',
          '[]',
          at,
        );
      } else {
        check(
          bound.repositoryId === input.repositoryId,
          'code_rebind_required',
          'This project is bound to another repository; code.repository.rebind changes the binding after verifying that Code holds the project’s history',
          409,
        );
        check(
          input.expectedMainOid === bound.main.oid,
          'code_main_changed',
          'Main is not where expectedMainOid says; read code.status and decide again',
          409,
        );
        if (input.mainOid !== bound.main.oid)
          await tx.run(
            'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
            main,
            at,
            caller.projectId,
          );
      }
      // Naming main is what every unit with no retained code beneath it was waiting for.
      await this.writers.changes.emit({ kind: 'binding', projectId: caller.projectId }, tx);
      const result = (await this.project(tx, caller.projectId))!;
      await journal.complete(operationId, 'local_bind', payload, result, at);
      await recorded(this.state, tx, caller, 'code.local_bound', caller.projectId, {
        operationId,
        repositoryId: input.repositoryId,
        mainOid: input.mainOid,
        previousMainOid: bound?.main.oid ?? null,
      });
      return result;
    });
  }

  async hosted(caller: Caller, tx: Transaction): Promise<boolean> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    return (await this.project(tx, caller.projectId))?.durability === 'code';
  }

  async project(sql: Sql, projectId: string): Promise<CodeProjectBinding | null> {
    this.assertOpen();
    const row = await sql.get<ProjectRow>(
      'SELECT project_id,repository_id,binding_json,main_json,store_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as {
      boundBy: string;
      boundAt: string;
      managed?: boolean;
      previous?: CodeProjectBinding['previous'];
    };
    const main = JSON.parse(row.main_json) as CodeProjectBinding['main'];
    return {
      mode: 'local',
      repositoryId: row.repository_id,
      boundBy: binding.boundBy,
      boundAt: binding.boundAt,
      previous: binding.previous ?? [],
      main: {
        oid: main.oid,
        admittedBy: main.admittedBy,
        admittedAt: main.admittedAt,
        stored: main.stored === true,
      },
      // Once imported a project stays with Code's repository: a main it does not hold yet
      // blocks work, it never sends new work back to a runner's own repository.
      durability: row.store_json === null && !binding.managed ? 'legacy-local' : 'code',
    };
  }

  /**
   * What a base is derived against: main with the operation that named it, as stored, and
   * every repository identity the project was ever bound to, newest last. An acceptance made
   * under any of them is this project's own: one from before a verified rebind is safe to read
   * as such only because a rebind proves Code's repository holds every commit the project
   * retained as authoritative before it writes the new binding.
   */
  async binding(
    sql: Sql,
    projectId: string,
  ): Promise<{
    repositoryId: string;
    repositoryIds: string[];
    main: { oid: string; operationId: string; stored?: boolean };
  } | null> {
    const row = await sql.get<Pick<ProjectRow, 'repository_id' | 'binding_json' | 'main_json'>>(
      'SELECT repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!row) return null;
    const { previous } = JSON.parse(row.binding_json) as { previous?: { repositoryId: string }[] };
    return {
      repositoryId: row.repository_id,
      repositoryIds: [...(previous ?? []).map((entry) => entry.repositoryId), row.repository_id],
      main: JSON.parse(row.main_json) as { oid: string; operationId: string; stored?: boolean },
    };
  }

  /** What Code warned the project's administrators of, newest last. */
  async warnings(sql: Sql, projectId: string): Promise<CodeStoreWarning[]> {
    const row = await sql.get<{ warnings_json: string }>(
      'SELECT warnings_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    return JSON.parse(row?.warnings_json ?? '[]') as CodeStoreWarning[];
  }

  /** Whether Code is still creating the project's own repository. */
  async initializing(sql: Sql, projectId: string): Promise<boolean> {
    return !!(await sql.get(
      "SELECT id FROM code_operations WHERE project_id=? AND kind='initialize' AND status='prepared'",
      projectId,
    ));
  }
}
