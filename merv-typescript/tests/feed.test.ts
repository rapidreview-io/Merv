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
