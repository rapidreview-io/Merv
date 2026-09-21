import {
  canonical,
  check,
  codeUnitFenceInputSchema,
  digest,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeCommandCompletion,
  type CodeUnit,
  type CodeWriterState,
  type CodeWriterStatus,
  type Scope,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
  type WorkflowProvidedBlockerInput,
  type Workflows,
} from '@merv/contracts';
import { parseCodeInput } from './input.js';

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
  quarantine_operation_id: string | null;
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
const writerColumns =
  'project_id,unit_id,base_json,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at,head_oid,head_operation_id,quarantine_operation_id';
const PROVIDER = 'code';
const FENCE =
  'A signed-in project administrator reads the findings in code.status and runs code.unit.fence, which closes this writer at the last commit Code admitted; the next lease continues from there.';

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
    private readonly workflows: Workflows,
    private readonly finalizeGraceSeconds: number,
  ) {}

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
    if (row.writer_lease_id === leaseId && row.writer_state !== 'idle') return this.view(row);
    const refusal = this.refusal(row, true);
    if (refusal) throw new MervError(refusal.code, refusal.message, 409);
    await tx.run(
      "UPDATE code_units SET generation=generation+1,writer_state='reserved',writer_session_id=?,writer_lease_id=?,writer_changed_at=? WHERE project_id=? AND unit_id=?",
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

  /** The durable consumer of a session's attach and end, which open and end its generation. */
  async sessionChanged(event: StoredEvent, tx: Transaction): Promise<void> {
    const row = await tx.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_units WHERE project_id=? AND writer_session_id=?`,
      event.projectId,
      event.subjectId,
    );
    if (!row) return;
    if (event.type === 'session.workspace_attached') {
      if (row.writer_state === 'reserved') await this.move(tx, row, 'active');
      return;
    }
    // Nothing can have been edited in a checkout that was never attached, so that generation
    // simply closes; an attached one waits for the final capture of its machine.
    if (row.writer_state === 'reserved') await this.move(tx, row, 'closed');
    else if (row.writer_state === 'active') await this.move(tx, row, 'closing');
  }

  /** A generation whose final capture never came is shown as needing an operator. */
  async expire(): Promise<void> {
    if (this.closed) return;
    const before = new Date(Date.now() - this.finalizeGraceSeconds * 1000).toISOString();
    await this.state.transaction(async (tx) => {
      for (const row of await tx.all<WriterRow>(
        `SELECT ${writerColumns} FROM code_units WHERE writer_state='closing' AND writer_changed_at<=? ORDER BY project_id,unit_id LIMIT 100`,
        before,
      )) {
        await this.move(tx, row, 'recovery_required');
        await this.publish(tx, row, [
          {
            key: 'writer',
            code: 'code_recovery_required',
            message:
              'The machine that last worked on this unit never handed over its final capture, so what it left is unknown',
            status: 409,
            next: `Start that runner again so it can finish, or: ${FENCE}`,
            related: [],
          },
        ]);
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
      'UPDATE code_units SET head_oid=?,head_operation_id=? WHERE project_id=? AND unit_id=?',
      input.head,
      input.operationId,
      fence.projectId,
      fence.unitId,
    );
    if (!input.final) return;
    const row = (await this.row(tx, fence.projectId, fence.unitId))!;
    await this.move(tx, row, 'closed');
    await tx.run(
      'UPDATE code_units SET quarantine_operation_id=NULL WHERE project_id=? AND unit_id=?',
      fence.projectId,
      fence.unitId,
    );
    await this.publish(tx, row, []);
  }

  /** A final capture with findings: nothing advanced, and the unit waits for an operator. */
  async quarantined(tx: Transaction, fence: WriterFence, operationId: string): Promise<void> {
    const row = await this.row(tx, fence.projectId, fence.unitId);
    if (!row || Number(row.generation) !== fence.generation) return;
    await this.move(tx, row, 'recovery_required');
    await tx.run(
      'UPDATE code_units SET quarantine_operation_id=? WHERE project_id=? AND unit_id=?',
      operationId,
      fence.projectId,
      fence.unitId,
    );
    await this.publish(tx, row, [
      {
        key: 'capture',
        code: 'code_capture_quarantined',
        message:
          'The final capture of this unit holds something Code does not keep, so nothing of it was admitted',
        status: 409,
        next: FENCE,
        related: [],
      },
    ]);
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
    check(
      caller.human && !caller.session && !caller.key,
      'code_human_required',
      'A signed-in project administrator fences a writer',
      403,
    );
    const principal = `actor:${caller.actorId}`;
    const { requestId, ...body } = input;
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
      return JSON.parse(previous.result_json) as CodeWriterStatus;
    }
    const row = await this.row(tx, caller.projectId, input.unitId);
    check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
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
      'UPDATE code_units SET quarantine_operation_id=NULL WHERE project_id=? AND unit_id=?',
      caller.projectId,
      input.unitId,
    );
    await this.publish(tx, row, []);
    const result = this.view((await this.row(tx, caller.projectId, input.unitId))!);
    const id = newId('cop');
    await tx.run(
      'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      caller.projectId,
      principal,
      requestId,
      'fence',
      digest(body),
      canonical(body),
      'completed',
      canonical(result),
      at,
      at,
    );
    await recorded(this.state, tx, caller, 'code.unit_fenced', input.unitId, {
      operationId: id,
      generation: result.generation,
      head: row.head_oid,
      from: row.writer_state,
    });
    return result;
  }

  /**
   * A unit that writes to Code's repository has a generation; every other unit is a legacy
   * one and is left alone. For the former a commit succeeded only once Code admitted exactly
   * that commit under the command's own request.
   */
  async requireAdmitted(
    input: CodeCommandCompletion,
    command: { projectId: string; instanceId: string },
    tx: Transaction,
  ) {
    if (!('receipt' in input) || !input.receipt) return;
    const instanceId = command.instanceId;
    const unit = await tx.get<{ generation: number | string }>(
      'SELECT generation FROM code_units WHERE project_id=? AND unit_id=?',
      command.projectId,
      instanceId,
    );
    if (!unit || Number(unit.generation) < 1) return;
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
  async receipt(tx: Transaction, projectId: string, unitId: string, commit: string) {
    const row = await tx.get<{ id: string }>(
      "SELECT id FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='completed' AND result_json LIKE ? ORDER BY completed_at,id LIMIT 1",
      projectId,
      unitId,
      `%"head":"${commit}"%`,
    );
    return row?.id ?? null;
  }

  async facts(
    sql: Sql,
    projectId: string,
    unitId: string,
  ): Promise<Pick<CodeUnit, 'generation' | 'writerState' | 'canonicalHead' | 'quarantine'>> {
    const row = await this.row(sql, projectId, unitId);
    return {
      generation: Number(row?.generation ?? 0),
      writerState: row?.writer_state ?? 'idle',
      canonicalHead: row?.head_oid ?? null,
      quarantine: row?.quarantine_operation_id
        ? { operationId: row.quarantine_operation_id }
        : null,
    };
  }

  async row(sql: Sql, projectId: string, unitId: string): Promise<WriterRow | undefined> {
    return await sql.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
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
      'UPDATE code_units SET writer_state=?,writer_changed_at=? WHERE project_id=? AND unit_id=?',
      to,
      now(),
      row.project_id,
      row.unit_id,
    );
  }

  private async publish(
    tx: Transaction,
    row: WriterRow,
    blockers: WorkflowProvidedBlockerInput[],
  ): Promise<void> {
    await this.workflows.replaceBlockers(
      { projectId: row.project_id, instanceId: row.unit_id, provider: PROVIDER, blockers },
      tx,
    );
  }
}
