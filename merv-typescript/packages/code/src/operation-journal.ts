import { canonical, check, type Transaction } from '@merv/contracts';

type Replay = { input_hash: string; result_json: string };

/** Replay and completed receipts in an existing caller-owned Code transaction. */
export class OperationJournal {
  constructor(
    private readonly tx: Transaction,
    private readonly projectId: string,
    private readonly principal: string,
    private readonly requestId: string,
    private readonly inputHash: string,
  ) {}

  async previous<T extends { input_hash: string } = Replay>(
    columns = 'input_hash,result_json',
  ): Promise<T | undefined> {
    const previous = await this.tx.get<T>(
      `SELECT ${columns} FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?`,
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

  complete(
    id: string,
    kind: string,
    payload: unknown,
    result: unknown,
    createdAt: string,
    completedAt = createdAt,
  ) {
    return this.tx.run(
      'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      this.projectId,
      this.principal,
      this.requestId,
      kind,
      this.inputHash,
      canonical(payload),
      'completed',
      canonical(result),
      createdAt,
      completedAt,
    );
  }
}
