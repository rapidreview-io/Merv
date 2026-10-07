import { RequestJournal } from './request-journal.js';
import {
  canonical,
  check,
  digest,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeCommandCompletion,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  requireHuman,
} from '@merv/contracts';
import {
  codeUnitFenceInputSchema,
  type CodeWriterState,
  type CodeWriterStatus,
} from './store/protocol.js';
import { parseCodeInput } from './input.js';
import type { CodeStorePort } from './service.js';

export interface WriterRow {
  project_id: string;
  unit_id: string;
  base_json: string | null;
  generation: number | string;
  writer_state: CodeWriterState;
  writer_session_id: string | null;
  writer_lease_id: string | null;
  writer_changed_at: string | null;
  head_oid: string | null;
  head_operation_id: string | null;
  mirrored_oid: string | null;
  mirrored_at: string | null;
  quarantine_operation_id: string | null;
  blocked_by: string | null;
}
/** Everything a mutation of a unit's branch names; the server compares all of it. */
export interface WriterFence {
  projectId: string;
  unitId: string;
  generation: number;
  sessionId: string;
  leaseId: string;
  expectedHead: string;
  /** Whether the upload proposes another head than it expects. */
  moves: boolean;
}
export const writerColumns =
  'project_id,unit_id,base_json,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at,head_oid,head_operation_id,mirrored_oid,mirrored_at,quarantine_operation_id,blocked_by';

/**
 * The writer fence of a unit. One leased session at a time may advance a unit's branch in
 * Code's repository, and it is known by a generation: a lease reserves generation g+1 only
 * once g closed, the session's attach makes it active, its end makes it closing, and the one
 * final capture its machine hands over closes it. A generation that never closes is not
 * guessed at: after the grace it waits, visibly, for an operator to fence it.
 */
export class CodeWriterService {
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    readonly finalizeGraceSeconds: number,
  ) {}
  /** The owner of work units, lent by openStore until it releases it. */
  private owner?: Pick<CodeStorePort, 'changed'>;

  /** Lends the owner's `changed` until the returned release; a later lend replaces it. */
  lend(owner: Pick<CodeStorePort, 'changed'>): () => void {
    this.owner = owner;
    return () => {
      if (this.owner === owner) this.owner = undefined;
    };
  }

  /**
   * A binding (no unit) or one unit's writer changed: the owner derives what waits on it in
   * the mutation's own transaction, never after commit. An owner that left or arrived while
   * that ran may have missed it, so the mutation is refused and rolls back.
   */
  async changed(tx: Transaction, projectId: string, unitId?: string): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    this.state.assertTransaction(tx);
    await owner.changed(tx, projectId, unitId);
    check(
      owner === this.owner,
      'code_projection_changed',
      'A Code projection changed while this mutation was being applied; retry it',
      409,
    );
  }

  /**
   * Called only from the owner's lease acquisition, right after the base was pinned, so a
   * refused offer takes the reservation back with it. The same lease reads what it reserved.
   */
  async reserveWriter(
    caller: Caller,
    { unitId, leaseId }: { unitId: string; leaseId: string },
    tx: Transaction,
  ): Promise<CodeWriterStatus> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    check(row?.base_json, 'code_base_pending', 'This unit has no base to write from yet', 409);
    check(!row.blocked_by, 'code_quarantined', 'This unit uses a quarantined base', 409);
    if (row.writer_lease_id === leaseId && row.writer_state !== 'idle') return this.view(row);
    const refusal = this.refusal(row, true);
    if (refusal) throw new MervError(refusal.code, refusal.message, 409);
    await tx.run(
      "UPDATE code_workspaces SET generation=generation+1,writer_state='reserved',writer_session_id=?,writer_lease_id=?,writer_changed_at=? WHERE project_id=? AND unit_id=?",
      leaseId,
      leaseId,
      now(),
      caller.projectId,
      unitId,
    );
    return this.view((await this.row(tx, caller.projectId, unitId))!);
  }

  /**
   * Whether a new writer could be leased now. A pure read for lease admission and the
   * candidate scan: a unit that waits for a final capture or for an operator is no candidate,
   * so it is never launched and never held.
   */
  async writerStatus(caller: Caller, unitId: string, tx: Transaction): Promise<CodeWriterStatus> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    return row ? this.view(row) : { generation: 0, state: 'idle', blocked: null };
  }

  /** Apply an owning session's attachment or end; the current generation alone may move. */
  async sessionChanged(
    projectId: string,
    sessionId: string,
    change: 'attached' | 'closed',
    tx: Transaction,
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const row = await tx.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_workspaces WHERE project_id=? AND writer_session_id=?`,
      projectId,
      sessionId,
    );
    if (!row) return;
    if (change === 'attached') {
      if (row.writer_state === 'reserved') await this.move(tx, row, 'active');
      return;
    }
    // A never-attached checkout needs no capture; an attached one waits for its final handoff.
    if (row.writer_state === 'reserved') await this.move(tx, row, 'closed');
    else if (row.writer_state === 'active') await this.move(tx, row, 'closing');
  }

  /**
   * The machine a session ran on is gone for good (Fleet released it and its runtime is
   * deleted), so the final capture it owed can never come: if that session is the current
   * writer, its generation ends here, at the last commit Code admitted, as an operator's fence
   * would end it, and the next lease continues from there. A quarantined capture, an admitted
   * upload not yet finished, or one whose bytes all arrived (Main admits it without the machine;
   * a final one closes the generation itself), still waits; a machine of the owner's own never
   * says it is gone, so its generation waits for it as before.
   */
  async machineGone(projectId: string, sessionId: string, tx: Transaction): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const row = await tx.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_workspaces WHERE project_id=? AND writer_session_id=?`,
      projectId,
      sessionId,
    );
    if (
      !row ||
      !['reserved', 'active', 'closing', 'recovery_required'].includes(row.writer_state) ||
      row.quarantine_operation_id !== null ||
      row.blocked_by
    )
      return;
    // An upload whose every byte is on Main can still be admitted without its machine (one that
    // was being admitted stays 'receiving' until it is), so it is never failed here.
    const open = await tx.all<{ phase: string; payload_json: string; progress_json: string }>(
      "SELECT phase,payload_json,progress_json FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared'",
      projectId,
      row.unit_id,
    );
    if (
      open.some((op) => {
        if (op.phase !== 'receiving') return true;
        const bytes = (JSON.parse(op.payload_json) as { bundle?: { bytes?: number } }).bundle
          ?.bytes;
        const received = (JSON.parse(op.progress_json ?? '{}') as { received?: number }).received;
        return typeof bytes === 'number' && (received ?? 0) >= bytes;
      })
    )
      return;
    const at = now();
    // What it was still sending can never be completed: it is held, never admitted.
    await tx.run(
      "UPDATE code_operations SET status='failed',error='code_generation_stale',detail_json=?,completed_at=?,updated_at=? WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared'",
      canonical({ message: 'The writer’s machine is gone; its generation ended' }),
      at,
      at,
      projectId,
      row.unit_id,
    );
    await this.move(tx, row, 'closed');
    await this.changed(tx, row);
    await this.state.appendEvent(tx, {
      projectId,
      actorId: 'system:code',
      type: 'code.writer_ended',
      subjectId: row.unit_id,
      data: {
        reason: 'machine_gone',
        sessionId,
        generation: Number(row.generation),
        head: row.head_oid,
        from: row.writer_state,
      },
    });
  }

  /** A generation whose final capture never came is shown as needing an operator. */
  async expire(): Promise<void> {
    if (this.closed) return;
    const before = new Date(Date.now() - this.finalizeGraceSeconds * 1000).toISOString();
    await this.state.transaction(async (tx) => {
      for (const row of await tx.all<WriterRow>(
        `SELECT ${writerColumns} FROM code_workspaces WHERE writer_state='closing' AND writer_changed_at<=? ORDER BY project_id,unit_id LIMIT 100`,
        before,
      )) {
        await this.move(tx, row, 'recovery_required');
        await this.changed(tx, row.project_id, row.unit_id);
      }
    });
  }

  /**
   * The fence every upload passes, at its beginning and again before any ref moves. A
   * checkpoint needs the live writer; the final capture is also taken after the session ended,
   * and heals a generation the grace already gave up on.
   */
  async fenced(tx: Transaction, fence: WriterFence, kind: 'checkpoint' | 'final') {
    const row = await this.row(tx, fence.projectId, fence.unitId);
    check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
    check(!row.blocked_by, 'code_quarantined', 'This unit uses a quarantined base', 409);
    check(
      Number(row.generation) === fence.generation &&
        row.writer_session_id === fence.sessionId &&
        row.writer_lease_id === fence.leaseId,
      'code_generation_stale',
      'Another writer generation owns this unit now',
      409,
    );
    // A session that ended before it attached closed its generation with nothing in it, and
    // its machine may still say so: a final capture that moves nothing is always answerable.
    const open =
      kind === 'final'
        ? ['reserved', 'active', 'closing', 'recovery_required', ...(fence.moves ? [] : ['closed'])]
        : ['reserved', 'active'];
    check(
      open.includes(row.writer_state),
      'code_writer_closed',
      'This writer generation has closed',
      409,
    );
    check(
      kind === 'final' || row.quarantine_operation_id === null,
      'code_capture_quarantined',
      'A capture of this unit is quarantined',
      409,
    );
    check(
      fence.expectedHead === (row.head_oid ?? this.base(row)),
      'code_head_conflict',
      'The unit’s branch is not where this upload expects it',
      409,
    );
    if (row.writer_state === 'reserved') await this.move(tx, row, 'active');
    return row;
  }

  /** An admitted upload advanced the branch; a final one ends its generation. */
  async advanced(
    tx: Transaction,
    fence: WriterFence,
    input: { head: string; operationId: string; final: boolean },
  ): Promise<void> {
    await tx.run(
      'UPDATE code_workspaces SET head_oid=?,head_operation_id=? WHERE project_id=? AND unit_id=?',
      input.head,
      input.operationId,
      fence.projectId,
      fence.unitId,
    );
    if (!input.final) return;
    const row = (await this.row(tx, fence.projectId, fence.unitId))!;
    await this.move(tx, row, 'closed');
    await tx.run(
      'UPDATE code_workspaces SET quarantine_operation_id=NULL WHERE project_id=? AND unit_id=?',
      fence.projectId,
      fence.unitId,
    );
    await this.changed(tx, row.project_id, row.unit_id);
  }

  /** A final capture with findings: nothing advanced, and the unit waits for an operator. */
  async quarantined(tx: Transaction, fence: WriterFence, operationId: string): Promise<void> {
    const row = await this.row(tx, fence.projectId, fence.unitId);
    if (!row || Number(row.generation) !== fence.generation) return;
    await this.move(tx, row, 'recovery_required');
    await tx.run(
      'UPDATE code_workspaces SET quarantine_operation_id=? WHERE project_id=? AND unit_id=?',
      operationId,
      fence.projectId,
      fence.unitId,
    );
    await this.changed(tx, row.project_id, row.unit_id);
  }

  /**
   * An operator ends a generation that will not end by itself. The caller has already let
   * every admitted upload of the unit finish and refuses while one cannot; what is left is
   * bytes nobody may complete any more.
   */
  async fence(caller: Caller, value: unknown, tx: Transaction): Promise<CodeWriterStatus> {
    this.assertOpen();
    const input = parseCodeInput(codeUnitFenceInputSchema, value);
    await this.scope.require(caller, 'admin', tx);
    requireHuman(
      caller,
      'code_human_required',
      'A signed-in project administrator fences a writer',
    );
    const principal = `actor:${caller.actorId}`;
    const { requestId, ...body } = input;
    const journal = new RequestJournal(tx, caller.projectId, principal, requestId, digest(body));
    const previous = await journal.previous();
    if (previous) return JSON.parse(previous.result_json) as CodeWriterStatus;
    const row = await this.row(tx, caller.projectId, input.unitId);
    check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
    check(!row.blocked_by, 'code_quarantined', 'This unit uses a quarantined base', 409);
    check(
      !(await tx.get(
        "SELECT id FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared' AND phase<>'receiving'",
        caller.projectId,
        input.unitId,
      )),
      'code_operation_unresolved',
      'An admitted upload of this unit is unfinished; it must complete or be recovered first',
      409,
    );
    const at = now();
    await tx.run(
      "UPDATE code_operations SET status='failed',error='code_generation_stale',detail_json=?,completed_at=?,updated_at=? WHERE project_id=? AND unit_id=? AND kind='upload' AND status='prepared'",
      canonical({ message: 'An operator fenced this writer generation' }),
      at,
      at,
      caller.projectId,
      input.unitId,
    );
    if (!['idle', 'closed'].includes(row.writer_state)) await this.move(tx, row, 'closed');
    await tx.run(
      'UPDATE code_workspaces SET quarantine_operation_id=NULL WHERE project_id=? AND unit_id=?',
      caller.projectId,
      input.unitId,
    );
    await this.changed(tx, row.project_id, row.unit_id);
    const result = this.view((await this.row(tx, caller.projectId, input.unitId))!);
    const id = newId('cop');
    await journal.complete(id, 'fence', body, result, at);
    await recorded(this.state, tx, caller, 'code.unit_fenced', input.unitId, {
      operationId: id,
      generation: result.generation,
      head: row.head_oid,
      from: row.writer_state,
    });
    return result;
  }

  /** A commit succeeded only once Code admitted exactly it under the command's own request. */
  async requireAdmitted(
    input: CodeCommandCompletion,
    command: { projectId: string; instanceId: string },
    tx: Transaction,
  ) {
    if (!('receipt' in input) || !input.receipt) return;
    const instanceId = command.instanceId;
    const upload = await tx.get<{ status: string; result_json: string | null }>(
      "SELECT status,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=? AND kind='upload' AND unit_id=?",
      command.projectId,
      `session:${input.sessionId}`,
      input.commandId,
      instanceId,
    );
    check(
      upload?.status === 'completed' &&
        (JSON.parse(upload.result_json!) as { head: string }).head === input.receipt.headOid,
      'code_upload_required',
      'This commit succeeds only once Code admitted exactly it',
      409,
    );
  }

  /** The completed upload of this unit that delivered a commit, which is its receipt. */
  /** The first admitted upload of this unit that left it at `commit`, and the merge it verified. */
  async receipt(tx: Transaction, projectId: string, unitId: string, commit: string) {
    const row = await tx.get<{ id: string; result_json: string }>(
      "SELECT id,result_json FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='completed' AND result_json LIKE ? ORDER BY completed_at,id LIMIT 1",
      projectId,
      unitId,
      `%"head":"${commit}"%`,
    );
    if (!row) return null;
    const { merge } = JSON.parse(row.result_json) as {
      merge?: { plan: string; left: string; right: string; firstMerge: string | null };
    };
    return { id: row.id, merge: merge ?? null };
  }

  async facts(
    sql: Sql,
    projectId: string,
    unitId: string,
  ): Promise<{
    generation: number;
    writerState: CodeWriterState;
    canonicalHead: string | null;
    mirroredHead: string | null;
    mirroredAt: string | null;
    quarantine: { operationId: string } | null;
  }> {
    const row = await this.row(sql, projectId, unitId);
    return {
      generation: Number(row?.generation ?? 0),
      writerState: row?.writer_state ?? 'idle',
      canonicalHead: row?.head_oid ?? null,
      mirroredHead: row?.mirrored_oid ?? null,
      mirroredAt: row?.mirrored_at ?? null,
      quarantine: row?.quarantine_operation_id
        ? { operationId: row.quarantine_operation_id }
        : null,
    };
  }

  /**
   * Where a closed writer generation left the unit, if it was this session's: the head with
   * its tree when this session's final upload moved it there, else the head alone, which is
   * the base if nothing moved it. An operator's fence and a final admission both close it.
   */
  async closedHead(
    projectId: string,
    unitId: string,
    sessionId: string,
    tx: Sql,
  ): Promise<{ headOid: string; treeOid?: string } | null> {
    const writer = await this.row(tx, projectId, unitId);
    if (writer?.writer_state !== 'closed' || writer.writer_session_id !== sessionId) return null;
    const final = writer.head_operation_id
      ? await tx.get<{ payload_json: string }>(
          "SELECT payload_json FROM code_operations WHERE id=? AND project_id=? AND kind='upload'",
          writer.head_operation_id,
          projectId,
        )
      : undefined;
    const upload = final && (JSON.parse(final.payload_json) as Record<string, unknown>);
    return upload &&
      upload.kind === 'final' &&
      upload.sessionId === sessionId &&
      typeof upload.tip === 'string' &&
      upload.tip === writer.head_oid &&
      typeof upload.treeOid === 'string'
      ? { headOid: upload.tip, treeOid: upload.treeOid }
      : { headOid: writer.head_oid ?? this.base(writer) };
  }

  /** Workspace identities whose writer generation has begun, without exposing owned storage;
   * with `blocking`, only those whose writer can still raise a blocker (it has not handed over
   * its final capture, or that capture is quarantined). */
  async writerIdentities(
    sql: Sql,
    projectId?: string,
    blocking = false,
  ): Promise<{ projectId: string; unitId: string }[]> {
    this.assertOpen();
    const which = blocking
      ? "(writer_state IN ('closing','recovery_required') OR quarantine_operation_id IS NOT NULL)"
      : 'generation>0';
    const rows =
      projectId === undefined
        ? await sql.all<{ project_id: string; unit_id: string }>(
            `SELECT project_id,unit_id FROM code_workspaces WHERE ${which} ORDER BY project_id,unit_id`,
          )
        : await sql.all<{ project_id: string; unit_id: string }>(
            `SELECT project_id,unit_id FROM code_workspaces WHERE project_id=? AND ${which} ORDER BY unit_id`,
            projectId,
          );
    return rows.map((row) => ({ projectId: row.project_id, unitId: row.unit_id }));
  }
  async row(sql: Sql, projectId: string, unitId: string): Promise<WriterRow | undefined> {
    return await sql.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_workspaces WHERE project_id=? AND unit_id=?`,
      projectId,
      unitId,
    );
  }

  /** The commit a unit's branch starts from, which its pin names. */
  base(row: WriterRow): string {
    return (JSON.parse(row.base_json!) as { reference: string }).reference;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }

  private refusal(row: WriterRow, reserving: boolean): CodeWriterStatus['blocked'] {
    if (row.blocked_by)
      return {
        code: 'code_quarantined',
        message: `This unit uses quarantined base ${row.blocked_by}; create corrective work and replan.`,
      };
    if (row.quarantine_operation_id !== null)
      return {
        code: 'code_capture_quarantined',
        message: 'The final capture of this unit is quarantined and an operator has not fenced it',
      };
    if (row.writer_state === 'recovery_required')
      return {
        code: 'code_recovery_required',
        message: 'The last writer of this unit never handed over its final capture',
      };
    // A live writer holds the unit's lease, so only an ended one can stand in the way: for
    // the moment its end takes to arrive here, or until its machine hands over what it left.
    if (
      row.writer_state === 'closing' ||
      (reserving && !['idle', 'closed'].includes(row.writer_state))
    )
      return {
        code: 'code_writer_busy',
        message: 'The last writer of this unit has not handed over its final capture yet',
      };
    return null;
  }

  private view(row: WriterRow): CodeWriterStatus {
    return {
      generation: Number(row.generation),
      state: row.writer_state,
      blocked: this.refusal(row, false),
    };
  }

  private async move(tx: Transaction, row: WriterRow, to: CodeWriterState): Promise<void> {
    await tx.run(
      'UPDATE code_workspaces SET writer_state=?,writer_changed_at=? WHERE project_id=? AND unit_id=?',
      to,
      now(),
      row.project_id,
      row.unit_id,
    );
  }
}
