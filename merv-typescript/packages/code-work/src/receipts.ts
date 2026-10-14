import {
  canonical,
  check,
  digest,
  RequestJournal,
  type Caller,
  type Scope,
  type Transaction,
} from '@merv/contracts';

/** An administrator's replayable request to Code Work, kept with what it asked in its receipts. */
export class CodeWorkReceipt extends RequestJournal {
  /** The journal of an administrator's request, `body` without its id; a leased worker is refused. */
  static async open(
    scope: Scope,
    tx: Transaction,
    caller: Caller,
    requestId: string,
    body: unknown,
    refusal: string,
  ) {
    await scope.require(caller, 'admin', tx);
    check(!caller.session, 'session_forbidden', refusal, 403);
    const receipts = {
      table: 'code_work_receipts',
      actor: 'principal_scope',
      result: 'result_json',
    };
    const principal = `actor:${caller.actorId}`;
    return new CodeWorkReceipt(tx, receipts, caller.projectId, principal, requestId, digest(body));
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
