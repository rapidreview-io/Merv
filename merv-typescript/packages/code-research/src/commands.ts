import { z } from 'zod';
import {
  canonical,
  check,
  codeCommandCompletionSchema,
  codeCommandControlSchema,
  codeCommitInputSchema,
  codeMergeInputSchema,
  type CodeMergeInput,
  digest,
  newId,
  now,
  parsed,
  type Caller,
  type CodeCommandCompletion,
  type CodeCommandControl,
  type CodeCommandRecord,
  type CodeCommitCommand,
  type CodeCommitInput,
  type Data,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Session, Sessions } from '@merv/sessions/types';
import { pendingMerge } from '@merv/code/pending-merge';
import { postgresMigrations } from './commands.postgres.js';
import type { CodeCommands } from './types.js';

type Row = {
  id: string;
  project_id: string;
  session_id: string;
  actor_id: string;
  request_id: string;
  input_hash: string;
  command_json: string;
  status: CodeCommandRecord['status'];
  receipt_json: string | null;
  error: string | null;
};
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const terminal = (status: Row['status']) =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';
const live = (session: Session) => session.status === 'offered' || session.status === 'active';

// Share the bounded, descriptor-safe JSON parser used by the other service inputs.
const parse = <T>(schema: z.ZodType<T>, input: unknown): T =>
  parsed(schema, input, 'invalid_code_input', {
    nodes: 128,
    depth: 8,
    bytes: 16_384,
    strings: 'json',
    undefined: 'reject',
    nullPrototype: false,
  });

/** Durable server commands. Git execution and object verification belong to the runner. */
export class CodeCommandService implements CodeCommands {
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
  ) {
    this.initialize = async () => {
      await state.migrate('code_commands', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
      ]);
    };
  }

  private async transaction<T>(fn: (tx: Transaction) => T): Promise<T> {
    check(!this.closed, 'code_unavailable', 'Code commands are unavailable', 503);
    return await this.state.read(async (sql) =>
      'transactionId' in sql ? fn(sql as Transaction) : await this.state.transaction(fn),
    );
  }
  private decode(row: Row): CodeCommandRecord {
    return {
      command: JSON.parse(row.command_json),
      status: row.status,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
      error: row.error,
    };
  }
  private async row(tx: Transaction, id: string): Promise<Row> {
    const row = await tx.get<Row>('SELECT * FROM code_commands WHERE id=?', id);
    check(row, 'code_command_not_found', 'Code command not found', 404);
    return row;
  }
  private async reader(caller: Caller, tx: Transaction): Promise<string | undefined> {
    await this.scope.require(caller, 'read', tx);
    return caller.session ? (await this.sessions.describe(caller)).id : undefined;
  }
  private writable(session: Session): void {
    check(session.status === 'active', 'session_closed', 'An active session is required', 409);
    check(
      !session.execution.policy.readOnly,
      'code_read_only',
      'A read-only session cannot commit code',
      403,
    );
    check(
      session.hostRef && session.workspace,
      'code_workspace_required',
      'An attached Git workspace is required',
      409,
    );
    check(
      session.workspace.result === null,
      'code_workspace_closed',
      'The workspace has already been captured',
      409,
    );
    check(
      session.execution.policy.tools.some((tool) => tool.name === 'code.commit'),
      'execution_tool_forbidden',
      'The session does not grant code.commit',
      403,
    );
  }
  private async authorizeCommit(
    caller: Caller,
    input: CodeCommitInput | CodeMergeInput,
    tool = 'code.commit',
  ): Promise<void> {
    const data: Data = { ...input };
    if (caller.session?.invocationId) await this.sessions.validate(caller, tool, data);
    else {
      const invocation = await this.sessions.prepare(caller, tool, data);
      try {
        await this.sessions.validate(invocation.caller, tool, data);
      } finally {
        await this.sessions.cancel(invocation);
      }
    }
  }
  private async controlled(caller: Caller, input: CodeCommandControl): Promise<Session> {
    check(!caller.session, 'session_forbidden', 'Session credentials cannot control runners', 403);
    const session = await this.sessions.get(caller, input.sessionId);
    check(
      session.runnerId === input.runnerId && session.hostRef === input.hostRef,
      'session_forbidden',
      'Command control belongs to another runner or launch',
      403,
    );
    return session;
  }
  private async event(
    tx: Transaction,
    command: CodeCommitCommand,
    status: Row['status'],
  ): Promise<void> {
    await this.state.appendEvent(tx, {
      projectId: command.projectId,
      actorId: command.actorId,
      type: `code.command_${status}`,
      subjectId: command.id,
      data: {
        source: { kind: 'session', sessionId: command.sessionId },
        instanceId: command.instanceId,
        expectedRevision: command.expectedRevision,
        repositoryId: command.workspace.repositoryId,
        workspaceId: command.workspace.workspaceId,
      },
    });
  }

  async list(caller: Caller): Promise<CodeCommandRecord[]> {
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const sessionId = await this.reader(caller, tx);
      return (
        await tx.all<Row>(
          `SELECT * FROM code_commands WHERE project_id=?${sessionId ? ' AND session_id=?' : ''} ORDER BY _merv_rowid DESC LIMIT 100`,
          caller.projectId,
          ...(sessionId ? [sessionId] : []),
        )
      ).map((row) => this.decode(row));
    });
  }
  async operation(caller: Caller, commandId: string): Promise<CodeCommandRecord> {
    caller = structuredClone(caller);
    const id = parse(identifier, commandId);
    return await this.transaction(async (tx) => {
      const sessionId = await this.reader(caller, tx);
      const row = await this.row(tx, id);
      check(
        row.project_id === caller.projectId && (!sessionId || row.session_id === sessionId),
        'code_command_not_found',
        'Code command not found',
        404,
      );
      return this.decode(row);
    });
  }
  async commit(caller: Caller, value: CodeCommitInput): Promise<CodeCommandRecord> {
    return await this.enqueue(caller, parse(codeCommitInputSchema, value));
  }
  async merge(caller: Caller, value: CodeMergeInput): Promise<CodeCommandRecord> {
    return await this.enqueue(caller, parse(codeMergeInputSchema, value));
  }
  private async enqueue(
    caller: Caller,
    input: CodeCommitInput | CodeMergeInput,
  ): Promise<CodeCommandRecord> {
    caller = structuredClone(caller);
    const merge = 'operation' in input ? input.operation : undefined;
    return await this.transaction(async (tx) => {
      check(caller.session, 'session_required', 'Only a worker session can request a commit', 403);
      await this.scope.require(caller, 'write', tx);
      const session = await this.sessions.describe(caller);
      this.writable(session);
      await this.authorizeCommit(caller, input, merge ? 'code.merge' : 'code.commit');
      const pending = merge ? await pendingMerge(tx, caller.projectId, session.instanceId) : null;
      if (merge)
        check(
          pending &&
            session.execution.policy.tools.some((tool) => tool.name === 'code.merge') &&
            session.workspace?.attachment.pendingMerge?.plan === pending.plan,
          'code_merge_forbidden',
          'Only a merge-capable assignment may operate its frozen merge',
          403,
        );
      const hash = digest(input);
      const prior = await tx.get<Row>(
        'SELECT * FROM code_commands WHERE session_id=? AND request_id=?',
        session.id,
        input.requestId,
      );
      if (prior) {
        check(
          prior.input_hash === hash,
          'code_request_conflict',
          'The request ID already identifies different commit input',
          409,
        );
        return this.decode(prior);
      }
      if (merge)
        check(
          !pending!.firstMerge,
          'code_merge_completed',
          'The planned merge is already complete; later rounds use code.commit',
          409,
        );
      check(
        !(await tx.get(
          "SELECT id FROM code_commands WHERE session_id=? AND status IN ('queued','dispatched')",
          session.id,
        )),
        'code_command_pending',
        'The session already has an outstanding code command',
        409,
      );
      check(
        input.expectedHead.length === session.workspace!.attachment.baseOid.length,
        'code_object_format',
        'The expected head must use the workspace Git object format',
      );
      const command: CodeCommitCommand = {
        id: newId('codecmd'),
        projectId: session.projectId,
        sessionId: session.id,
        actorId: session.actorId,
        instanceId: session.instanceId,
        expectedRevision: session.expectedRevision,
        runnerId: session.runnerId,
        hostRef: session.hostRef!,
        workspace: session.workspace!.attachment,
        ...(merge ? { merge } : {}),
        expectedHead: input.expectedHead,
        message: input.message,
        createdAt: now(),
      };
      await this.scope.require(caller, 'write', tx);
      await tx.run(
        `INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status)
         VALUES (?,?,?,?,?,?,?,'queued')`,
        command.id,
        command.projectId,
        command.sessionId,
        command.actorId,
        input.requestId,
        hash,
        canonical(command),
      );
      await this.event(tx, command, 'queued');
      return this.decode(await this.row(tx, command.id));
    });
  }
  async nextCommand(caller: Caller, value: CodeCommandControl): Promise<CodeCommitCommand | null> {
    caller = structuredClone(caller);
    const input = parse(codeCommandControlSchema, value);
    return await this.transaction(async (tx) => {
      const session = await this.controlled(caller, input);
      const row = await tx.get<Row>(
        "SELECT * FROM code_commands WHERE session_id=? AND status IN ('queued','dispatched')",
        session.id,
      );
      if (!row) return null;
      const { command } = this.decode(row);
      if (!live(session)) {
        // Recover an already-issued descriptor after a lost response. This records no
        // new dispatch; the runner may reconcile its stopped/fenced Git outcome only.
        if (row.status === 'dispatched') return command;
        if (row.status === 'queued') {
          await tx.run(
            "UPDATE code_commands SET status='cancelled',error='session_closed' WHERE id=?",
            row.id,
          );
          await this.event(tx, command, 'cancelled');
        }
        return null;
      }
      this.writable(session);
      if (row.status === 'queued') {
        await tx.run("UPDATE code_commands SET status='dispatched' WHERE id=?", row.id);
        await this.event(tx, command, 'dispatched');
      }
      return command;
    });
  }
  async completeCommand(caller: Caller, value: CodeCommandCompletion): Promise<CodeCommandRecord> {
    caller = structuredClone(caller);
    const input = parse(codeCommandCompletionSchema, value);
    return await this.transaction(async (tx) => {
      const session = await this.controlled(caller, input);
      const row = await this.row(tx, input.commandId);
      check(
        row.session_id === session.id && row.project_id === session.projectId,
        'code_command_not_found',
        'Code command not found',
        404,
      );
      const record = this.decode(row);
      const receipt = 'receipt' in input ? input.receipt : null;
      const error = 'error' in input ? input.error : null;
      if (receipt) {
        check(
          receipt.commandId === record.command.id &&
            receipt.repositoryId === record.command.workspace.repositoryId &&
            receipt.workspaceId === record.command.workspace.workspaceId &&
            receipt.baseOid === record.command.workspace.baseOid &&
            receipt.parentOid === record.command.expectedHead,
          'code_receipt_conflict',
          'The receipt does not describe the dispatched command',
          409,
        );
      }
      const status = receipt ? 'succeeded' : 'failed';
      if (terminal(row.status)) {
        check(
          record.status === status &&
            canonical(record.receipt) === canonical(receipt) &&
            record.error === error,
          'code_result_conflict',
          'The command already has a different terminal result',
          409,
        );
        return record;
      }
      check(
        row.status === 'dispatched',
        'code_not_dispatched',
        'The runner must claim the command before reporting a result',
        409,
      );
      await tx.run(
        'UPDATE code_commands SET status=?,receipt_json=?,error=? WHERE id=?',
        status,
        receipt ? canonical(receipt) : null,
        error ?? null,
        row.id,
      );
      await this.event(tx, record.command, status);
      return this.decode(await this.row(tx, row.id));
    });
  }
  close(): void {
    this.closed = true;
  }
}
