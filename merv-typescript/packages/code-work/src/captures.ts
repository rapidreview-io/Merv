import { z } from 'zod';
import {
  check,
  codeCommandRecordSchema,
  type Caller,
  type Scope,
  type State,
  type Transaction,
  type Sql,
  idSchema,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type {
  CheckedCodeCapture,
  CodeCapture,
  CodeCaptureOrigin,
  CodeCaptureRef,
} from './types.js';
import { parseCodeInput } from '@merv/code/input';
import type { CodeWriterService } from '@merv/code/writers';
export const codeCaptureRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session-final'), sessionId: idSchema }).strict(),
  z.object({ kind: z.literal('code-commit'), commandId: idSchema }).strict(),
]);
/** Whether a capture came from exactly this origin's writable session, and holds its result. */
export function checkedCapture(
  capture: CodeCapture,
  projectId: string,
  origin: CodeCaptureOrigin,
): CheckedCodeCapture {
  const p = capture.provenance;
  if (
    p.projectId !== projectId ||
    p.instanceId !== origin.unitId ||
    p.revision !== origin.revision ||
    p.workflow.name !== origin.workflow.name ||
    !origin.workflow.versions.includes(p.workflow.version) ||
    p.workflow.state !== origin.workflow.state ||
    p.readOnly ||
    (origin.sessionId !== undefined && p.sessionId !== origin.sessionId) ||
    (origin.actorId !== undefined && p.actorId !== origin.actorId)
  )
    return { status: 'foreign', capture };
  const { workspace } = capture;
  return capture.status === 'ready' && workspace
    ? { status: 'ready', capture: { ...capture, workspace } }
    : { status: capture.status === 'ready' ? 'failed' : capture.status, capture };
}
/** A reader over records owned by Code and Sessions, not another mutable head ledger. */
export class CodeCaptureReader {
  private closed = false;
  constructor(
    private state: State,
    private scope: Scope,
    private sessions: Sessions,
    private writers: CodeWriterService,
  ) {}
  async capture(caller: Caller, value: CodeCaptureRef, tx?: Transaction): Promise<CodeCapture> {
    check(!this.closed, 'code_unavailable', 'Code capture reader is unavailable', 503);
    caller = structuredClone(caller);
    const ref = parseCodeInput(codeCaptureRefSchema, value);
    if (tx) this.state.assertTransaction(tx);
    await this.scope.require(caller, 'read', tx);
    if (ref.kind === 'session-final') {
      const observation = await this.sessions.workspaceObservation(caller, ref.sessionId, tx);
      const fenced =
        !observation.workspace?.result &&
        (await this.fencedHead(caller.projectId, observation.provenance, tx));
      if (fenced && 'commandId' in fenced) {
        const { parentOid: _parent, ...settled } = await this.capture(
          caller,
          { kind: 'code-commit', commandId: fenced.commandId },
          tx,
        );
        return { ...settled, ref };
      }
      if (
        fenced &&
        observation.workspace &&
        ('treeOid' in fenced || observation.workspace.attachment.headOid === fenced.headOid)
      ) {
        // No commit of this session holds the head the writer closed at. Either Code admitted
        // this session's final capture there, and its own record of that upload names the head
        // and tree, whether or not the machine lived to post the result; or the head is the one
        // the session attached at, so it left the checkout where it found it.
        const { attachment } = observation.workspace;
        return {
          ref,
          status: 'ready',
          provenance: observation.provenance,
          workspace: { ...attachment, ...fenced },
          attachedBaseOid: attachment.baseOid,
          observedAt: observation.observedAt,
          eventId: observation.eventId,
        };
      }
      return {
        ref,
        // A released session's host may still post its final workspace; a session that ended
        // before any host attached never will.
        status: observation.workspace?.result
          ? 'ready'
          : observation.workspaceMode === 'none'
            ? 'none'
            : observation.live || observation.provenance.hostRef !== null
              ? 'pending'
              : 'failed',
        provenance: observation.provenance,
        workspace: observation.workspace?.result ?? null,
        ...(observation.workspace
          ? { attachedBaseOid: observation.workspace.attachment.baseOid }
          : {}),
        observedAt: observation.observedAt,
        eventId: observation.eventId,
      };
    }
    const read = async (sql: Sql) => {
      const row = await sql.get<{
        command_json: string;
        status: string;
        receipt_json: string | null;
        error: string | null;
      }>(
        'SELECT command_json,status,receipt_json,error FROM code_commands WHERE id=? AND project_id=?',
        ref.commandId,
        caller.projectId,
      );
      check(row, 'code_capture_not_found', 'Code capture not found in this project', 404);
      const record = parseCodeInput(codeCommandRecordSchema, {
        command: JSON.parse(row.command_json),
        status: row.status,
        receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
        error: row.error,
      });
      const observation = await this.sessions.workspaceObservation(
        caller,
        record.command.sessionId,
        tx,
      );
      const p = observation.provenance,
        c = record.command,
        r = record.receipt;
      check(
        p.projectId === c.projectId &&
          p.sessionId === c.sessionId &&
          p.actorId === c.actorId &&
          p.instanceId === c.instanceId &&
          p.revision === c.expectedRevision &&
          p.runnerId === c.runnerId &&
          p.hostRef === c.hostRef,
        'code_capture_provenance',
        'Command provenance differs from its exact session',
        409,
      );
      if (r)
        check(
          r.commandId === c.id &&
            r.repositoryId === c.workspace.repositoryId &&
            r.workspaceId === c.workspace.workspaceId &&
            r.baseOid === c.workspace.baseOid &&
            r.parentOid === c.expectedHead,
          'code_capture_provenance',
          'Commit receipt differs from its exact command',
          409,
        );
      const [event] = await this.state.findEvents(
        { projectId: caller.projectId, subjectId: c.id, type: `code.command_${record.status}` },
        1,
      );
      return {
        ref,
        status: r
          ? 'ready'
          : record.status === 'failed' || record.status === 'cancelled'
            ? 'failed'
            : 'pending',
        provenance: p,
        workspace: r
          ? { ...c.workspace, headOid: r.headOid, treeOid: r.treeOid, stats: r.stats }
          : null,
        ...(r ? { parentOid: r.parentOid } : {}),
        observedAt: r ? (event?.createdAt ?? null) : null,
        eventId: r ? (event?.id ?? null) : null,
        ...(record.error ? { error: record.error } : {}),
      } satisfies CodeCapture;
    };
    return tx ? await read(tx) : await this.state.read(read);
  }
  /**
   * Where a closed writer left this session, read from Code's own records. The session's newest
   * commit that Code admitted at the head stands for its capture; else the final upload that
   * moved the head there, with its tree; else the head alone, which is the base if nothing moved
   * it. An operator's fence and a final admission both close the writer.
   */
  private async fencedHead(
    projectId: string,
    { instanceId, sessionId }: CodeCapture['provenance'],
    tx?: Transaction,
  ): Promise<{ commandId: string } | { headOid: string; treeOid?: string } | null> {
    const read = async (sql: Sql) => {
      const writer = await this.writers.row(sql, projectId, instanceId);
      if (writer?.writer_state !== 'closed' || writer.writer_session_id !== sessionId) return null;
      const row = await sql.get<{ id: string }>(
        "SELECT id FROM code_commands WHERE project_id=? AND session_id=? AND status='succeeded' AND (receipt_json::jsonb ->> 'headOid')=? ORDER BY _merv_rowid DESC LIMIT 1",
        projectId,
        sessionId,
        writer.head_oid,
      );
      if (row) return { commandId: row.id };
      const final = writer.head_operation_id
        ? await sql.get<{ payload_json: string }>(
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
        : { headOid: writer.head_oid ?? this.writers.base(writer) };
    };
    return tx ? await read(tx) : await this.state.read(read);
  }
  close() {
    this.closed = true;
  }
}
