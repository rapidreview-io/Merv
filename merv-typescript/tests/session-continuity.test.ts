/**
 * Continuity on the default composition with Blobs over the S3 fixture: when work comes back to a
 * state, the agent that held it takes it up again with the conversation its runner delivered.
 */
import { MervError } from '@merv/contracts';
import { excludedFromReview } from '@merv/reviews/rules';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import { dormantMs } from '../packages/sessions/src/threads.js';
import type {
  Session,
  SessionMessage,
  ThreadMessages,
  ThreadQuestion,
  WorkerQueue,
} from '../packages/sessions/src/types.js';
import { secret, twoStepWorkflow } from './fixtures/session-workflow.js';

async function fixture(t: TestContext) {
  const { app, s3, sessions, token, owner, http, ok, offer, move, start } = await twoStepWorkflow(
    t,
    'continuity',
  );
  const release = async (session: Session) =>
    await ok('POST', `/sessions/${session.id}/release`, token, { runnerId: session.runnerId });
  /** The runner's declaration and delivery of a conversation file, through its signed PUT. */
  const keep = async (
    session: Session,
    control: { runnerId: string; hostRef: string },
    text = `{"type":"user","text":"${randomUUID()}"}\n`,
    harness = 'codex',
  ) => {
    const bytes = Buffer.from(text);
    const facts = {
      harness,
      conversationId: '0199a0b2-1111-7222-8333-944445555666',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
    const path = `/sessions/${session.id}/conversation`;
    await ok('POST', path, token, { ...control, ...facts });
    const { upload } = (await ok('POST', path, token, { ...control, ...facts, deliver: true }))
      .conversation;
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(bytes),
    });
    assert.equal(put.status, 200);
    const stamped = (await ok('POST', path, token, { ...control, ...facts, deliver: true }))
      .conversation;
    assert.equal(typeof stamped.uploadedAt, 'string');
    return { bytes, facts };
  };
  // The message that answered each thread's last question, which its next visit acknowledges.
  const answers = new Map<string, string>();
  /** A visit to the work whose agent asks its owner, and the owner's answer to its thread. */
  const asked = async (instanceId: string, question: string, answer: string) => {
    const visit = await offer(instanceId);
    const worker = await sessions.authenticate(visit.input.secret);
    const pending = answers.get(visit.session.threadId!);
    if (pending)
      await app.ctx.tools.invoke('session.message.ack', worker, {
        messageId: pending,
        requestId: randomUUID(),
      });
    await app.ctx.tools.invoke('session.ask_owner', worker, { question });
    await keep(visit.session, visit.control);
    await release(visit.session);
    const path = `/sessions/threads/${visit.session.threadId}/messages`;
    const sent = await ok('POST', path, token, { body: answer, requestId: randomUUID() });
    answers.set(visit.session.threadId!, (sent.message as SessionMessage).id);
  };
  // A thread is active until it retires, live or dormant.
  const agent = async (id: string) => {
    const thread = (await sessions.threads.project(owner)).threads.find((item) => item.id === id)!;
    return { status: thread.status === 'retired' ? 'retired' : 'active' };
  };
  return {
    app,
    s3,
    sessions,
    token,
    owner,
    http,
    ok,
    offer,
    release,
    move,
    keep,
    asked,
    agent,
    start,
    /** The owner's move on the work, as its gate answers Needs you. */
    yours: async (instanceId: string) =>
      (await app.ctx.workflows.overview(owner, undefined, { open: true })).workflows.find(
        (item) => item.instanceId === instanceId,
      )?.yours,
    /** As though every key's work had stayed away for `ms`. */
    age: async (ms: number) =>
      await app.ctx.state.transaction((tx) =>
        tx.run(
          "UPDATE session_threads SET updated_at=? WHERE status<>'retired'",
          new Date(Date.now() - ms).toISOString(),
        ),
      ),
  };
}

test('work that comes back resumes its producer: same agent actor, new session, lease and credential', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  assert.deepEqual(first.session.continuity, {
    key: JSON.stringify([unit.id, 'working', 'producer']),
  });
  await f.release(first.session);
  // Its agent waits, dormant: the session's own credential is revoked as before.
  assert.equal((await f.agent(first.session.threadId!)).status, 'active');
  const { bytes, facts } = await f.keep(first.session, first.control);

  await f.move(unit.id, 'submit');
  const review = await f.offer(unit.id, 'runner-a');
  // A reviewer reads each round with fresh eyes: its round's own key, never the producer's
  // conversation or agent.
  assert.equal(review.session.continuity?.resume, undefined);
  assert.notEqual(review.session.continuity?.key, first.session.continuity!.key);
  assert.notEqual(review.session.actorId, first.session.actorId);
  await f.release(review.session);
  await f.move(unit.id, 'revise');

  // Another runner takes the returned work: the earlier agent, its conversation, a new session.
  const second = await f.offer(unit.id, 'runner-b');
  assert.notEqual(second.session.id, first.session.id);
  assert.equal(second.session.threadId, first.session.threadId);
  assert.equal(second.session.actorId, first.session.actorId);
  assert.deepEqual(second.session.continuity, {
    key: first.session.continuity!.key,
    resume: { sessionId: first.session.id, ...facts },
  });
  // A replay of the offer is the same session; a changed input is still refused.
  const replay = await f.sessions.offer(f.owner, second.input);
  assert.deepEqual(
    [replay.id, replay.actorId, replay.continuity],
    [second.session.id, second.session.actorId, second.session.continuity],
  );
  await assert.rejects(f.sessions.offer(f.owner, { ...second.input, secret: secret() }), {
    code: 'request_conflict',
  });
  // Its runner, and only while it is attached and live, fetches the bytes by a signed GET.
  const { download } = await f.ok('POST', `/sessions/${second.session.id}/resume`, f.token, {
    ...second.control,
  });
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
  assert.equal(
    (await f.http('POST', `/sessions/${first.session.id}/resume`, f.token, first.control)).status,
    409,
  );

  // The reactivated producer is still a contributor under both sessions: excluded from review.
  const contributors = await f.app.ctx.state.transaction((tx) =>
    f.sessions.contributors(f.owner.projectId, unit.id, null, tx),
  );
  assert.deepEqual(
    contributors.map((c) => [c.ref, c.actorId]).sort(),
    [
      [first.session.id, first.session.actorId],
      [second.session.id, first.session.actorId],
    ].sort(),
  );
  assert.ok(
    excludedFromReview(
      { producerId: 'someone', excludedActorIds: contributors.map((c) => c.actorId) },
      second.session.actorId,
    ),
  );

  // The first session's conversation is no longer the latest once the second delivers its own.
  await f.release(second.session);
  await f.keep(second.session, second.control);
  const stale = await f.http('POST', `/sessions/${first.session.id}/conversation`, f.token, {
    ...first.control,
    ...facts,
  });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'conversation_superseded']);
});

test('a cut reviewer resumes its own conversation within its round; a new round starts fresh', async (t) => {
  // Audit 15: a results review cut by its step limit, a lost host or a release came back as a new
  // agent with no notes, and a review needing more than one visit could start over for ever.
  const f = await fixture(t);
  const unit = await f.start();
  const producer = await f.offer(unit.id);
  await f.release(producer.session);
  await f.move(unit.id, 'submit');
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.offer(unit.id, 'runner-a');
  assert.equal(
    first.session.continuity?.key,
    JSON.stringify([unit.id, 'review', 'reviewer', revision]),
  );
  // Cut before its verdict: the next visit of the round continues it.
  await f.release(first.session);
  const kept = await f.keep(first.session, first.control);
  const second = await f.offer(unit.id, 'runner-b');
  assert.deepEqual(
    [second.session.threadId, second.session.actorId, second.session.continuity?.resume],
    [first.session.threadId, first.session.actorId, { sessionId: first.session.id, ...kept.facts }],
  );
  await f.release(second.session);
  // The next round is read with fresh eyes, and the earlier round's reviewer retires.
  await f.move(unit.id, 'revise');
  const again = await f.offer(unit.id);
  await f.release(again.session);
  await f.move(unit.id, 'submit');
  const fresh = await f.offer(unit.id, 'runner-a');
  assert.notEqual(fresh.session.threadId, first.session.threadId);
  assert.notEqual(fresh.session.actorId, first.session.actorId);
  assert.equal(fresh.session.continuity?.resume, undefined);
  assert.equal((await f.agent(first.session.threadId!)).status, 'retired');
});

test('an agent asks its owner: its visit ends uncounted, the work waits, and a message to its thread answers and brings it back', async (t) => {
  const f = await fixture(t);
  const leased = f.sessions as unknown as LeasedSessions;
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  const threadId = first.session.threadId;
  const worker = await f.sessions.authenticate(first.input.secret);
  const question = 'Which split should the evaluation hold out: the 2024 or the 2025 cohort?';
  const asked = (await f.app.ctx.tools.invoke('session.ask_owner', worker, { question })).value as {
    question: ThreadQuestion;
    ended: boolean;
  };
  assert.deepEqual(
    [asked.ended, asked.question.threadId, asked.question.question, asked.question.answeredAt],
    [true, threadId, question, null],
  );
  // The visit ended as released, by its own hand, and nothing counts it against the work.
  const closed = await f.sessions.get(f.owner, first.session.id);
  assert.deepEqual(
    [closed.status, closed.outcome, closed.closeReason],
    ['released', 'asked_owner', 'asked_owner'],
  );
  await assert.rejects(f.app.ctx.tools.invoke('session.messages', worker, {}));
  // Its runner delivers the conversation as it releases; the release changes nothing.
  await f.keep(first.session, first.control);
  await f.release(first.session);
  const holds = async () =>
    await f.app.ctx.state.read((sql) =>
      sql.all('SELECT * FROM session_dispatch_holds WHERE instance_id=?', unit.id),
    );
  assert.deepEqual(await holds(), []);
  // The work waits: withheld from dispatch, its blocker on its gate and in session.stuck, its
  // question in Needs you, and its thread kept however long the answer takes.
  const queued = async () =>
    await f.app.ctx.state.transaction(async (tx) =>
      (await leased.dispatch.candidates(f.owner, tx)).queue.some(
        (item) => item.instanceId === unit.id,
      ),
    );
  assert.equal(await queued(), false);
  const blockers = async () =>
    (await f.app.ctx.workflows.blockers(f.owner, unit.id)).map((item) => [
      item.provider,
      item.key,
      item.code,
      item.message,
    ]);
  assert.deepEqual(await blockers(), [
    ['session-question', threadId, 'agent_question', `Its agent asked its owner: ${question}`],
  ]);
  assert.deepEqual(
    (await f.sessions.dispatch.stuck(f.owner)).items
      .filter((item) => item.instanceId === unit.id)
      .map((item) => item.kind),
    ['work_blocked'],
  );
  // Needs you reads it from the work's gate: the blocker is the one channel.
  assert.deepEqual(await f.yours(unit.id), {
    ask: 'Answer its agent’s question with a message to its thread; dispatch then offers the work again',
    blocker: { provider: 'session-question', key: threadId },
  });
  await f.age(dormantMs + 60_000);
  await f.app.ctx.state.transaction((tx) => leased.threads.expire(tx));
  const path = `/sessions/threads/${threadId}/messages`;
  let read: ThreadMessages = await f.ok('GET', path, f.token);
  assert.deepEqual(
    [read.messages, read.questions.map((item) => [item.sessionId, item.answeredAt])],
    [[], [[first.session.id, null]]],
  );
  // The Agents page lists it first, waiting, with its question, though no visit of it is live.
  const listed = async () =>
    (await f.ok('GET', '/sessions/threads', f.token)).threads.find(
      (item: { id: string }) => item.id === threadId,
    );
  let card = await listed();
  assert.deepEqual(
    [card.seq, card.status, card.question?.question, card.message],
    [undefined, 'dormant', question, undefined],
  );
  assert.deepEqual(await f.sessions.threads.counts(f.owner), { live: 0, waiting: 1 });

  // The answer: a message to the thread, which releases the work.
  const answer = 'Hold out the 2025 cohort.';
  const sent = (await f.ok('POST', path, f.token, { body: answer, requestId: 'answer-1' }))
    .message as SessionMessage;
  assert.deepEqual(
    [sent.threadId, sent.instanceId, sent.acknowledgedAt],
    [threadId, unit.id, null],
  );
  assert.equal(
    (await f.ok('POST', path, f.token, { body: answer, requestId: 'answer-1' })).message.id,
    sent.id,
  );
  assert.deepEqual(await blockers(), []);
  assert.equal(await f.yours(unit.id), undefined);
  assert.equal(await queued(), true);
  // Answered, it waits no more; until its agent reads the answer it stays first, which says Sent.
  card = await listed();
  assert.deepEqual(
    [card.seq, card.question, card.message?.body, card.message?.acknowledgedAt],
    [undefined, undefined, answer, null],
  );
  assert.deepEqual(await f.sessions.threads.counts(f.owner), { live: 0, waiting: 0 });
  // The work comes back to the same thread and conversation, and its next visit reads the
  // answer before anything else.
  const second = await f.offer(unit.id, 'runner-b');
  assert.deepEqual(
    [second.session.threadId, second.session.continuity?.resume?.sessionId],
    [threadId, first.session.id],
  );
  assert.deepEqual(await f.sessions.threads.counts(f.owner), { live: 1, waiting: 0 });
  assert.equal((await listed()).status, 'live');
  const next = await f.sessions.authenticate(second.input.secret);
  await assert.rejects(f.app.ctx.tools.invoke('session.ask_owner', next, { question: 'Again?' }), {
    code: 'session_message_pending',
  });
  const inbox = ((await f.app.ctx.tools.invoke('session.messages', next, {})).value as WorkerQueue)
    .messages;
  assert.deepEqual(
    inbox.map((item) => [item.id, item.body]),
    [[sent.id, answer]],
  );
  await f.app.ctx.tools.invoke('session.message.ack', next, {
    messageId: sent.id,
    reply: 'Holding out 2025.',
    requestId: 'ack-1',
  });
  read = await f.ok('GET', path, f.token);
  assert.deepEqual(
    [
      read.messages.map((item) => [item.id, item.reply]),
      read.questions.map((item) => [item.answeredAt !== null, item.answerMessageId]),
    ],
    [[[sent.id, 'Holding out 2025.']], [[true, sent.id]]],
  );
  // Only a person messages, and only a thread of this project; a reviewer, which keeps no
  // conversation, cannot ask.
  assert.equal(
    (await f.http('POST', path, second.input.secret, { body: 'x', requestId: 'x' })).status,
    403,
  );
  const missing = await f.http('POST', '/sessions/threads/thr_missing/messages', f.token, {
    body: 'x',
    requestId: 'missing',
  });
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'thread_not_found']);
  // A visit whose workflow keeps no conversation cannot ask.
  f.sessions.threads.register('continuity-test', () => null);
  const other = await f.start();
  const unkept = await f.offer(other.id, 'runner-c');
  await assert.rejects(
    f.app.ctx.tools.invoke(
      'session.ask_owner',
      await f.sessions.authenticate(unkept.input.secret),
      {
        question,
      },
    ),
    { code: 'question_unkept' },
  );
});

test('a question answered needs its work readable, and one on ended work keeps neither its card nor its thread', async (t) => {
  const f = await fixture(t);
  const leased = f.sessions as unknown as LeasedSessions;
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  const threadId = first.session.threadId;
  const worker = await f.sessions.authenticate(first.input.secret);
  await f.app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Which cohort?' });
  await f.release(first.session);
  const path = `/sessions/threads/${threadId}/messages`;
  // A writer who may not read the work item cannot answer for it.
  const host = (leased.messaging as unknown as { host: { readable: unknown } }).host;
  const readable = host.readable;
  host.readable = async () => {
    throw new MervError('forbidden', 'Not readable', 403);
  };
  const refused = await f.http('POST', path, f.token, { body: 'x', requestId: 'unread' });
  host.readable = readable;
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'forbidden']);
  const read: ThreadMessages = await f.ok('GET', path, f.token);
  assert.deepEqual([read.messages, read.questions.map((item) => item.answeredAt)], [[], [null]]);
  // The work ends unanswered: no card, and its thread expires as any dormant one does.
  await f.move(unit.id, 'submit');
  await f.move(unit.id, 'approve');
  assert.equal(await f.yours(unit.id), undefined);
  await f.age(dormantMs + 60_000);
  await f.app.ctx.state.transaction((tx) => leased.threads.expire(tx));
  const status = await f.app.ctx.state.read((sql) =>
    sql.get<{ status: string }>('SELECT status FROM session_threads WHERE id=?', threadId),
  );
  assert.equal(status?.status, 'retired');
});

test('an answer waits for the asking visit’s conversation to be uploaded, not only declared', async (t) => {
  const f = await fixture(t);
  const leased = f.sessions as unknown as LeasedSessions;
  const unit = await f.start();
  const asking = await f.offer(unit.id, 'runner-a');
  const worker = await f.sessions.authenticate(asking.input.secret);
  await f.app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Which cohort?' });
  const path = `/sessions/threads/${asking.session.threadId}/messages`;
  await f.ok('POST', path, f.token, { body: '2025', requestId: 'answer' });
  const queued = async () =>
    await f.app.ctx.state.transaction(async (tx) =>
      (await leased.dispatch.candidates(f.owner, tx)).queue.some(
        (item) => item.instanceId === unit.id,
      ),
    );
  // Its runner declares the conversation as it releases, and uploads it only after its capture:
  // offered in between, the next visit could not fetch it and would start without the question.
  const bytes = Buffer.from('{"type":"user","text":"asked"}\n');
  const facts = {
    harness: 'codex',
    conversationId: '0199a0b2-1111-7222-8333-944445555666',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const conversation = `/sessions/${asking.session.id}/conversation`;
  const declared = (await f.ok('POST', conversation, f.token, { ...asking.control, ...facts }))
    .conversation;
  assert.equal(declared.uploadedAt, null);
  assert.equal(await queued(), false);
  const { upload } = (
    await f.ok('POST', conversation, f.token, { ...asking.control, ...facts, deliver: true })
  ).conversation;
  const put = await fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 200);
  await f.ok('POST', conversation, f.token, { ...asking.control, ...facts, deliver: true });
  assert.equal(await queued(), true);
  const next = await f.offer(unit.id, 'runner-b');
  assert.equal(next.session.continuity?.resume?.sessionId, asking.session.id);
  const resumed = await f.http(
    'POST',
    `/sessions/${next.session.id}/resume`,
    f.token,
    next.control,
  );
  assert.equal(resumed.status, 200, resumed.text);
});
