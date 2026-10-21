import {
  check,
  parsed,
  idSchema,
  type Caller,
  type CodeCommandRecord,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Session, Sessions } from '@merv/sessions/types';
import { postgresMigrations } from './commands.postgres.js';
import type { CodeCommands } from './types.js';

/** Historical command receipts and Code Work operator receipts keep their published schema. */
export async function migrateCommands(state: State): Promise<void> {
  await state.migrate('code_commands', postgresMigrations);
}
type Row = {
  id: string;
  project_id: string;
  session_id: string;
  command_json: string;
  status: CodeCommandRecord['status'];
  receipt_json: string | null;
  error: string | null;
};
const RECENT_COMMITS = 200;
const parse = (schema: typeof idSchema, input: unknown) =>
  parsed(schema, input, 'invalid_code_input', {
    nodes: 128,
    depth: 8,
    bytes: 16384,
    strings: 'json',
    undefined: 'reject',
    nullPrototype: false,
  });

/** Read-only access to commands retained by earlier runtimes. New work uses ordinary Git. */
export class CodeCommandService implements CodeCommands {
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
  ) {}
  async initialize(): Promise<void> {
    await migrateCommands(this.state);
  }
  private async transaction<T>(fn: (tx: Transaction) => T): Promise<T> {
    check(!this.closed, 'code_unavailable', 'Code command history is unavailable', 503);
    const tx = this.state.ambient;
    return tx ? await fn(tx) : await this.state.transaction(fn);
  }
  private decode(row: Row): CodeCommandRecord {
    return {
      command: JSON.parse(row.command_json),
      status: row.status,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
      error: row.error,
    };
  }
  private async reader(caller: Caller, tx: Transaction): Promise<Session | undefined> {
    await this.scope.require(caller, 'read', tx);
    return caller.session ? await this.sessions.session(caller) : undefined;
  }
  async list(caller: Caller): Promise<CodeCommandRecord[]> {
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const sessionId = (await this.reader(caller, tx))?.id;
      return (
        await tx.all<Row>(
          `SELECT * FROM code_commands WHERE project_id=?${sessionId ? ' AND session_id=?' : ''} ORDER BY _merv_rowid DESC LIMIT 100`,
          caller.projectId,
          ...(sessionId ? [sessionId] : []),
        )
      ).map((row) => this.decode(row));
    });
  }
  /**
   * The newest commit that succeeded for one unit of work, whose stats say where its work has
   * got to since its base. A pure read for the Running page, asked on every poll of an open
   * sidebar. The unit is named only inside the command, where no index reaches, so only the
   * project's newest commits are read: a unit whose last one is further back than those is
   * told without its stats, rather than every command the project ran being decoded.
   */
  async newestReceipt(
    sql: Sql,
    projectId: string,
    instanceId: string,
  ): Promise<CodeCommandRecord | null> {
    const row = await sql.get<Row>(
      `SELECT * FROM (SELECT * FROM code_commands WHERE project_id=? AND status='succeeded' ORDER BY _merv_rowid DESC LIMIT ${RECENT_COMMITS}) recent WHERE (command_json::jsonb ->> 'instanceId')=? ORDER BY _merv_rowid DESC LIMIT 1`,
      projectId,
      instanceId,
    );
    return row ? this.decode(row) : null;
  }
  async operation(caller: Caller, commandId: string): Promise<CodeCommandRecord> {
    caller = structuredClone(caller);
    const id = parse(idSchema, commandId);
    return await this.transaction(async (tx) => {
      const session = await this.reader(caller, tx);
      const row = await tx.get<Row>('SELECT * FROM code_commands WHERE id=?', id);
      // A worker reads the commands of its own unit of work: its own, earlier rounds', and,
      // for the unit's reviewer, the commit the delivery it checks names.
      const record = row && row.project_id === caller.projectId ? this.decode(row) : null;
      check(
        record &&
          (!session ||
            row!.session_id === session.id ||
            record.command.instanceId === session.instanceId),
        'code_command_not_found',
        id.startsWith('cop_')
          ? 'code.operation reads a historical codecmd_ receipt; a cop_ id is a store operation listed by code.status'
          : 'No code command with this id belongs to this project, or, for a worker, to its unit of work',
        404,
      );
      return record!;
    });
  }
  close(): void {
    this.closed = true;
  }
}
