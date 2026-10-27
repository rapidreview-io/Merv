import { check, type DelegationSource, type Transaction } from '@merv/contracts';
import type { IssueRefs, Issues } from '@merv/contracts/issues';
import type { QuestionResponse } from './models.js';
import type { MessageHost, QuestionRow } from './messages.js';
import type { QuestionResponder, ThreadQuestion } from './types.js';

export interface ResponseRow {
  question_id: string;
  responder: string;
  data_json: string;
  state: QuestionResponse['state'];
  deadline: string;
  receipt_json: string | null;
}
const INTERVAL = 30_000;
const DEADLINE = 15 * 60_000;
const SILENT = 'The responder did not respond.';
/** Why a question reached its owner after all: Pi's own judgement, or its responder's failure. */
export type NeedsYouCause =
  'pi' | 'responder_unloaded' | 'responder_deadline' | 'responder_silent' | 'responder_failed';
/** A question's issues name its asking visit. */
export const questionRefs = (row: QuestionRow): IssueRefs => ({
  projectId: row.project_id,
  sessionId: row.session_id,
  threadId: row.thread_id,
  instanceId: row.instance_id,
  revision: Number(row.revision),
  questionId: row.id,
});
/** An answer, or its work moving on, ends the question's issues. */
export const settled = (issues: Issues, id: string) => {
  for (const code of ['asked', 'needs_you'])
    issues.resolve({ class: 'question', where: 'session.ask_owner', code, key: id });
};

/** A narrow durable delivery slot for a question, serviced by Sessions' existing upkeep. */
export class QuestionResponders {
  private responder?: QuestionResponder;
  private running?: Promise<void>;
  /** Questions no responder took that no longer stand, settled once by this process. */
  private readonly lapsed = new Set<string>();
  constructor(
    private readonly host: MessageHost,
    private readonly clock: () => number,
    private readonly standing: (tx: Transaction, question: QuestionRow) => Promise<boolean>,
    private readonly report: (project: string, instance: string, tx: Transaction) => Promise<void>,
    private readonly view: (row: QuestionRow, open: boolean) => ThreadQuestion,
  ) {}
  register(responder: QuestionResponder): () => Promise<void> {
    check(
      !this.responder,
      'question_responder_registered',
      'A question responder is already registered',
      409,
    );
    this.responder = responder;
    return async () => {
      if (this.responder !== responder) return;
      this.responder = undefined;
      // Unloading cannot leave questions hidden until their investigation deadline.
      await this.host.transaction(async (tx) => {
        const rows = await tx.all<QuestionRow>(
          `SELECT q.* FROM session_questions q JOIN session_question_responses r ON r.question_id=q.id WHERE r.state='investigating' AND r.responder=?`,
          responder.name,
        );
        for (const row of rows)
          await this.finish(
            tx,
            row,
            'needs_you',
            'The responder became unavailable.',
            'responder_unloaded',
          );
      });
    };
  }
  /** Whether a responder took the question. */
  async reserve(tx: Transaction, id: string): Promise<boolean> {
    if (!this.responder) return false;
    const response: QuestionResponse = { state: 'investigating', label: this.responder.label };
    await tx.run(
      `INSERT INTO session_question_responses(question_id,responder,data_json,state,deadline,check_at) VALUES(?,?,?,'investigating',?,?)`,
      id,
      this.responder.name,
      JSON.stringify(response),
      new Date(this.clock() + DEADLINE).toISOString(),
      new Date(this.clock()).toISOString(),
    );
    return true;
  }
  async read(tx: Transaction, id: string): Promise<ResponseRow | undefined> {
    return await tx.get<ResponseRow>(
      'SELECT * FROM session_question_responses WHERE question_id=?',
      id,
    );
  }
  async finish(
    tx: Transaction,
    question: QuestionRow,
    state: QuestionResponse['state'],
    reason?: string,
    cause?: NeedsYouCause,
  ): Promise<void> {
    const row = await this.read(tx, question.id);
    if (!row) return;
    const response: QuestionResponse = {
      ...JSON.parse(row.data_json),
      state,
      ...(reason ? { reason } : {}),
    };
    await tx.run(
      'UPDATE session_question_responses SET state=?,data_json=? WHERE question_id=?',
      state,
      JSON.stringify(response),
      question.id,
    );
    await this.report(question.project_id, question.instance_id, tx);
    const { issues } = this.host;
    if (state !== 'needs_you') return settled(issues, question.id);
    const refs = questionRefs(question);
    issues.report({
      class: 'question',
      where: 'session.ask_owner',
      code: 'needs_you',
      key: question.id,
      level: 'severe',
      refs,
    });
    if (cause && cause !== 'pi')
      issues.report({
        class: 'platform',
        where: 'sessions.question_responder',
        code: cause,
        level: 'severe',
        subject: question.id,
        refs,
      });
  }
  sweep(): Promise<void> {
    if (!this.running)
      this.running = this.pass().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  /**
   * A question that reached its owner, or that no responder took, goes obsolete when its work
   * moves on, which no Sessions call sees: each pass settles those that no longer stand.
   */
  private async lapse(): Promise<void> {
    const gone = await this.host.reading(async (tx) => {
      const open = await tx.all<QuestionRow & { state: string | null }>(
        `SELECT q.*,r.state FROM session_questions q LEFT JOIN session_question_responses r ON r.question_id=q.id WHERE q.answered_at IS NULL AND (r.state IS NULL OR r.state='needs_you')`,
      );
      const rows = [];
      for (const row of open)
        if (!this.lapsed.has(row.id) && !(await this.standing(tx, row))) rows.push(row);
      return rows;
    });
    for (const row of gone)
      if (row.state) {
        await this.host.transaction(async (tx) => {
          if ((await this.read(tx, row.id))?.state === 'needs_you')
            await this.finish(tx, row, 'obsolete');
        });
      } else {
        settled(this.host.issues, row.id);
        this.lapsed.add(row.id);
      }
  }
  private async pass(): Promise<void> {
    await this.lapse();
    // No writer lock for the common idle case; the partial index reads only active deliveries.
    const due = await this.host.reading((tx) =>
      tx.get(
        "SELECT 1 FROM session_question_responses WHERE state='investigating' AND check_at<=? LIMIT 1",
        new Date(this.clock()).toISOString(),
      ),
    );
    if (!due) return;
    // Claim only due investigations. A restarted server can retry a launch with its stable ID.
    const batch = await this.host.transaction(async (tx) => {
      const rows = await tx.all<QuestionRow & ResponseRow>(
        `SELECT q.*,r.* FROM session_question_responses r JOIN session_questions q ON q.id=r.question_id WHERE r.state='investigating' AND r.check_at<=? ORDER BY r.check_at LIMIT 16 FOR UPDATE OF r SKIP LOCKED`,
        new Date(this.clock()).toISOString(),
      );
      const pending: { question: QuestionRow & ResponseRow; source: DelegationSource }[] = [];
      for (const row of rows) {
        if (row.answered_at || !(await this.standing(tx, row))) {
          await this.finish(tx, row, row.answered_at ? 'answered' : 'obsolete');
        } else if (
          !this.responder ||
          this.responder.name !== row.responder ||
          Date.parse(row.deadline) <= this.clock()
        ) {
          await this.finish(
            tx,
            row,
            'needs_you',
            'The investigation is unavailable or exceeded its time limit.',
            Date.parse(row.deadline) <= this.clock() ? 'responder_deadline' : 'responder_unloaded',
          );
        } else {
          await tx.run(
            'UPDATE session_question_responses SET check_at=? WHERE question_id=?',
            new Date(this.clock() + INTERVAL).toISOString(),
            row.id,
          );
          const session = this.host.decode(await this.host.row(tx, row.session_id));
          pending.push({ question: row, source: session.source });
        }
      }
      return pending;
    });
    await Promise.all(
      batch.map(async ({ question, source }) => {
        const responder = this.responder;
        if (!responder || responder.name !== question.responder) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const run = async () => {
            const data: QuestionResponse = JSON.parse(question.data_json);
            if (data.reference) return await responder.inspect(source, data.reference);
            await responder.start({
              question: this.view(question, true),
              source,
              attach: async (reference) => {
                check(
                  reference.id.length > 0 &&
                    reference.route.startsWith('/') &&
                    !reference.route.startsWith('//'),
                  'invalid_question_reference',
                  'A local conversation reference is required',
                );
                return await this.host.transaction(async (tx) => {
                  const current = await this.read(tx, question.id);
                  if (
                    this.responder !== responder ||
                    current?.state !== 'investigating' ||
                    !(await this.standing(tx, question))
                  )
                    return false;
                  const value: QuestionResponse = { ...JSON.parse(current.data_json), reference };
                  await tx.run(
                    'UPDATE session_question_responses SET data_json=? WHERE question_id=?',
                    JSON.stringify(value),
                    question.id,
                  );
                  return true;
                });
              },
            });
            return null;
          };
          // Bound provider calls too: an unavailable transport cannot stall Sessions upkeep.
          const reason = await Promise.race([
            run(),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve(SILENT), 10_000);
            }),
          ]);
          // Else its investigation said why it stopped.
          if (reason)
            await this.fallback(
              question,
              reason,
              reason === SILENT ? 'responder_silent' : 'responder_failed',
            );
        } catch {
          await this.fallback(
            question,
            'The investigation could not continue. You can answer directly or continue its conversation.',
            'responder_failed',
          );
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }
  private async fallback(
    question: QuestionRow,
    reason: string,
    cause: NeedsYouCause,
  ): Promise<void> {
    await this.host.transaction(async (tx) => {
      if ((await this.read(tx, question.id))?.state === 'investigating')
        await this.finish(tx, question, 'needs_you', reason, cause);
    });
  }
}
