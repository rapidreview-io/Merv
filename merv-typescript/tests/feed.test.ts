import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { FeedService } from '../packages/feed/src/index.js';
import { MervError, type Caller } from '@merv/contracts';
import type { FeedInput, FeedListInput } from '@merv/feed/types';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-feed-'));
  const state = new SqliteState(join(directory, 'state.sqlite'));
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state)),
    blobs = new DiskBlobs(join(directory, 'blobs'));
  const artifacts = await createService(new ArtifactStore(state, scope, blobs)),
    feed = await createService(new FeedService(state, scope, artifacts));
  const credentials = await scope.bootstrap({
    projectName: 'Independent feed',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const issue = async (
    name: string,
    role: 'producer' | 'reviewer' | 'reader',
  ): Promise<Caller> => ({
    actorId: (await scope.issueActor(operator, { name, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('Producer', 'producer'),
    reviewer = await issue('Reviewer', 'reviewer'),
    reader = await issue('Reader', 'reader');
  return { directory, state, scope, blobs, artifacts, feed, operator, producer, reviewer, reader };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;

test('standalone Feed admits reviewers, scopes communication, and validates artifact attachments', async (t) => {
  const f = await fixture(t);
  const evidence = await f.artifacts.create(f.producer, {
    title: 'Evidence',
    content: 'Immutable evidence.',
  });
  const post = await f.feed.post(f.reviewer, {
    body: 'I checked the evidence.',
    artifactIds: [evidence.id],
    requestId: 'reviewer-post',
  });
  assert.equal(post.authorId, f.reviewer.actorId);
  assert.deepEqual(post.artifactIds, [evidence.id]);
  assert.deepEqual(await f.feed.get(f.reader, post.id), post);
  assert.deepEqual(await f.feed.list(f.reader), [post]);
  await assert.rejects(
    async () => await f.feed.post(f.reader, { body: 'Cannot post.', requestId: 'reader' }),
    code('forbidden'),
  );
  await assert.rejects(
    async () =>
      await f.artifacts.create(f.reviewer, {
        title: 'Not allowed',
        content: 'Communication does not grant artifact write permission.',
      }),
    code('forbidden'),
  );
  const other = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other operator',
  });
  const foreign: Caller = { actorId: other.actor.id, projectId: other.project.id };
  const foreignEvidence = await f.artifacts.create(foreign, {
    title: 'Foreign',
    content: 'Another project.',
  });
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, {
        body: 'Foreign attachment',
        artifactIds: [foreignEvidence.id],
        requestId: 'foreign',
      }),
    code('not_found'),
  );
  await assert.rejects(async () => await f.feed.get(foreign, post.id), code('not_found'));
  assert.deepEqual(await f.feed.list(foreign), []);
  await assert.rejects(
    async () => await f.feed.list({ ...f.reviewer, projectId: foreign.projectId }),
    code('forbidden'),
  );
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, {
        body: 'Duplicate attachment',
        artifactIds: [evidence.id, evidence.id],
        requestId: 'duplicate',
      }),
    code('invalid_attachments'),
  );
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, {
        body: 'Too many',
        artifactIds: Array.from({ length: 11 }, (_, i) => `artifact_${i}`),
        requestId: 'too-many',
      }),
    code('invalid_attachments'),
  );
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, {
        body: 'Missing',
        artifactIds: ['missing'],
        requestId: 'missing',
      }),
    code('not_found'),
  );
  assert.equal((await f.feed.list(f.producer)).length, 1);
});

test('Feed preserves exact content, deduplicates per actor, and rechecks permission on retries', async (t) => {
  const f = await fixture(t);
  const evidence = await f.artifacts.create(f.producer, {
    title: 'Attachment',
    content: 'A file this post could have carried.',
  });
  const input = { body: '  Original message\nwith whitespace.  ', requestId: 'shared-key' };
  const post = await f.feed.post(f.producer, input);
  assert.equal(post.body, input.body);
  assert.deepEqual(await f.feed.post(f.producer, input), post);
  assert.equal((await f.feed.list(f.producer)).length, 1);
  assert.equal(
    (await f.feed.activity(f.producer)).filter((event) => event.type === 'feed.posted').length,
    1,
  );
  await assert.rejects(
    async () => await f.feed.post(f.producer, { ...input, body: 'Changed.' }),
    code('request_conflict'),
  );
  // The same post described either way — artifactIds omitted, or the empty default spelled
  // out — is one request, and its receipt comes back rather than a conflict.
  assert.deepEqual(await f.feed.post(f.producer, { ...input, artifactIds: [] }), post);
  await assert.rejects(
    async () => await f.feed.post(f.producer, { ...input, artifactIds: [evidence.id] }),
    code('request_conflict'),
  );
  const reviewerPost = await f.feed.post(f.reviewer, input);
  assert.notEqual(reviewerPost.id, post.id);
  assert.ok(reviewerPost.sequence > post.sequence);
  await f.scope.revokeActor(f.operator, f.producer.actorId);
  await assert.rejects(async () => await f.feed.post(f.producer, input), code('forbidden'));
  await assert.rejects(async () => await f.feed.get(f.producer, post.id), code('forbidden'));
});

test('Feed validates text, direct-call attachment shapes, and cursor limits', async (t) => {
  const f = await fixture(t);
  for (const body of ['', ' \n\t ', 'x'.repeat(8001)]) {
    await assert.rejects(
      async () => await f.feed.post(f.producer, { body, requestId: 'invalid-body' }),
      code('invalid_body'),
    );
  }
  const boundary = await f.feed.post(f.producer, { body: 'x'.repeat(8000), requestId: 'maximum' });
  assert.equal(boundary.body.length, 8000);
  await assert.rejects(
    async () => await f.feed.post(f.producer, { body: 'Good', requestId: ' ' }),
    code('invalid_request'),
  );
  await assert.rejects(
    async () => await f.feed.post(f.producer, { body: 'Good', requestId: 'x'.repeat(201) }),
    code('invalid_request'),
  );
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, {
        body: 'Good',
        requestId: 'bad-array',
        artifactIds: null,
      } as unknown as FeedInput),
    code('invalid_attachments'),
  );
  await assert.rejects(
    async () =>
      await f.feed.post(f.producer, { body: 'Good', requestId: 'bad-item', artifactIds: [''] }),
    code('invalid_attachments'),
  );
  for (const input of [
    { after: -1 },
    { after: 0.5 },
    { after: Number.MAX_SAFE_INTEGER + 1 },
    { after: null },
  ]) {
    await assert.rejects(
      async () => await f.feed.list(f.producer, input as FeedListInput),
      code('invalid_cursor'),
    );
  }
  for (const limit of [0, 101, 1.5, null]) {
    await assert.rejects(
      async () => await f.feed.list(f.producer, { limit } as FeedListInput),
      code('invalid_limit'),
    );
  }
  await assert.rejects(async () => await f.feed.activity(f.producer, -1), code('invalid_cursor'));
});

test('Feed post, durable event, and request record roll back together and retry safely', async (t) => {
  const f = await fixture(t);
  const before = await f.state.events(f.producer.projectId);
  const original = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    const result = await original(tx, event);
    if (event.type === 'feed.posted') throw new Error('Injected event failure');
    return result;
  };
  const input = { body: 'Commit together.', requestId: 'atomic' };
  await assert.rejects(async () => await f.feed.post(f.producer, input), /Injected event failure/);
  assert.deepEqual(await f.feed.list(f.producer), []);
  assert.deepEqual(await f.state.events(f.producer.projectId), before);
  assert.equal(
    (
      await f.state.read(
        async (sql) =>
          await sql.get<{ count: number }>('SELECT COUNT(*) AS count FROM feed_requests'),
      )
    )?.count,
    0,
  );
  f.state.appendEvent = original;
  const committed = await f.feed.post(f.producer, input);
  assert.deepEqual(await f.feed.post(f.producer, input), committed);
  assert.equal(
    (await f.feed.activity(f.producer)).filter((event) => event.type === 'feed.posted').length,
    1,
  );
  const externallyAtomic = { body: 'Outer transaction.', requestId: 'outer' };
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.feed.post(f.reviewer, externallyAtomic, tx);
        throw new Error('Abort outer transaction');
      }),
    /Abort outer transaction/,
  );
  assert.equal((await f.feed.list(f.producer)).length, 1);
  assert.equal((await f.feed.post(f.reviewer, externallyAtomic)).body, externallyAtomic.body);
});

test('Feed posts and deduplication records are immutable in SQLite', async (t) => {
  const f = await fixture(t);
  const post = await f.feed.post(f.producer, { body: 'Original.', requestId: 'immutable' });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE feed_posts SET body = ? WHERE id = ?', 'Edited', post.id),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM feed_posts WHERE id = ?', post.id),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'INSERT OR REPLACE INTO feed_posts (sequence,id,project_id,author_id,body,artifact_ids,created_at) VALUES (?,?,?,?,?,?,?)',
            post.sequence,
            post.id,
            post.projectId,
            post.authorId,
            'Replaced',
            '[]',
            post.createdAt,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE feed_requests SET input_hash = ?', 'overwritten'),
      ),
    /immutable/,
  );
  assert.deepEqual(await f.feed.get(f.producer, post.id), post);
});

test('Feed cursor pages and activity preserve project boundaries and survive reopening', async (t) => {
  const f = await fixture(t);
  const records = await Promise.all(
    Array.from(
      { length: 55 },
      async (_, i) =>
        await f.feed.post(f.producer, { body: `Message ${i}`, requestId: `page-${i}` }),
    ),
  );
  const other = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other operator',
  });
  const foreign: Caller = { actorId: other.actor.id, projectId: other.project.id };
  const foreignPost = await f.feed.post(foreign, {
    body: 'Hidden from the first project.',
    requestId: 'foreign',
  });
  const final = await f.feed.post(f.reviewer, {
    body: 'After another project’s post.',
    requestId: 'last',
  });
  // Without a cursor the newest page answers, oldest first within it: what a reader opens on.
  const newest = await f.feed.list(f.reader);
  assert.equal(newest.length, 50);
  assert.deepEqual(newest, [...records.slice(6), final]);
  const first = await f.feed.list(f.reader, { after: 0, limit: 50 });
  assert.deepEqual(first, records.slice(0, 50));
  const rest = await f.feed.list(f.reader, { after: first.at(-1)!.sequence, limit: 100 });
  assert.deepEqual(rest, [...records.slice(50), final]);
  assert.ok(
    rest.every((post) => post.id !== foreignPost.id && post.sequence > first.at(-1)!.sequence),
  );
  assert.deepEqual(await f.feed.list(f.reader, { after: final.sequence }), []);
  const activity = await f.feed.activity(f.reader);
  assert.ok(activity.every((event) => event.projectId === f.reader.projectId));
  assert.equal(activity.filter((event) => event.type === 'feed.posted').length, 56);
  const cursor = activity.at(-2)!.id;
  assert.deepEqual(
    await f.feed.activity(f.reader, cursor),
    activity.filter((event) => event.id > cursor),
  );
  await f.state.close();
  const reopened = new SqliteState(join(f.directory, 'state.sqlite'));
  try {
    const scope = await createService(new ProjectScope(reopened)),
      artifacts = await createService(new ArtifactStore(reopened, scope, f.blobs));
    const feed = await createService(new FeedService(reopened, scope, artifacts));
    assert.deepEqual(await feed.get(f.reader, final.id), final);
    assert.deepEqual(
      await feed.list(f.reader, { after: first.at(-1)!.sequence, limit: 100 }),
      rest,
    );
    assert.deepEqual(await feed.activity(f.reader), activity);
    assert.deepEqual(
      await feed.post(f.reviewer, { body: 'After another project’s post.', requestId: 'last' }),
      final,
    );
  } finally {
    await reopened.close();
  }
});

test('Feed activity exposes actor administration metadata only to project operators', async (t) => {
  const f = await fixture(t);
  await f.feed.post(f.producer, { body: 'Public project activity.', requestId: 'public' });
  const operatorEvents = await f.feed.activity(f.operator);
  assert.deepEqual(operatorEvents, await f.state.events(f.operator.projectId));
  assert.ok(
    operatorEvents.some(
      (event) => event.type === 'actor.created' && event.data.name === 'Reviewer',
    ),
  );
  for (const caller of [f.producer, f.reviewer, f.reader]) {
    const events = await f.feed.activity(caller);
    assert.ok(events.some((event) => event.type === 'feed.posted'));
    assert.equal(
      events.some((event) => event.type.startsWith('actor.')),
      false,
    );
    assert.deepEqual(
      events,
      operatorEvents.filter((event) => !event.type.startsWith('actor.')),
    );
  }
  const revoked = await f.scope.issueActor(f.operator, { name: 'Temporary actor', role: 'reader' });
  await f.scope.revokeActor(f.operator, revoked.actor.id);
  assert.equal(
    (await f.feed.activity(f.reader)).some((event) => event.subjectId === revoked.actor.id),
    false,
  );
  assert.ok(
    (await f.feed.activity(f.operator)).some(
      (event) => event.type === 'actor.revoked' && event.subjectId === revoked.actor.id,
    ),
  );
});

test('Feed hides local membership repair reasons from nonoperator project participants', async (t) => {
  const f = await fixture(t);
  const principal = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example.test/auth/v1',
    subject: 'project-owner',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await f.scope.adoptProject(principal, f.operator.projectId);
  await f.scope.adoptProject(principal, f.operator.projectId, {
    repairReason: 'Private account recovery details',
  });
  assert.equal(
    (await f.feed.activity(f.operator)).some((event) => event.type === 'membership.repaired'),
    true,
  );
  for (const caller of [f.producer, f.reviewer, f.reader]) {
    const events = await f.feed.activity(caller);
    assert.equal(
      events.some((event) => event.type.startsWith('membership.')),
      false,
    );
    assert.equal(JSON.stringify(events).includes('Private account recovery details'), false);
  }
});

test('Feed activity advances past full hidden pages to reach later visible events', async (t) => {
  const f = await fixture(t);
  const after = (await f.state.events(f.operator.projectId)).at(-1)!.id;
  await f.state.transaction(async (tx) => {
    for (let index = 0; index < 2000; index++) {
      await f.state.appendEvent(tx, {
        projectId: f.operator.projectId,
        actorId: f.operator.actorId,
        type: 'actor.created',
        subjectId: `private-${index}`,
        data: { name: `Hidden actor ${index}`, role: 'reader' },
      });
    }
  });
  // Even a multiple of the page size must eventually report a real end.
  assert.deepEqual(await f.feed.activity(f.reader, after), []);
  const post = await f.feed.post(f.reviewer, {
    body: 'Visible after hidden pages.',
    requestId: 'after-hidden',
  });
  const visible = await f.feed.activity(f.reader, after);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.type, 'feed.posted');
  assert.equal(visible[0]!.subjectId, post.id);
  assert.deepEqual(await f.feed.activity(f.reader, visible[0]!.id), []);
  const operatorPage = await f.feed.activity(f.operator, after);
  assert.equal(operatorPage.length, 1000);
  assert.ok(operatorPage.every((event) => event.type === 'actor.created'));
  // Without a cursor the newest page answers, so a reader is never stuck at the oldest one.
  const latest = await f.feed.activity(f.operator);
  assert.equal(latest.length, 1000);
  assert.equal(latest.at(-1)!.subjectId, post.id);
  assert.deepEqual(await f.feed.activity(f.reader), [visible[0]]);
  // A burst of private events after the last visible one does not blank a reader's newest page.
  await f.state.transaction(async (tx) => {
    for (let index = 0; index < 2000; index++) {
      await f.state.appendEvent(tx, {
        projectId: f.operator.projectId,
        actorId: f.operator.actorId,
        type: 'actor.created',
        subjectId: `later-${index}`,
        data: { name: `Hidden actor ${index}`, role: 'reader' },
      });
    }
  });
  assert.deepEqual(await f.feed.activity(f.reader), [visible[0]]);
});
