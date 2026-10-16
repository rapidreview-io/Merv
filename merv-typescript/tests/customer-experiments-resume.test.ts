import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerService } from '../packages/customer-experiments/src/service.js';
import type { RequestRecord } from '../packages/customer-experiments/src/store.js';

/** A paid external run whose worker stopped to ask; Pi's responder may still be on it. */
function harness(
  question: { askedMinutesAgo: number } | null,
  { live = 0, investigating = false } = {},
) {
  const record = {
    id: 'ce_1',
    projectId: 'project_1',
    experimentId: 'wf_1',
    resumed: [] as string[],
  } as unknown as RequestRecord;
  const sent: { threadId: string; body: string; requestId: string }[] = [];
  const store = {
    list: async () => [record],
    mutate: async (_id: string, change: (r: RequestRecord) => void) => change(record),
    state: {
      read: async (read: (sql: unknown) => unknown) =>
        read({
          get: async (query: string) =>
            query.includes('session_question_responses')
              ? investigating
                ? { state: 'investigating' }
                : undefined
              : question && {
                  id: 'q_1',
                  thread_id: 'thr_1',
                  asked_at: new Date(Date.now() - question.askedMinutesAgo * 60_000).toISOString(),
                },
        }),
    },
  };
  const exp = { id: 'wf_1', workflow: { version: 3, state: 'running', data: {} } };
  const domain = {
    reconcile: async () => exp,
    sessions: {
      usage: async () => ({ liveSessions: live, budgets: [] }),
      messaging: {
        message: async (_caller: unknown, input: (typeof sent)[number]) => sent.push(input),
      },
    },
  };
  const service = new CustomerService(
    store as never,
    domain as never,
    { caller: async () => ({ projectId: 'project_1' }) } as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    { publicOrigin: 'https://merv.example', sponsor: { issuer: 'i', subject: 's' } } as never,
  );
  return { service, sent, record, exp };
}

test('the service resumes a stalled external run once Pi has stopped investigating', async () => {
  const early = harness({ askedMinutesAgo: 3 });
  await early.service.reconcile();
  assert.equal(early.sent.length, 0, 'released machines get time to stop first');

  const busy = harness({ askedMinutesAgo: 12 }, { investigating: true });
  await busy.service.reconcile();
  assert.equal(busy.sent.length, 0, "Pi's responder goes first");

  const due = harness({ askedMinutesAgo: 12 });
  await due.service.reconcile();
  await due.service.reconcile();
  assert.equal(due.sent.length, 1, 'one answer per question');
  assert.equal(due.sent[0]!.threadId, 'thr_1');
  assert.match(due.sent[0]!.body, /carry on by yourself/);
  assert.match(due.sent[0]!.body, /Modal first, then Lambda/);
  assert.deepEqual(due.record.resumed, ['q_1']);

  const spent = harness({ askedMinutesAgo: 30 });
  spent.record.resumed = ['a', 'b', 'c'];
  await spent.service.reconcile();
  assert.equal(spent.sent.length, 0, 'after three it waits for a person');

  const live = harness({ askedMinutesAgo: 30 }, { live: 1 });
  await live.service.reconcile();
  assert.equal(live.sent.length, 0, 'a live session is not stalled');

  const review = harness({ askedMinutesAgo: 30 });
  review.exp.workflow.state = 'results_review';
  await review.service.reconcile();
  assert.equal(review.sent.length, 0, 'only running work is resumed');

  const quiet = harness(null);
  await quiet.service.reconcile();
  assert.equal(quiet.sent.length, 0);
});
