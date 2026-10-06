import { canonical, check, type Sql, type State } from '@merv/contracts';
import { postgresMigrations } from './commands.postgres.js';

/** Code Work's own storage, which its operator receipts live in; every caller migrates it. */
export async function migrateCommands(state: State): Promise<void> {
  await state.migrate('code_commands', postgresMigrations);
}

/**
 * An administrator's request to Code Work, replayed by its request id: the same input answers
 * what it answered, other input is refused. Completion runs in the caller's transaction.
 */
export class OperatorReceipt {
  constructor(
    private readonly tx: Sql,
    private readonly projectId: string,
    private readonly principal: string,
    private readonly requestId: string,
    private readonly inputHash: string,
  ) {}

  async previous(): Promise<{ result_json: string } | undefined> {
    const previous = await this.tx.get<{ input_hash: string; result_json: string }>(
      'SELECT input_hash,result_json FROM code_work_receipts WHERE project_id=? AND principal_scope=? AND request_id=?',
      this.projectId,
      this.principal,
      this.requestId,
    );
    check(
      !previous || previous.input_hash === this.inputHash,
      'request_conflict',
      'This request id was used with different input',
      409,
    );
    return previous;
  }

  complete(id: string, kind: string, payload: unknown, result: unknown, at: string) {
    return this.tx.run(
      'INSERT INTO code_work_receipts (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      this.projectId,
      this.principal,
      this.requestId,
      kind,
      this.inputHash,
      canonical(payload),
      canonical(result),
      at,
    );
  }
}
