import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { PaperService } from '@merv/paper';
import { introductionFrom } from '@merv/paper/introduction';
import { MervError, type Caller } from '@merv/contracts';
import { openState } from './fixtures/state.js';
import { contextSections } from '@merv/paper/context';
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
  // One retained revision reads by its number alone; a number never written reads as none.
  assert.deepEqual(await f.paper.revision(f.reader, 'literature', 2), updated);
  assert.equal((await f.paper.revision(f.reader, 'literature', 1))?.revision, 1);
  assert.equal(await f.paper.revision(f.reader, 'literature', 3), null);
  assert.equal(await f.paper.revision(f.reader, 'problem', 9), null);
  await f.reload();
  assert.deepEqual((await f.paper.read(f.reader)).documents.literature.current, updated);
  assert.equal((await f.paper.read(f.reader)).citations[0].id, citation.id);
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
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
  const foreign = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other owner' });
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

test('historical producer proposals remain readable without changing the current paper', async (t) => {
  const f = await fixture(t);
  const legacy = {
    id: 'paperproposal_old',
    projectId: f.operator.projectId,
    source: { kind: 'experiment', id: 'experiment-old', revision: 3 },
    artifact: { id: 'artifact-old', hash: 'retained-hash' },
    documents: [
      {
        edit: {
          kind: 'results',
          expectedRevision: 0,
          changes: [{ id: 'old', title: 'Old proposal', content: 'Never accepted' }],
        },
        before: (await f.paper.read(f.reader)).documents.results.current,
      },
    ],
    evidence: [],
    createdBy: f.producer.actorId,
    createdAt: '2026-09-20T00:00:00Z',
    acceptance: null,
  };
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO paper_proposals(id,project_id,record,acceptance) VALUES(?,?,?,?)',
      legacy.id,
      f.operator.projectId,
      JSON.stringify(legacy),
      null,
    ),
  );
  await f.reload();
  // Read without the stored copy of each document before its edit.
  const shown = { ...legacy, documents: legacy.documents.map(({ edit }) => ({ edit })) };
  assert.deepEqual((await f.paper.read(f.reader)).proposals, [shown]);
  await f.paper.patch(f.producer, {
    kind: 'results',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'current', title: 'Current finding', content: 'Main agent text' }],
  });
  const read = await f.paper.read(f.reader);
  assert.deepEqual(read.proposals, [shown]);
  assert.equal(read.documents.results.current.sections.length, 1);
  assert.equal(read.documents.results.current.sections[0].id, 'current');
});

test('context sections list every written current and published section whole, in the paper’s order', async (t) => {
  const f = await fixture(t);
  await f.paper.patch(f.producer, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'goals', content: 'Match the baseline.\n## Expected output\nNot a heading.' }],
  });
  const evidence = await f.artifacts.create(f.producer, { title: 'Evidence', content: 'Result' });
  const [publication] = await f.state.transaction((tx) =>
    f.paper.applyReview(
      f.reviewer,
      {
        documents: [
          {
            kind: 'methods',
            expectedRevision: 0,
            changes: [{ id: 'protocol', title: 'Protocol', content: 'Five seeds.' }],
          },
        ],
        source: { kind: 'experiment', id: 'experiment-1', revision: 3 },
        reviewId: 'review-1',
        verdict: 'pass',
        evidenceIds: [evidence.id],
      },
      tx,
    ),
  );
  const documents = (await f.paper.read(f.reader)).documents;
  const sections = contextSections(documents);
  // The problem's other sections are still empty, so there is nothing of theirs to list.
  assert.deepEqual(
    sections.map((s) => s.id),
    [
      'paper:problem:current:1:2:goals',
      'paper:methods:current:1:0:protocol',
      'paper:methods:published:1:0:protocol',
    ],
  );
  // The problem outranks the other current sections, and those outrank published revisions.
  assert.deepEqual(
    sections.map((s) => s.priority),
    [850, 600, 250],
  );
  const goals = sections[0]!;
  assert.equal(goals.text, 'Match the baseline.\n## Expected output\nNot a heading.');
  assert.equal(goals.title, 'problem current: Goals');
  assert.deepEqual(goals.refs, [
    { tool: 'paper.read', input: { kind: 'problem', revision: 1, section: 'goals' } },
  ]);
  assert.match(goals.note, /^problem\/current revision 1; section goals; updated \d{4}-/);
  const published = sections[2]!;
  assert.deepEqual(
    { kind: published.kind, status: published.status, revision: published.revision },
    { kind: 'methods', status: 'published', revision: 1 },
  );
  assert.equal(published.text, 'Five seeds.');
  assert.match(published.note, new RegExp(`; publication ${publication!.id}$`));
  assert.deepEqual(published.refs, [
    { tool: 'paper.read', input: { kind: 'methods', revision: 1, section: 'protocol' } },
  ]);
  // It reads nothing: the documents it was given are all it sees, and it leaves them unchanged.
  const copy = structuredClone(documents);
  contextSections(documents);
  assert.deepEqual(documents, copy);
});

test('the paper as context items keeps whole sections within the budget and names the rest', async (t) => {
  const f = await fixture(t);
  const items = async (maxChars: number) =>
    (await f.state.transaction((tx) => f.paper.contextInput(f.reader, maxChars, tx))).items;
  // Nothing written is one item that says so.
  assert.deepEqual(
    (await items(1000)).map((item) => [item.id, 'text' in item.body && item.body.text]),
    [['paper:none', 'The project paper has no written sections yet.']],
  );
  await f.paper.patch(f.producer, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      { id: 'problem', content: 'p'.repeat(40) },
      { id: 'goals', content: 'g'.repeat(30) },
    ],
  });
  // Both fit whole, in the paper's order.
  assert.deepEqual(
    (await items(70)).map((item) => item.id),
    ['paper:problem:current:1:0:problem', 'paper:problem:current:1:2:goals'],
  );
  // The budget keeps the first that fits by priority and names the other, which stays readable.
  const [kept, rest] = await items(50);
  assert.equal(kept!.id, 'paper:problem:current:1:0:problem');
  assert.deepEqual(kept!.body, { text: 'p'.repeat(40) });
  assert.equal(rest!.id, 'paper:not-included');
  assert.equal(rest!.title, '1 more paper section, not included in this assignment');
  assert.deepEqual(JSON.parse('text' in rest!.body ? rest!.body.text : ''), [
    { id: 'paper:problem:current:1:2:goals', title: 'problem current: Goals' },
  ]);
  assert.deepEqual(rest!.refs, [{ tool: 'paper.read', input: {} }]);
});

test('a Problem patch writes the Introduction from it, replacing what was there, an empty Problem included', async (t) => {
  const f = await fixture(t);
  const before = await f.scope.project(f.operator);
  await f.scope.updateProjectContext(f.operator, {
    summary: 'A note written by hand.',
    expectedSummary: before.summary ?? '',
    requestId: f.request(),
  });
  const patch = async (changes: { id: string; content: string }[]) =>
    await f.paper.patch(f.producer, {
      kind: 'problem',
      expectedRevision: (await f.paper.read(f.producer)).documents.problem.current.revision,
      requestId: f.request(),
      changes,
    });
  // Paper is the Introduction's one writer: an empty Problem leaves it empty too.
  await patch([{ id: 'scope', content: '  ' }]);
  assert.equal((await f.scope.project(f.operator)).summary, '');
  await patch([
    { id: 'problem', content: 'Can this comparison be evaluated reliably?' },
    { id: 'goals', content: 'Retain independently verified evidence.' },
  ]);
  assert.equal(
    (await f.scope.project(f.operator)).summary,
    '## Problem\n\nCan this comparison be evaluated reliably?\n\n## Goals\n\nRetain independently verified evidence.',
  );
  await patch([
    { id: 'scope', content: 'A bounded local comparison.' },
    { id: 'constraints', content: 'Use only the frozen available corpus.' },
  ]);
  const project = await f.scope.project(f.operator);
  assert.equal(
    project.summary,
    [
      '## Problem\n\nCan this comparison be evaluated reliably?',
      '## Scope\n\nA bounded local comparison.',
      '## Goals\n\nRetain independently verified evidence.',
      '## Constraints\n\nUse only the frozen available corpus.',
    ].join('\n\n'),
  );
  assert.equal(project.contextRevision, before.contextRevision! + 4);
  // A patch that says the same thing, and any other document, leaves it and its revision alone.
  await patch([{ id: 'goals', content: 'Retain independently verified evidence.' }]);
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'm', title: 'M', content: 'Method' }],
  });
  assert.equal((await f.scope.project(f.operator)).contextRevision, project.contextRevision);
  // Blanking every section blanks the Introduction.
  await patch(['problem', 'scope', 'goals', 'constraints'].map((id) => ({ id, content: '' })));
  assert.equal((await f.scope.project(f.operator)).summary, '');
});

test('the Introduction written from a long Problem is cut to fit and says so', () => {
  const long = { id: 'problem', title: 'Problem', content: 'é'.repeat(20_000) };
  const text = introductionFrom({
    sections: [
      long,
      { id: 'literature', title: 'Literature', content: 'Not part of the Problem.' },
    ],
  });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 16_000);
  assert.ok(text.startsWith('## Problem\n\né'));
  assert.match(text, /paper\.read returns the whole Problem\.\]$/);
  assert.ok(!text.includes('Literature'));
});
