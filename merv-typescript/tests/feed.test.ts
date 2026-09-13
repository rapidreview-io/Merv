import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteState } from '@merv/state'
import { ProjectScope } from '@merv/scope'
import { DiskBlobs } from '@merv/blobs'
import { ArtifactStore } from '@merv/artifacts'
import { FeedService } from '../packages/feed/src/index.js'
import { MervError, type Caller, type FeedInput, type FeedListInput } from '@merv/contracts'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-feed-'))
  const state = new SqliteState(join(directory, 'state.sqlite'))
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }) })
  const scope = new ProjectScope(state), blobs = new DiskBlobs(join(directory, 'blobs'))
  const artifacts = new ArtifactStore(state, scope, blobs), feed = new FeedService(state, scope, artifacts)
  const credentials = scope.bootstrap({ projectName: 'Independent feed', actorName: 'Operator' })
  const operator: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id }
  const issue = (name: string, role: 'producer' | 'reviewer' | 'reader'): Caller => ({
    actorId: scope.issueActor(operator, { name, role }).actor.id, projectId: operator.projectId,
  })
  const producer = issue('Producer', 'producer'), reviewer = issue('Reviewer', 'reviewer'), reader = issue('Reader', 'reader')
  return { directory, state, scope, blobs, artifacts, feed, operator, producer, reviewer, reader }
}
const code = (expected: string) => (error: unknown) => error instanceof MervError && error.code === expected

test('standalone Feed admits reviewers, scopes communication, and validates artifact attachments', t => {
  const f = fixture(t)
  const evidence = f.artifacts.create(f.producer, { title: 'Evidence', content: 'Immutable evidence.' })
  const post = f.feed.post(f.reviewer, { body: 'I checked the evidence.', artifactIds: [evidence.id], requestId: 'reviewer-post' })
  assert.equal(post.authorId, f.reviewer.actorId)
  assert.deepEqual(post.artifactIds, [evidence.id])
  assert.deepEqual(f.feed.get(f.reader, post.id), post)
  assert.deepEqual(f.feed.list(f.reader), [post])
  assert.throws(() => f.feed.post(f.reader, { body: 'Cannot post.', requestId: 'reader' }), code('forbidden'))
  assert.throws(() => f.artifacts.create(f.reviewer, { title: 'Not allowed', content: 'Communication does not grant artifact write permission.' }), code('forbidden'))
  const other = f.scope.bootstrap({ projectName: 'Other project', actorName: 'Other operator' })
  const foreign: Caller = { actorId: other.actor.id, projectId: other.project.id }
  const foreignEvidence = f.artifacts.create(foreign, { title: 'Foreign', content: 'Another project.' })
  assert.throws(() => f.feed.post(f.producer, { body: 'Foreign attachment', artifactIds: [foreignEvidence.id], requestId: 'foreign' }), code('not_found'))
  assert.throws(() => f.feed.get(foreign, post.id), code('not_found'))
  assert.deepEqual(f.feed.list(foreign), [])
  assert.throws(() => f.feed.list({ ...f.reviewer, projectId: foreign.projectId }), code('forbidden'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Duplicate attachment', artifactIds: [evidence.id, evidence.id], requestId: 'duplicate' }), code('invalid_attachments'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Too many', artifactIds: Array.from({ length: 11 }, (_, i) => `artifact_${i}`), requestId: 'too-many' }), code('invalid_attachments'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Missing', artifactIds: ['missing'], requestId: 'missing' }), code('not_found'))
  assert.equal(f.feed.list(f.producer).length, 1)
})

test('Feed preserves exact content, deduplicates per actor, and rechecks permission on retries', t => {
  const f = fixture(t)
  const input = { body: '  Original message\nwith whitespace.  ', requestId: 'shared-key' }
  const post = f.feed.post(f.producer, input)
  assert.equal(post.body, input.body)
  assert.deepEqual(f.feed.post(f.producer, input), post)
  assert.equal(f.feed.list(f.producer).length, 1)
  assert.equal(f.feed.activity(f.producer).filter(event => event.type === 'feed.posted').length, 1)
  assert.throws(() => f.feed.post(f.producer, { ...input, body: 'Changed.' }), code('request_conflict'))
  assert.throws(() => f.feed.post(f.producer, { ...input, artifactIds: [] }), code('request_conflict'))
  const reviewerPost = f.feed.post(f.reviewer, input)
  assert.notEqual(reviewerPost.id, post.id)
  assert.ok(reviewerPost.sequence > post.sequence)
  f.scope.revokeActor(f.operator, f.producer.actorId)
  assert.throws(() => f.feed.post(f.producer, input), code('forbidden'))
  assert.throws(() => f.feed.get(f.producer, post.id), code('forbidden'))
})

test('Feed validates text, direct-call attachment shapes, and cursor limits', t => {
  const f = fixture(t)
  for (const body of ['', ' \n\t ', 'x'.repeat(8001)]) {
    assert.throws(() => f.feed.post(f.producer, { body, requestId: 'invalid-body' }), code('invalid_body'))
  }
  const boundary = f.feed.post(f.producer, { body: 'x'.repeat(8000), requestId: 'maximum' })
  assert.equal(boundary.body.length, 8000)
  assert.throws(() => f.feed.post(f.producer, { body: 'Good', requestId: ' ' }), code('invalid_request'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Good', requestId: 'x'.repeat(201) }), code('invalid_request'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Good', requestId: 'bad-array', artifactIds: null } as unknown as FeedInput), code('invalid_attachments'))
  assert.throws(() => f.feed.post(f.producer, { body: 'Good', requestId: 'bad-item', artifactIds: [''] }), code('invalid_attachments'))
  for (const input of [{ after: -1 }, { after: 0.5 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { after: null }]) {
    assert.throws(() => f.feed.list(f.producer, input as FeedListInput), code('invalid_cursor'))
  }
  for (const limit of [0, 101, 1.5, null]) {
    assert.throws(() => f.feed.list(f.producer, { limit } as FeedListInput), code('invalid_limit'))
  }
  assert.throws(() => f.feed.activity(f.producer, -1), code('invalid_cursor'))
})

test('Feed post, durable event, and request record roll back together and retry safely', t => {
  const f = fixture(t)
  const before = f.state.events(f.producer.projectId)
  const original = f.state.appendEvent.bind(f.state)
  f.state.appendEvent = (tx, event) => {
    const result = original(tx, event)
    if (event.type === 'feed.posted') throw new Error('Injected event failure')
    return result
  }
  const input = { body: 'Commit together.', requestId: 'atomic' }
  assert.throws(() => f.feed.post(f.producer, input), /Injected event failure/)
  assert.deepEqual(f.feed.list(f.producer), [])
  assert.deepEqual(f.state.events(f.producer.projectId), before)
  assert.equal(f.state.read(sql => sql.get<{ count: number }>('SELECT COUNT(*) AS count FROM feed_requests'))?.count, 0)
  f.state.appendEvent = original
  const committed = f.feed.post(f.producer, input)
  assert.deepEqual(f.feed.post(f.producer, input), committed)
  assert.equal(f.feed.activity(f.producer).filter(event => event.type === 'feed.posted').length, 1)
  const externallyAtomic = { body: 'Outer transaction.', requestId: 'outer' }
  assert.throws(() => f.state.transaction(tx => {
    f.feed.post(f.reviewer, externallyAtomic, tx)
    throw new Error('Abort outer transaction')
  }), /Abort outer transaction/)
  assert.equal(f.feed.list(f.producer).length, 1)
  assert.equal(f.feed.post(f.reviewer, externallyAtomic).body, externallyAtomic.body)
})

test('Feed posts and deduplication records are immutable in SQLite', t => {
  const f = fixture(t)
  const post = f.feed.post(f.producer, { body: 'Original.', requestId: 'immutable' })
  assert.throws(() => f.state.transaction(tx => tx.run('UPDATE feed_posts SET body = ? WHERE id = ?', 'Edited', post.id)), /immutable/)
  assert.throws(() => f.state.transaction(tx => tx.run('DELETE FROM feed_posts WHERE id = ?', post.id)), /immutable/)
  assert.throws(() => f.state.transaction(tx => tx.run('INSERT OR REPLACE INTO feed_posts (sequence,id,project_id,author_id,body,artifact_ids,created_at) VALUES (?,?,?,?,?,?,?)',
    post.sequence, post.id, post.projectId, post.authorId, 'Replaced', '[]', post.createdAt)), /immutable/)
  assert.throws(() => f.state.transaction(tx => tx.run('UPDATE feed_requests SET input_hash = ?', 'overwritten')), /immutable/)
  assert.deepEqual(f.feed.get(f.producer, post.id), post)
})

test('Feed cursor pages and activity preserve project boundaries and survive reopening', t => {
  const f = fixture(t)
  const records = Array.from({ length: 55 }, (_, i) => f.feed.post(f.producer, { body: `Message ${i}`, requestId: `page-${i}` }))
  const other = f.scope.bootstrap({ projectName: 'Other project', actorName: 'Other operator' })
  const foreign: Caller = { actorId: other.actor.id, projectId: other.project.id }
  const foreignPost = f.feed.post(foreign, { body: 'Hidden from the first project.', requestId: 'foreign' })
  const final = f.feed.post(f.reviewer, { body: 'After another project’s post.', requestId: 'last' })
  const first = f.feed.list(f.reader)
  assert.equal(first.length, 50)
  assert.deepEqual(first, records.slice(0, 50))
  const rest = f.feed.list(f.reader, { after: first.at(-1)!.sequence, limit: 100 })
  assert.deepEqual(rest, [...records.slice(50), final])
  assert.ok(rest.every(post => post.id !== foreignPost.id && post.sequence > first.at(-1)!.sequence))
  assert.deepEqual(f.feed.list(f.reader, { after: final.sequence }), [])
  const activity = f.feed.activity(f.reader)
  assert.ok(activity.every(event => event.projectId === f.reader.projectId))
  assert.equal(activity.filter(event => event.type === 'feed.posted').length, 56)
  const cursor = activity.at(-2)!.id
  assert.deepEqual(f.feed.activity(f.reader, cursor), activity.filter(event => event.id > cursor))
  f.state.close()
  const reopened = new SqliteState(join(f.directory, 'state.sqlite'))
  try {
    const scope = new ProjectScope(reopened), artifacts = new ArtifactStore(reopened, scope, f.blobs)
    const feed = new FeedService(reopened, scope, artifacts)
    assert.deepEqual(feed.get(f.reader, final.id), final)
    assert.deepEqual(feed.list(f.reader, { after: first.at(-1)!.sequence, limit: 100 }), rest)
    assert.deepEqual(feed.activity(f.reader), activity)
    assert.deepEqual(feed.post(f.reviewer, { body: 'After another project’s post.', requestId: 'last' }), final)
  } finally { reopened.close() }
})

test('Feed activity exposes actor administration metadata only to project operators', t => {
  const f = fixture(t)
  f.feed.post(f.producer, { body: 'Public project activity.', requestId: 'public' })
  const operatorEvents = f.feed.activity(f.operator)
  assert.deepEqual(operatorEvents, f.state.events(f.operator.projectId))
  assert.ok(operatorEvents.some(event => event.type === 'actor.created' && event.data.name === 'Reviewer'))
  for (const caller of [f.producer, f.reviewer, f.reader]) {
    const events = f.feed.activity(caller)
    assert.ok(events.some(event => event.type === 'feed.posted'))
    assert.equal(events.some(event => event.type.startsWith('actor.')), false)
    assert.deepEqual(events, operatorEvents.filter(event => !event.type.startsWith('actor.')))
  }
  const revoked = f.scope.issueActor(f.operator, { name: 'Temporary actor', role: 'reader' })
  f.scope.revokeActor(f.operator, revoked.actor.id)
  assert.equal(f.feed.activity(f.reader).some(event => event.subjectId === revoked.actor.id), false)
  assert.ok(f.feed.activity(f.operator).some(event => event.type === 'actor.revoked' && event.subjectId === revoked.actor.id))
})

test('Feed activity advances past full hidden pages to reach later visible events', t => {
  const f = fixture(t)
  const after = f.state.events(f.operator.projectId).at(-1)!.id
  f.state.transaction(tx => {
    for (let index = 0; index < 2000; index++) {
      f.state.appendEvent(tx, { projectId: f.operator.projectId, actorId: f.operator.actorId,
        type: 'actor.created', subjectId: `private-${index}`, data: { name: `Hidden actor ${index}`, role: 'reader' } })
    }
  })
  // Even a multiple of the page size must eventually report a real end.
  assert.deepEqual(f.feed.activity(f.reader, after), [])
  const post = f.feed.post(f.reviewer, { body: 'Visible after hidden pages.', requestId: 'after-hidden' })
  const visible = f.feed.activity(f.reader, after)
  assert.equal(visible.length, 1)
  assert.equal(visible[0]!.type, 'feed.posted')
  assert.equal(visible[0]!.subjectId, post.id)
  assert.deepEqual(f.feed.activity(f.reader, visible[0]!.id), [])
  const operatorPage = f.feed.activity(f.operator, after)
  assert.equal(operatorPage.length, 1000)
  assert.ok(operatorPage.every(event => event.type === 'actor.created'))
})
