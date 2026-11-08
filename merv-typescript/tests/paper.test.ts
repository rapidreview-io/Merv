import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { MervError, type Caller } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import { ProjectScope } from '@merv/scope';
import { mergeText } from '../packages/paper/src/merge.js';
import { openState } from './fixtures/state.js';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'paper-documents-'));
  const state = await openState(dir),
    scope = await createService(new ProjectScope(state)),
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
    );
  let paper = await createService(new PaperService(state, scope, artifacts)),
    count = 0;
  const boot = await scope.credentials.bootstrap({ projectName: 'Paper', actorName: 'Owner' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (role: 'producer' | 'reviewer' | 'reader') => {
    const a = await scope.credentials.issueActor(operator, { name: role, role });
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
test('paper keeps ordered section history, structured scope and scoped citation ledger with replay/CAS', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.paper.read(f.reader)).documents.problem.current.sections.map((s) => s.id),
    ['problem', 'scope', 'goals', 'constraints'],
  );
  const mutable = { ...f.producer };
  const patching = f.paper.patch(mutable, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      { id: 'problem', content: 'Can a smaller model match the baseline?' },
      { id: 'constraints', content: 'One fixed evaluation split.' },
    ],
  });
  Object.assign(mutable, f.operator);
  const problem = await patching;
  assert.equal(problem.updatedBy, f.producer.actorId);
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
  Object.assign(mutable, f.producer);
  const citing = f.paper.cite(mutable, {
    expectedRevision: 0,
    requestId: f.request(),
    identifier: 'ARXIV:1234.5678',
    title: 'Baseline paper',
    sectionIds: ['baselines'],
    refs: [`artifact:${claim.id}`],
  });
  Object.assign(mutable, f.operator);
  const citation = await citing;
  assert.equal(citation.updatedBy, f.producer.actorId);
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
  for (const kind of ['methods', 'results'] as const) {
    const edit = {
      kind,
      expectedRevision: 0,
      requestId: f.request(),
      changes: [{ id: 'finding', title: 'Finding', content: 'Main agent narrative.' }],
    };
    const saved = await f.paper.patch(f.producer, edit);
    assert.equal(saved.revision, 1);
    assert.deepEqual(await f.paper.patch(f.producer, edit), saved);
    assert.equal(saved.updatedBy, f.producer.actorId);
    await assert.rejects(
      f.paper.patch(f.reviewer, { ...edit, requestId: f.request() }),
      hasCode('forbidden'),
    );
  }
  const updated = await f.paper.patch(f.producer, {
    kind: 'literature',
    expectedRevision: 1,
    requestId: f.request(),
    changes: [{ id: 'scaling', content: 'Updated evidence only.' }],
  });
  assert.equal(updated.sections[1].content, 'Existing reference systems.');
  // History lists the revisions without their bodies, which each revision's own read returns.
  const listed = await f.paper.history(f.reader, 'literature');
  assert.deepEqual(
    listed.map(({ revision, sections }) => ({ revision, sections })),
    [1, 2].map((revision) => ({
      revision,
      sections: updated.sections.map(({ id, title }) => ({ id, title })),
    })),
  );
  assert.ok(!JSON.stringify(listed).includes('Updated evidence only.'));
  // Each is its revision with section bodies left out, field for field, sections last.
  const whole = await Promise.all([1, 2].map((n) => f.paper.revision(f.reader, 'literature', n)));
  const bare = whole.map((revision) => {
    const { sections, ...head } = revision!;
    return { ...head, sections: sections.map(({ id, title }) => ({ id, title })) };
  });
  assert.equal(JSON.stringify(listed), JSON.stringify(bare));
  // One retained revision reads by its number alone; a number never written reads as none.
  assert.deepEqual(await f.paper.revision(f.reader, 'literature', 2), updated);
  assert.equal((await f.paper.revision(f.reader, 'literature', 1))?.revision, 1);
  assert.equal(await f.paper.revision(f.reader, 'literature', 3), null);
  assert.equal(await f.paper.revision(f.reader, 'problem', 9), null);
  await f.reload();
  assert.deepEqual((await f.paper.read(f.reader)).documents.literature.current, updated);
  assert.equal((await f.paper.read(f.reader)).citations[0].id, citation.id);
  // Each stale replacement fits alone, but their merge must still fit one readable/editable section.
  const replace = (expectedRevision: number, content: string) => ({
    kind: 'methods' as const,
    expectedRevision,
    requestId: f.request(),
    changes: [{ id: 'finding', content }],
  });
  await f.paper.patch(f.producer, replace(1, 'first\nseparator\nlast'));
  const firstWriter = await f.paper.patch(
    f.producer,
    replace(2, `${'A'.repeat(60_000)}\nseparator\nlast`),
  );
  await assert.rejects(
    f.paper.patch(f.producer, replace(2, `first\nseparator\n${'B'.repeat(60_000)}`)),
    hasCode('paper_too_large'),
  );
  assert.deepEqual((await f.paper.document(f.reader, 'methods')).current, firstWriter);
  const other = await f.scope.credentials.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const outsider = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const caller = { ...outsider };
  const authorize = f.scope.require.bind(f.scope);
  f.scope.require = async (...args) => {
    const actor = await authorize(...args);
    Object.assign(caller, f.reader);
    return actor;
  };
  try {
    const workspace = await f.paper.read(caller);
    Object.assign(caller, outsider);
    const history = await f.paper.history(caller, 'literature');
    Object.assign(caller, outsider);
    const revision = await f.paper.revision(caller, 'literature', 1);
    assert.deepEqual(
      [workspace.documents.literature.current.revision, workspace.citations, history, revision],
      [0, [], [], null],
    );
  } finally {
    f.scope.require = authorize;
  }
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE paper_revisions SET record=?', '{}'),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => await tx.run('DELETE FROM paper_citations')),
    { code: 'state_constraint' },
  );
});

test('reviewer edits retain provenance, roll back together, and enforce revision and scope boundaries', async (t) => {
  const f = await fixture(t);
  const evidence = await f.artifacts.create(f.producer, {
    title: 'Evidence',
    content: 'Measured result',
  });
  const input = {
    documents: (['methods', 'results'] as const).map((kind) => ({
      kind,
      expectedRevision: 0,
      changes: [{ id: 'comparison', title: 'Comparison', content: 'Reviewer-authored narrative.' }],
    })),
    source: { kind: 'experiment' as const, id: 'experiment-1', revision: 3 },
    reviewId: 'review-1',
    verdict: 'needs_changes' as const,
    evidenceIds: [evidence.id],
  };
  const apply = (caller: Caller = f.reviewer, value = input) =>
    f.state.transaction((tx) => f.paper.applyReview(caller, value, tx));
  await assert.rejects(apply(f.producer), hasCode('forbidden'));
  await assert.rejects(apply(f.reader), hasCode('forbidden'));
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.paper.applyReview(f.reviewer, input, tx);
      throw Error('abort verdict');
    }),
    /abort verdict/,
  );
  assert.equal((await f.paper.read(f.reader)).documents.methods.current.revision, 0);
  const conflicting = structuredClone(input);
  conflicting.documents[1].expectedRevision = 1;
  await assert.rejects(apply(f.reviewer, conflicting), hasCode('paper_revision_conflict'));
  assert.equal((await f.paper.read(f.reader)).documents.methods.current.revision, 0);
  const invalid = structuredClone(input);
  Object.assign(invalid.documents[0], { kind: 'problem' });
  await assert.rejects(apply(f.reviewer, invalid), hasCode('invalid_paper_input'));
  const duplicate = structuredClone(input);
  duplicate.documents[1].kind = 'methods';
  await assert.rejects(apply(f.reviewer, duplicate), hasCode('invalid_paper_input'));
  const foreign = await f.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other owner',
  });
  await assert.rejects(
    apply({ actorId: foreign.actor.id, projectId: foreign.project.id }),
    hasCode('not_found'),
  );
  const caller = { ...f.reviewer };
  const pending = structuredClone(input);
  const publications = await f.state.transaction(async (tx) => {
    const applying = f.paper.applyReview(caller, pending, tx);
    Object.assign(caller, f.producer);
    pending.documents[0].changes[0].content = 'Changed after admission';
    return await applying;
  });
  assert.equal(publications.length, 2);
  for (const kind of ['methods', 'results'] as const) {
    const document = (await f.paper.read(f.reader)).documents[kind];
    assert.equal(document.current.updatedBy, f.reviewer.actorId);
    assert.equal(document.current.sections[0].content, 'Reviewer-authored narrative.');
    assert.equal(document.current.review?.id, input.reviewId);
    assert.equal(document.published?.publication.verdict, 'needs_changes');
    assert.equal(document.published?.publication.evidence[0].hash, evidence.hash);
  }
  await assert.rejects(apply(), hasCode('paper_revision_conflict'));
  const main = await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 1,
    requestId: f.request(),
    changes: [{ id: 'comparison', content: 'Main agent revision' }],
  });
  assert.equal(main.review, undefined);
  await f.reload();
  assert.equal((await f.paper.history(f.reader, 'methods')).length, 2);
  assert.equal(
    (await f.paper.read(f.reader)).documents.methods.published?.publication.reviewId,
    input.reviewId,
  );
  await assert.rejects(
    f.state.transaction((tx) => tx.run('UPDATE paper_revisions SET record=?', '{}')),
    { code: 'state_constraint' },
  );
});

test('three-way section merge keeps both writers apart from the lines both changed', () => {
  const base = ['First.', '', 'Second.', '', 'Third.'].join('\n');
  // Different paragraphs: both kept.
  assert.equal(
    mergeText(base, base.replace('Third.', 'Third, revised.'), base.replace('First.', 'First!')),
    ['First!', '', 'Second.', '', 'Third, revised.'].join('\n'),
  );
  // Both added a paragraph at the top: both kept, ours first.
  assert.equal(
    mergeText(base, `Ours.\n\n${base}`, `Theirs.\n\n${base}`),
    `Ours.\n\nTheirs.\n\n${base}`,
  );
  // The same change on both sides is made once.
  assert.equal(mergeText(base, `${base}\n\nSame.`, `${base}\n\nSame.`), `${base}\n\nSame.`);
  // The same paragraph, or one next to the other's, changed two ways: no merge.
  assert.equal(mergeText(base, base.replace('Second.', 'A'), base.replace('Second.', 'B')), null);
  assert.equal(mergeText('One paragraph.', 'One edited.', 'One changed.'), null);
  assert.equal(mergeText('a\nb', 'a!\nb', 'a\nb!'), null);
});
