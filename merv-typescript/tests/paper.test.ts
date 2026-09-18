import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { PaperService } from '@merv/paper';
import { MervError, type Caller } from '@merv/contracts';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'paper-documents-'));
  const state = new SqliteState(join(dir, 'state.sqlite')),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
    );
  let paper = await createService(new PaperService(state, scope, artifacts)),
    count = 0;
  const boot = await scope.bootstrap({ projectName: 'Paper', actorName: 'Owner' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (role: 'producer' | 'reviewer' | 'reader') => {
    const a = await scope.issueActor(operator, { name: role, role });
    return { projectId: operator.projectId, actorId: a.actor.id, credentialId: a.credential.id };
  };
  const producer = await actor('producer'),
    reviewer = await actor('reviewer'),
    reader = await actor('reader');
  t.after(async () => {
    paper.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    state,
    scope,
    artifacts,
    operator,
    producer,
    reviewer,
    reader,
    request: () => `paper-${++count}`,
    get paper() {
      return paper;
    },
    async reload() {
      paper.close();
      paper = await createService(new PaperService(state, scope, artifacts));
    },
  };
}
async function proposal(
  f: Awaited<ReturnType<typeof fixture>>,
  documents = [
    {
      kind: 'methods' as const,
      expectedRevision: 0,
      changes: [{ id: 'method', title: 'Method', content: 'A controlled comparison.' }],
    },
  ],
) {
  const changes = await f.artifacts.create(f.producer, {
    title: 'Paper edits',
    mediaType: 'application/json',
    content: JSON.stringify({ documents }),
  });
  const evidence = await f.artifacts.create(f.producer, {
    title: 'Evidence',
    content: 'Retained scientific evidence',
  });
  return await f.state.transaction(
    async (tx) =>
      await f.paper.propose(
        f.producer,
        {
          artifactId: changes.id,
          source: { kind: 'experiment', id: 'experiment-1', revision: 3 },
          evidenceIds: [evidence.id],
        },
        tx,
      ),
  );
}
test('paper keeps ordered section history, structured scope and scoped citation ledger with replay/CAS', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.paper.read(f.reader)).documents.problem.current.sections.map((s) => s.id),
    ['problem', 'scope', 'goals', 'constraints'],
  );
  const problem = await f.paper.patch(f.producer, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      { id: 'problem', content: 'Can a smaller model match the baseline?' },
      { id: 'constraints', content: 'One fixed evaluation split.' },
    ],
  });
  assert.equal(problem.revision, 1);
  const input = {
    kind: 'literature' as const,
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      { id: 'baselines', title: 'Baselines', content: 'Existing reference systems.' },
      { id: 'scaling', title: 'Scaling', content: 'Related scaling evidence.', afterId: null },
    ],
  };
  const literature = await f.paper.patch(f.producer, input);
  assert.deepEqual(
    literature.sections.map((s) => s.id),
    ['scaling', 'baselines'],
  );
  assert.deepEqual(await f.paper.patch(f.producer, input), literature);
  await assert.rejects(
    async () =>
      await f.paper.patch(f.producer, {
        ...input,
        changes: [{ id: 'new', title: 'New', content: 'Different' }],
      }),
    hasCode('request_conflict'),
  );
  await assert.rejects(
    async () => await f.paper.patch(f.producer, { ...input, requestId: f.request() }),
    hasCode('paper_revision_conflict'),
  );
  const claim = await f.artifacts.create(f.producer, {
    title: 'Evidence',
    content: 'Source evidence',
  });
  const citation = await f.paper.cite(f.producer, {
    expectedRevision: 0,
    requestId: f.request(),
    identifier: 'ARXIV:1234.5678',
    title: 'Baseline paper',
    sectionIds: ['baselines'],
    refs: [`artifact:${claim.id}`],
  });
  assert.equal(citation.identifier, 'arxiv:1234.5678');
  assert.equal(citation.revision, 1);
  await assert.rejects(
    async () =>
      await f.paper.patch(f.producer, {
        kind: 'literature',
        expectedRevision: 1,
        requestId: f.request(),
        changes: [{ id: 'baselines', remove: true }],
      }),
    hasCode('paper_section_referenced'),
  );
  await assert.rejects(
    async () =>
      await f.paper.cite(f.producer, {
        expectedRevision: 0,
        requestId: f.request(),
        identifier: 'doi:missing',
        title: 'Fake link',
        refs: ['claim:claim_missing'],
      }),
    hasCode('paper_reference_invalid'),
  );
  await assert.rejects(
    async () =>
      await f.paper.patch(f.reader, {
        kind: 'problem',
        expectedRevision: 1,
        requestId: f.request(),
        changes: [{ id: 'goals', content: 'No' }],
      }),
    hasCode('forbidden'),
  );
  await assert.rejects(
    async () =>
      await f.paper.patch(f.producer, {
        kind: 'results',
        expectedRevision: 0,
        requestId: f.request(),
        changes: [{ id: 'finding', title: 'Finding', content: 'Invented' }],
      }),
    hasCode('paper_review_required'),
  );
  const updated = await f.paper.patch(f.producer, {
    kind: 'literature',
    expectedRevision: 1,
    requestId: f.request(),
    changes: [{ id: 'scaling', content: 'Updated evidence only.' }],
  });
  assert.equal(updated.sections[1].content, 'Existing reference systems.');
  assert.equal((await f.paper.history(f.reader, 'literature')).length, 2);
  await f.reload();
  assert.deepEqual((await f.paper.read(f.reader)).documents.literature.current, updated);
  assert.equal((await f.paper.read(f.reader)).citations[0].id, citation.id);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE paper_revisions SET record=?', '{}'),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => await tx.run('DELETE FROM paper_citations')),
    /retained/,
  );
});

test('paper inputs reject accessors and proxies without executing them', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const input = {
    kind: 'problem',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      {
        id: 'problem',
        get content() {
          calls++;
          return 'No';
        },
      },
    ],
  };
  await assert.rejects(
    async () => await f.paper.patch(f.producer, input as Parameters<PaperService['patch']>[1]),
    hasCode('invalid_paper_input'),
  );
  assert.equal(calls, 0);
  const proxy = new Proxy(
    {},
    {
      get() {
        calls++;
        return 'No';
      },
    },
  );
  await assert.rejects(
    async () => await f.paper.patch(f.producer, proxy as Parameters<PaperService['patch']>[1]),
    hasCode('invalid_paper_input'),
  );
  assert.equal(calls, 0);
});

test('paper retains proposals without assignments and applies exact reviewed edits atomically with replay', async (t) => {
  const f = await fixture(t),
    p = await proposal(f);
  assert.equal((await f.paper.read(f.reader)).documents.methods.current.revision, 0);
  assert.equal((await f.paper.read(f.reader)).proposals[0].artifact.hash, p.artifact.hash);
  const input = { proposalId: p.id, source: p.source, reviewId: 'review-1' };
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.paper.accept(f.reviewer, input, tx);
        throw Error('abort verdict');
      }),
    /abort verdict/,
  );
  assert.equal((await f.paper.read(f.reader)).documents.methods.current.revision, 0);
  const accepted = await f.state.transaction(
    async (tx) => await f.paper.accept(f.reviewer, input, tx),
  );
  assert.deepEqual(
    await f.state.transaction(async (tx) => await f.paper.accept(f.reviewer, input, tx)),
    accepted,
  );
  assert.equal(accepted[0].source.id, 'experiment-1');
  assert.equal(
    (await f.paper.read(f.reader)).documents.methods.current.updatedBy,
    f.producer.actorId,
  );
  await f.reload();
  assert.equal(
    (await f.paper.read(f.reader)).documents.methods.published!.publication.reviewId,
    'review-1',
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE paper_proposals SET record=?', '{}'),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE paper_proposals SET acceptance=?', '{}'),
      ),
    /immutable/,
  );
});
test('paper prevents cross-project inputs, foreign authors, mismatched approval and self review', async (t) => {
  const f = await fixture(t),
    p = await proposal(f);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.paper.accept(
            f.operator,
            { proposalId: p.id, source: { ...p.source, id: 'other' }, reviewId: 'review' },
            tx,
          ),
      ),
    hasCode('paper_source_mismatch'),
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.paper.propose(
            f.operator,
            {
              artifactId: p.artifact.id,
              source: p.source,
              evidenceIds: p.evidence.map((a) => a.id),
            },
            tx,
          ),
      ),
    hasCode('invalid_evidence_author'),
  );
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' }),
    caller = { projectId: other.project.id, actorId: other.actor.id };
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.paper.accept(
            caller,
            { proposalId: p.id, source: p.source, reviewId: 'review' },
            tx,
          ),
      ),
    hasCode('paper_proposal_not_found'),
  );
  const artifact = await f.artifacts.create(caller, {
    title: 'Foreign',
    content: '{}',
    mediaType: 'application/json',
  });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.paper.propose(
            f.producer,
            { artifactId: artifact.id, source: p.source, evidenceIds: p.evidence.map((a) => a.id) },
            tx,
          ),
      ),
    hasCode('not_found'),
  );
});
test('a conflicting second document rolls back all accepted edits and preserves reviewable proposal history', async (t) => {
  const f = await fixture(t);
  const both = await proposal(f, [
    {
      kind: 'methods',
      expectedRevision: 0,
      changes: [{ id: 'method', title: 'Method', content: 'New method' }],
    },
    {
      kind: 'results' as 'methods',
      expectedRevision: 0,
      changes: [{ id: 'result', title: 'Result', content: 'New result' }],
    },
  ]);
  const other = await proposal(f, [
    {
      kind: 'results' as 'methods',
      expectedRevision: 0,
      changes: [{ id: 'result', title: 'Result', content: 'Concurrent accepted result' }],
    },
  ]);
  const disjoint = await proposal(f, [
    {
      kind: 'results' as 'methods',
      expectedRevision: 0,
      changes: [{ id: 'another', title: 'Another', content: 'Independent result' }],
    },
  ]);
  await f.state.transaction(
    async (tx) =>
      await f.paper.accept(
        f.reviewer,
        { proposalId: other.id, source: other.source, reviewId: 'other-review' },
        tx,
      ),
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.paper.accept(
            f.reviewer,
            { proposalId: both.id, source: both.source, reviewId: 'review' },
            tx,
          ),
      ),
    hasCode('paper_revision_conflict'),
  );
  assert.equal((await f.paper.read(f.reader)).documents.methods.current.revision, 0);
  assert.equal(
    (await f.paper.read(f.reader)).documents.results.current.sections[0].content,
    'Concurrent accepted result',
  );
  assert.equal(
    (await f.paper.read(f.reader)).proposals.find((p) => p.id === both.id)!.acceptance,
    null,
  );
  // A stale proposal whose sections nobody touched since still lands, on the current revision.
  const [published] = await f.state.transaction(
    async (tx) =>
      await f.paper.accept(
        f.reviewer,
        { proposalId: disjoint.id, source: disjoint.source, reviewId: 'disjoint-review' },
        tx,
      ),
  );
  assert.equal(published!.revision, 2);
  assert.deepEqual(
    (await f.paper.read(f.reader)).documents.results.current.sections.map((s) => s.id),
    ['result', 'another'],
  );
});
