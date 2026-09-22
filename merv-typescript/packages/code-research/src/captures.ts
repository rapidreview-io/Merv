import { z } from 'zod';
import {
  check,
  codeCommandRecordSchema,
  type Caller,
  type Scope,
  type State,
  type Transaction,
  type Sql,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { CodeCapture, CodeCaptureRef } from './types.js';
import { parseCodeInput } from '@merv/code/input';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const codeCaptureRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session-final'), sessionId: id }).strict(),
  z.object({ kind: z.literal('code-commit'), commandId: id }).strict(),
]);
/** A reader over records owned by Code and Sessions, not another mutable head ledger. */
export class CodeCaptureReader {
  private closed = false;
  constructor(
    private state: State,
    private scope: Scope,
    private sessions: Sessions,
  ) {}
  async capture(caller: Caller, value: CodeCaptureRef, tx?: Transaction): Promise<CodeCapture> {
    check(!this.closed, 'code_unavailable', 'Code capture reader is unavailable', 503);
    caller = structuredClone(caller);
    const ref = parseCodeInput(codeCaptureRefSchema, value);
    if (tx) this.state.assertTransaction(tx);
    await this.scope.require(caller, 'read', tx);
    if (ref.kind === 'session-final') {
      const observation = await this.sessions.workspaceObservation(caller, ref.sessionId, tx);
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
      const event = await sql.get<{ id: number; created_at: string }>(
        'SELECT id,created_at FROM events WHERE project_id=? AND subject_id=? AND type=? ORDER BY id LIMIT 1',
        caller.projectId,
        c.id,
        `code.command_${record.status}`,
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
        observedAt: r ? (event?.created_at ?? null) : null,
        eventId: r ? (event?.id ?? null) : null,
        ...(record.error ? { error: record.error } : {}),
      } satisfies CodeCapture;
    };
    return tx ? await read(tx) : await this.state.read(read);
  }
  close() {
    this.closed = true;
  }
}
