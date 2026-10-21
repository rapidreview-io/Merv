import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { FeedService } from '../packages/feed/src/index.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-feed-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state)),
    blobs = new DiskBlobs(join(directory, 'blobs'));
  const artifacts = await createService(new ArtifactStore(state, scope, blobs)),
    feed = await createService(new FeedService(state, scope, artifacts));
  const credentials = await scope.credentials.bootstrap({
    projectName: 'Independent feed',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const issue = async (
    name: string,
    role: 'producer' | 'reviewer' | 'reader',
  ): Promise<Caller> => ({
    actorId: (await scope.credentials.issueActor(operator, { name, role })).actor.id,
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
  const other = await f.scope.credentials.bootstrap({
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
  await f.scope.credentials.revokeActor(f.operator, f.producer.actorId);
  await assert.rejects(async () => await f.feed.post(f.producer, input), code('forbidden'));
  await assert.rejects(async () => await f.feed.get(f.producer, post.id), code('forbidden'));
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

test('Feed posts and deduplication records are immutable in storage', async (t) => {
  const f = await fixture(t);
  const post = await f.feed.post(f.producer, { body: 'Original.', requestId: 'immutable' });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE feed_posts SET body = ? WHERE id = ?', 'Edited', post.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM feed_posts WHERE id = ?', post.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'INSERT INTO feed_posts (id,project_id,author_id,body,artifact_ids,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET body = excluded.body',
            post.id,
            post.projectId,
            post.authorId,
            'Replaced',
            '[]',
            post.createdAt,
          ),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE feed_requests SET input_hash = ?', 'overwritten'),
      ),
    { code: 'state_constraint' },
  );
  assert.deepEqual(await f.feed.get(f.producer, post.id), post);
});

test('Feed cursor pages and activity preserve project boundaries and survive reopening', async (t) => {
  const f = await fixture(t);
  // Concurrent posts commit in the order their writers take the lock, not the order they were
  // called; `sequence` is that commit order, and pages follow it.
  const records = (
    await Promise.all(
      Array.from(
        { length: 55 },
        async (_, i) =>
          await f.feed.post(f.producer, { body: `Message ${i}`, requestId: `page-${i}` }),
      ),
    )
  ).sort((a, b) => a.sequence - b.sequence);
  const other = await f.scope.credentials.bootstrap({
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
  const pagination = { after: 0, limit: 50 };
  const paging = f.feed.list(f.reader, pagination);
  pagination.after = final.sequence;
  pagination.limit = 1;
  const first = await paging;
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
  const changing = structuredClone(f.operator);
  const authorize = f.scope.require.bind(f.scope);
  const swapped = t.mock.method(
    f.scope,
    'require',
    async (...args: Parameters<typeof authorize>) => {
      const actor = await authorize(...args);
      changing.projectId = foreign.projectId;
      return actor;
    },
  );
  try {
    await assert.rejects(f.feed.get(changing, foreignPost.id), code('not_found'));
    changing.projectId = f.operator.projectId;
    assert.deepEqual(await f.feed.list(changing), newest);
    changing.projectId = f.operator.projectId;
    assert.deepEqual(await f.feed.activity(changing), await f.state.events(f.operator.projectId));
  } finally {
    swapped.mock.restore();
  }
  await f.state.close();
  const reopened = await openState(f.directory);
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
