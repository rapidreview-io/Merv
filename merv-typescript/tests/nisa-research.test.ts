import test from 'node:test';
import assert from 'node:assert/strict';
import { NisaService } from '../packages/nisa/src/index.js';
import { researchResult, researchScope } from '../packages/nisa/src/research.js';
import { nisaTools } from '../packages/nisa/src/tools.js';
import { provider, keyEnv } from './fixtures/web.js';
import { execution } from '../packages/experiments/src/execution-policy.js';
import { taskExecutionPolicy } from '../packages/tasks/src/execution-policy.js';
const caller = {
  actorId: 'agent',
  projectId: 'project',
  session: { id: 'visit', threadId: 'thread' },
};
const op = 'op_' + 'a'.repeat(32);
const session = 'qa_' + 'b'.repeat(32);

test('research delegates directly, scopes requests, bounds reports, and keeps stable retry IDs', async (t) => {
  const fake = await provider(t, () => ({
    body: {
      operationId: op,
      sessionId: session,
      status: 'completed',
      terminal: true,
      cancelRequested: false,
      failure: null,
      result: {
        answer: 'x'.repeat(15000),
        research_id: op,
        usage: { prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0, cost_usd: 0.01 },
      },
    },
  }));
  const env = keyEnv(t, 'rr_sk_' + 'x'.repeat(43));
  let auth = 0;
  const nisa = new NisaService({ origin: fake.origin, keyEnv: env }, async () => {
    auth++;
  });
  t.after(() => nisa.close());
  const first = await nisa.research(caller, {
    action: 'start',
    brief: 'Investigate papers',
    request_id: 'stable',
  });
  assert.equal(first.next_answer_offset, 12000);
  assert.equal(first.answer.length, 12000);
  assert.equal(fake.seen[0].path, '/api/research');
  assert.equal(fake.seen[0].body.scope, researchScope(caller));
  assert.equal(fake.seen[0].body.request_id, 'stable');
  const last = await nisa.research(caller, {
    action: 'status',
    operation_id: op,
    answer_offset: 12000,
  });
  assert.equal(last.answer.length, 3000);
  assert.equal(auth, 6);
  const tool = nisaTools(nisa).find((t) => t.name === 'nisa.research')!;
  assert.equal(tool.readOnly, false);
  assert.equal(tool.openWorld, true);
  assert.equal(tool.tier, undefined);
  await assert.rejects(
    nisa.research(caller, { action: 'start', brief: 'x', request_id: '1', scope: 'forged' } as any),
    { code: 'invalid_input' },
  );
});

test('research scope isolates projects, actors, and conversations but survives worker visits', () => {
  const base = researchScope(caller);
  assert.equal(
    base,
    researchScope({ ...caller, session: { ...caller.session, id: 'next-visit' } }),
  );
  assert.notEqual(base, researchScope({ ...caller, projectId: 'other' }));
  assert.notEqual(base, researchScope({ ...caller, actorId: 'reviewer' }));
  assert.notEqual(
    base,
    researchScope({
      ...caller,
      conversation: { id: 'conversation', commandId: 'cmd', runtimeId: 'runtime', epoch: 1 },
    }),
  );
});

test('only new workflow contracts grant stateful research, including independent reviewers', () => {
  for (const state of ['planned', 'design_review', 'running', 'experiment_review'] as const) {
    assert.equal(
      execution(state, 41).tools.some((t) => t.name === 'nisa.research'),
      false,
    );
    assert.equal(
      execution(state, 42).tools.some((t) => t.name === 'nisa.research'),
      true,
    );
  }
  for (const purpose of ['work', 'review'] as const) {
    assert.equal(
      taskExecutionPolicy(purpose, 'code').tools.some((t) => t.name === 'nisa.research'),
      false,
    );
    assert.equal(
      taskExecutionPolicy(purpose, 'code', true).tools.some((t) => t.name === 'nisa.research'),
      true,
    );
  }
});

test('a report page ends on a whole character, so the next starts on one', () => {
  const result = { answer: `${'x'.repeat(11_999)}🚀 end`, research_id: op };
  const usage = { prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0, cost_usd: 0 };
  const data = { operationId: op, sessionId: session, status: 'completed', terminal: true };
  const page = (offset: number) =>
    researchResult(
      { ...data, cancelRequested: false, failure: null, result: { ...result, usage } },
      offset,
    );
  assert.equal(page(0).next_answer_offset, 11_999);
  assert.equal(page(11_999).answer, '🚀 end');
});
