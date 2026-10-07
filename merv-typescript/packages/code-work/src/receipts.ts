import { canonical, RequestJournal, type Sql } from '@merv/contracts';

/** An administrator's replayable request to Code Work, kept with what it asked in its receipts. */
export class CodeWorkReceipt extends RequestJournal {
  constructor(tx: Sql, projectId: string, principal: string, requestId: string, inputHash: string) {
    super(
      tx,
      { table: 'code_work_receipts', actor: 'principal_scope', result: 'result_json' },
      projectId,
      principal,
      requestId,
      inputHash,
    );
  }

  complete(id: string, kind: string, payload: unknown, result: unknown, at: string) {
    return this.record(canonical(result), {
      id,
      kind,
      payload_json: canonical(payload),
      created_at: at,
    });
  }
}
