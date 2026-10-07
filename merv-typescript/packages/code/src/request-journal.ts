import { canonical, check, type Sql } from '@merv/contracts';

type Replay = { input_hash: string; result_json: string };

/**
 * A request replayed by its id: the same input answers what it answered, other input is
 * refused. Code's operations and Code Work's operator receipts are two tables of it; an
 * operation also carries its status and completion time. Completion runs in the caller's
 * transaction.
 */
export class RequestJournal {
  constructor(
    private readonly tx: Sql,
    private readonly projectId: string,
    private readonly principal: string,
    private readonly requestId: string,
    private readonly inputHash: string,
    private readonly table: 'code_operations' | 'code_work_receipts' = 'code_operations',
  ) {}

  async previous<T extends { input_hash: string } = Replay>(
    columns = 'input_hash,result_json',
  ): Promise<T | undefined> {
    const previous = await this.tx.get<T>(
      `SELECT ${columns} FROM ${this.table} WHERE project_id=? AND principal_scope=? AND request_id=?`,
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
    const operation = this.table === 'code_operations' ? ['completed', at] : [];
    return this.tx.run(
      `INSERT INTO ${this.table} (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,result_json,created_at${operation.length ? ',status,completed_at' : ''}) VALUES (?,?,?,?,?,?,?,?,?${',?'.repeat(operation.length)})`,
      id,
      this.projectId,
      this.principal,
      this.requestId,
      kind,
      this.inputHash,
      canonical(payload),
      canonical(result),
      at,
      ...operation,
    );
  }
}
