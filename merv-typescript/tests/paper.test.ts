import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { PaperService, type PaperDocument, type PaperPatch } from '@merv/paper';
import { BoardService } from '@merv/board';
import { introductionFrom } from '@merv/paper/rules';
import { MervError, type Caller } from '@merv/contracts';
import { openState } from './fixtures/state.js';
import { paperToolsPlugin } from '@merv/paper/tools';
import type { ToolDefinition } from '@merv/api/types';
import type { Context } from 'cordis';
import { contextSections, paperInput } from '@merv/paper/context';
import { mergeText } from '../packages/paper/src/merge.js';
import { renderItems } from '../packages/context-builder/src/items.js';
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

test('the citation ledger takes no 2,001st entry, and an existing one still revises', async (t) => {
  const f = await fixture(t);
  const { projectId, actorId } = f.operator;
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO paper_citations(id,project_id,revision,identifier,record)
       SELECT 'citation_' || n, ?, 1, 'doi:' || n, json_build_object('id', 'citation_' || n,
         'projectId', ?::text, 'revision', 1, 'identifier', 'doi:' || n, 'title', 'Seeded',
         'authors', '[]'::json, 'year', null, 'url', null, 'notes', '', 'sectionIds', '[]'::json,
         'refs', '[]'::json, 'createdAt', '2026-10-14T00:00:00.000Z',
         'updatedAt', '2026-10-14T00:00:00.000Z', 'updatedBy', ?::text)::text
       FROM generate_series(1, 1999) AS n`,
      projectId,
      projectId,
      actorId,
    ),
  );
  const cite = (identifier: string, more = {}) =>
    f.paper.cite(f.producer, {
      expectedRevision: 0,
      requestId: f.request(),
      identifier,
      title: 'Cited',
      ...more,
    });
  assert.equal((await cite('doi:last')).revision, 1, 'the 2,000th entry is taken');
  await assert.rejects(cite('doi:over'), hasCode('paper_citations_full'));
  const revised = await cite('doi:7', { id: 'citation_7', expectedRevision: 1 });
  assert.equal(revised.revision, 2, 'an existing entry still revises');
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

test('an edit against an earlier revision merges with the edits made since, or names what to read again', async (t) => {
  const f = await fixture(t);
  const shared = [
    'Experiment A planned.',
    '',
    'Experiment B planned.',
    '',
    'Experiment C planned.',
  ];
  const start = await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [
      { id: 'shared', title: 'Shared', content: shared.join('\n') },
      { id: 'other', title: 'Other', content: 'Untouched.' },
    ],
  });
  const evidence = await f.artifacts.create(f.producer, { title: 'Evidence', content: 'x' });
  /** A reviewer's verdict with its edits to Methods, made against revision `at`. */
  const review = (at: number, changes: { id: string; title?: string; content?: string }[]) =>
    f.state.transaction((tx) =>
      f.paper.applyReview(
        f.reviewer,
        {
          documents: [{ kind: 'methods', expectedRevision: at, changes }],
          source: { kind: 'experiment', id: `experiment-${f.request()}`, revision: 1 },
          reviewId: `review-${f.request()}`,
          verdict: 'pass',
          evidenceIds: [evidence.id],
        },
        tx,
      ),
    );
  const sharedAt = async () =>
    (await f.paper.document(f.reader, 'methods')).current.sections.find((s) => s.id === 'shared')!;
  // Two reviewers read the same revision and change different paragraphs of the shared section.
  await review(start.revision, [
    { id: 'shared', content: shared.join('\n').replace('A planned.', 'A passed.') },
  ]);
  await review(start.revision, [
    { id: 'shared', content: shared.join('\n').replace('C planned.', 'C failed.') },
  ]);
  assert.equal(
    (await sharedAt()).content,
    ['Experiment A passed.', '', 'Experiment B planned.', '', 'Experiment C failed.'].join('\n'),
  );
  // A section nobody changed since takes the stale edit as written.
  await review(start.revision, [{ id: 'other', content: 'Rewritten.' }]);
  const now = (await f.paper.document(f.reader, 'methods')).current;
  assert.equal(now.revision, start.revision + 3);
  assert.equal(now.sections.find((s) => s.id === 'other')!.content, 'Rewritten.');
  // The paragraph another reviewer changed meanwhile is refused, naming what to read again.
  await assert.rejects(
    review(start.revision, [
      { id: 'shared', content: shared.join('\n').replace('A planned.', 'A inconclusive.') },
    ]),
    (error: unknown) =>
      hasCode('paper_revision_conflict')(error) &&
      /found 4, and since then section shared changed where your edit does: read it again \(paper\.read with kind methods and section shared\)/.test(
        (error as Error).message,
      ),
  );
  // So is removing or moving a section changed since, and a patch of the main agent alike.
  await assert.rejects(
    f.paper.patch(f.producer, {
      kind: 'methods',
      expectedRevision: start.revision,
      requestId: f.request(),
      changes: [{ id: 'shared', remove: true }],
    }),
    hasCode('paper_revision_conflict'),
  );
  assert.equal((await sharedAt()).content.includes('inconclusive'), false);
});

test('retired paper proposals stay stored but are no longer read, and an edit drops a stored proposal id', async (t) => {
  const f = await fixture(t);
  const legacy = {
    id: 'paperproposal_old',
    projectId: f.operator.projectId,
    source: { kind: 'experiment', id: 'experiment-old', revision: 3 },
    documents: [],
    evidence: [],
    acceptance: null,
  };
  // As a proposal once published it: the revision names its proposal.
  const published = {
    projectId: f.operator.projectId,
    kind: 'results',
    revision: 1,
    sections: [{ id: 'current', title: 'Current finding', content: 'Main agent text' }],
    updatedBy: f.producer.actorId,
    updatedAt: '2026-09-20T00:00:00Z',
    proposalId: legacy.id,
  };
  await f.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO paper_proposals(id,project_id,record,acceptance) VALUES(?,?,?,?)',
      legacy.id,
      f.operator.projectId,
      JSON.stringify(legacy),
      null,
    );
    await tx.run(
      'INSERT INTO paper_revisions(project_id,kind,revision,record) VALUES(?,?,?,?)',
      f.operator.projectId,
      'results',
      1,
      JSON.stringify(published),
    );
  });
  await f.reload();
  const read = await f.paper.read(f.reader);
  assert.deepEqual(Object.keys(read).sort(), ['citations', 'documents']);
  assert.equal(read.documents.results.current.sections[0].id, 'current');
  const next = await f.paper.patch(f.producer, {
    kind: 'results',
    expectedRevision: 1,
    requestId: f.request(),
    changes: [{ id: 'current', content: 'Edited' }],
  });
  assert.ok(!('proposalId' in next));
  const kept = await f.state.transaction((tx) =>
    tx.get<{ n: number }>('SELECT COUNT(*)::int AS n FROM paper_proposals'),
  );
  assert.equal(kept?.n, 1);
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
      { id: 'problem', content: 'p'.repeat(600) },
      { id: 'goals', content: 'g'.repeat(500) },
    ],
  });
  // Both fit whole, in the paper's order.
  assert.deepEqual(
    (await items(1100)).map((item) => item.id),
    ['paper:problem:current:1:0:problem', 'paper:problem:current:1:2:goals'],
  );
  // The budget keeps the first that fits by priority and names the other, which stays readable.
  const [kept, rest] = await items(1000);
  assert.equal(kept!.id, 'paper:problem:current:1:0:problem');
  assert.deepEqual(kept!.body, { text: 'p'.repeat(600) });
  assert.equal(rest!.id, 'paper:not-included');
  assert.equal(rest!.title, '1 more paper section, not included in this assignment');
  assert.deepEqual(rest!.body, {
    text: '- problem current: Goals — revision 1 — paper.read {"kind":"problem","revision":1,"section":"goals"}',
  });
  assert.equal(rest!.priority, 590);
  assert.deepEqual(rest!.refs, [
    { tool: 'paper.read', input: {} },
    { tool: 'paper.read', input: { kind: 'problem', revision: 1, section: 'goals' } },
  ]);
});

test("the list of paper sections left out never pushes a consumer's own evidence out of a tight budget", async () => {
  const maxChars = 24_000;
  const section = (id: string, chars: number) => ({ id, title: id, content: 'x'.repeat(chars) });
  const documents = {
    problem: {
      current: { revision: 1, updatedAt: null, sections: [section('problem', 9000)] },
      published: null,
    },
    literature: {
      current: {
        revision: 1,
        updatedAt: null,
        sections: Array.from({ length: 40 }, (_, n) => section(`s${n}`, 3000 + n)),
      },
      published: null,
    },
  } as never;
  const paper = paperInput(documents, maxChars);
  const definition = {
    name: 'probe',
    version: 1,
    kind: 'work',
    recipe: {
      maxChars,
      instructions: 'Work.',
      outputInstructions: 'Answer.',
      sections: [
        { key: 'task', title: 'Task', required: true },
        { key: 'projectPaper', title: 'Paper', required: false },
        { key: 'evidence', title: 'Evidence', required: false },
      ],
    },
  } as never;
  const evidence = 'e'.repeat(12_000);
  const { prompt } = await renderItems(
    definition,
    'hash',
    { actorId: 'act_1', projectId: 'prj_1' },
    {
      subject: {},
      inputs: {
        task: {
          items: [{ id: 'task:1', title: 'Task', body: { text: 'Do it.' }, embed: 'always' }],
        },
        projectPaper: paper,
        evidence: {
          items: [{ id: 'evidence:1', title: 'Evidence', body: { text: evidence }, priority: 800 }],
        },
      },
    } as never,
    { get: () => assert.fail('no artifacts'), read: async () => null },
  );
  assert.ok(prompt.includes(evidence), 'the evidence (800) is embedded');
  assert.ok(prompt.includes('paper:not-included'), 'what was left out is still named');
});

test('The Introduction is written from the current Problem, at its revision, and Scope holds none', async (t) => {
  const f = await fixture(t);
  const introduction = async () => {
    const problem = (await f.paper.documents(f.reader)).problem.current;
    return { revision: problem.revision, text: introductionFrom(problem) };
  };
  assert.deepEqual(await introduction(), { revision: 0, text: '' });
  const patch = async (changes: { id: string; content: string }[]) =>
    await f.paper.patch(f.producer, {
      kind: 'problem',
      expectedRevision: (await f.paper.documents(f.producer)).problem.current.revision,
      requestId: f.request(),
      changes,
    });
  await patch([{ id: 'scope', content: '  ' }]);
  assert.deepEqual(await introduction(), { revision: 1, text: '' });
  await patch([
    { id: 'problem', content: 'Can this comparison be evaluated reliably?' },
    { id: 'goals', content: 'Retain independently verified evidence.' },
  ]);
  assert.deepEqual(await introduction(), {
    revision: 2,
    text: '## Problem\n\nCan this comparison be evaluated reliably?\n\n## Goals\n\nRetain independently verified evidence.',
  });
  // Any other document leaves it alone; only the Problem's sections are in it.
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'm', title: 'M', content: 'Method' }],
  });
  assert.equal((await f.paper.documents(f.reader)).problem.current.revision, 2);
  assert.equal(
    introductionFrom({
      sections: [
        { id: 'problem', title: 'Problem', content: 'é'.repeat(20_000) },
        { id: 'literature', title: 'Literature', content: 'Not part of the Problem.' },
      ],
    }),
    `## Problem\n\n${'é'.repeat(20_000)}`,
  );
  // Scope keeps no Introduction of its own, and offers no tool to write one.
  const project = await f.scope.project(f.operator);
  assert.deepEqual(Object.keys(project).sort(), ['admin', 'createdAt', 'id', 'name']);
  assert.equal('updateProjectContext' in f.scope, false);
});

test('One document is read alone, as the whole paper reads it', async (t) => {
  const f = await fixture(t);
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'm', title: 'M', content: 'Method' }],
  });
  const all = await f.paper.documents(f.reader);
  const asked: string[][] = [];
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = ((fn: Parameters<typeof transaction>[0]) =>
    transaction((tx) => {
      const { all } = tx;
      Object.assign(tx, {
        all: (sql: string, ...params: never[]) => (
          sql.includes('paper_revisions') && asked.push(params),
          all(sql, ...params)
        ),
      });
      return fn(tx);
    })) as typeof f.state.transaction;
  try {
    for (const kind of ['problem', 'literature', 'methods', 'results'] as const)
      assert.deepEqual(await f.paper.document(f.reader, kind), all[kind]);
  } finally {
    f.state.transaction = transaction;
  }
  // Each read names its one kind and no other.
  assert.deepEqual(
    asked.map((params) =>
      params.filter((value) => ['problem', 'literature', 'methods', 'results'].includes(value)),
    ),
    [['problem'], ['literature'], ['methods'], ['results']],
  );
  await assert.rejects(f.paper.document(f.reader, 'abstract' as never), {
    code: 'invalid_paper_input',
  });
});

test('reads made outside a snapshot neither wait for nor take the writer lock', async (t) => {
  const f = await fixture(t);
  const board = await createService(new BoardService(f.state, f.scope));
  const { id } = await board.create(f.operator, 'Ideas');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const writer = f.state.transaction(async () => (locked(), await held));
  await new Promise<void>((resolve) => (locked = resolve));
  // Pi's turn context reads the paper, and screen.look a board's picture, outside any snapshot:
  // both end while a writer holds the lock (one waiting for it would fail at the lock timeout).
  await Promise.all([f.paper.documents(f.reader), board.scene(f.reader, id)]).finally(release);
  await writer;
});

test('a revision past exact integers is refused as input; a section range ends whole', async (t) => {
  const f = await fixture(t);
  const tools = new Map<string, ToolDefinition>();
  paperToolsPlugin.apply({
    paper: f.paper,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (tool: ToolDefinition) => tools.set(tool.name, tool),
      contributeInstructions() {},
      contributeContext() {},
    },
  } as unknown as Context);
  const read = tools.get('paper.read')!;
  assert.equal(read.inputSchema.safeParse({ kind: 'methods', revision: 1e19 }).success, false);
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'm', title: 'M', content: 'a🚀b' }],
  });
  // Two characters would end in half the emoji: the range stops before it.
  const part = await read.handler(f.reader, { kind: 'methods', section: 'm', length: 2 });
  assert.equal((part as { content: string }).content, 'a');
});

test('paper.read refuses a range without its section, outlines a document, and shows an agent each published section once', async (t) => {
  const f = await fixture(t);
  const tools = new Map<string, ToolDefinition>();
  paperToolsPlugin.apply({
    paper: f.paper,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (tool: ToolDefinition) => tools.set(tool.name, tool),
      contributeInstructions() {},
      contributeContext() {},
    },
  } as unknown as Context);
  const read = tools.get('paper.read')!;
  const call = async (input: object) => await read.handler(f.reader, read.inputSchema.parse(input));
  const shown = async (input: object) =>
    JSON.parse((read.present!(await call(input)).content[0] as { text: string }).text);
  const evidence = await f.artifacts.create(f.producer, { title: 'Evidence', content: 'Result' });
  // A reviewer publishes Methods at revision 1, as review.submit's paperChanges do.
  await f.state.transaction((tx) =>
    f.paper.applyReview(
      f.reviewer,
      {
        documents: [
          {
            kind: 'methods',
            expectedRevision: 0,
            changes: [
              { id: 'design', title: 'Design', content: 'Planned design.' },
              { id: 'data', title: 'Data', content: 'Held-out split.' },
            ],
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
  // offset and length without a section were dropped and the whole document returned; now
  // they are refused, naming each section and its length, at the current or a given revision.
  for (const input of [
    { kind: 'methods', length: 100 },
    { kind: 'methods', revision: 1, offset: 5 },
  ])
    await assert.rejects(
      call(input),
      (error: MervError) =>
        error.code === 'invalid_paper_input' &&
        error.message ===
          'offset and length read part of one section’s content, so name its section too: methods revision 1 holds design (15 characters), data (15 characters)',
    );
  await assert.rejects(
    call({ kind: 'methods', section: 'results' }),
    (error: MervError) =>
      error.code === 'not_found' &&
      /^Section results is not in the document: methods revision 1 holds design/.test(
        error.message,
      ),
  );
  // Neither history nor outline takes what it would drop, and neither reads without a kind.
  for (const input of [
    { history: true },
    { outline: true },
    { kind: 'methods', history: true, revision: 1 },
    { kind: 'methods', outline: true, section: 'design' },
    { kind: 'methods', outline: true, length: 10 },
  ])
    await assert.rejects(call(input), { code: 'invalid_paper_input' });
  // The outline: ids, titles and lengths, no content, and the revision last published.
  const outline = (await call({ kind: 'methods', outline: true })) as Record<string, unknown>;
  assert.deepEqual(
    [outline.revision, outline.sections, outline.publishedRevision],
    [
      1,
      [
        { id: 'design', title: 'Design', length: 15 },
        { id: 'data', title: 'Data', length: 15 },
      ],
      1,
    ],
  );
  assert.equal(
    ((await call({ kind: 'methods', revision: 1, outline: true })) as Record<string, unknown>)
      .publishedRevision,
    undefined,
  );
  // Published at the current revision, every published section reads as the current one: an
  // agent is shown each once, while the JSON answer (Merv's page) keeps them whole.
  const same = await shown({ kind: 'methods' });
  assert.deepEqual(
    same.current.sections.map(({ content }: { content: string }) => content),
    ['Planned design.', 'Held-out split.'],
  );
  assert.deepEqual(same.published.document.sections, [
    { id: 'design', title: 'Design', sameAsCurrent: true },
    { id: 'data', title: 'Data', sameAsCurrent: true },
  ]);
  assert.equal(same.published.publication.reviewId, 'review-1');
  const whole = (await call({ kind: 'methods' })) as PaperDocument;
  assert.equal(whole.published!.document.sections[0].content, 'Planned design.');
  // A later direct edit: only the section it changed is shown in both revisions.
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 1,
    requestId: f.request(),
    changes: [{ id: 'design', content: 'Revised design.' }],
  });
  for (const document of [await shown({ kind: 'methods' }), (await shown({})).documents.methods])
    assert.deepEqual(document.published.document.sections, [
      { id: 'design', title: 'Design', content: 'Planned design.' },
      { id: 'data', title: 'Data', sameAsCurrent: true },
    ]);
  // Other answers are shown as they are.
  assert.deepEqual(
    await shown({ kind: 'methods', section: 'data' }),
    await call({ kind: 'methods', section: 'data' }),
  );
});

test('a section changes in part by edits, each find quoted once, also past the edits made since', async (t) => {
  const f = await fixture(t);
  const text = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].join('\n\n');
  await f.paper.patch(f.producer, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: f.request(),
    changes: [{ id: 'design', title: 'Design', content: text }],
  });
  const patch = (expectedRevision: number, changes: PaperPatch['changes']) =>
    f.paper.patch(f.producer, {
      kind: 'methods',
      expectedRevision,
      requestId: f.request(),
      changes,
    });
  const planned = 'Planned: experiment X tests whether Y holds.';
  // One sentence added after the second paragraph: only it is sent.
  const added = await patch(1, [
    {
      id: 'design',
      edits: [{ find: 'Second paragraph.', replace: `Second paragraph.\n\n${planned}` }],
    },
  ]);
  assert.deepEqual(added.sections, [
    {
      id: 'design',
      title: 'Design',
      content: ['First paragraph.', 'Second paragraph.', planned, 'Third paragraph.'].join('\n\n'),
    },
  ]);
  // A find that is not there, or not once, is refused by its number and quoted.
  const refused = async (changes: PaperPatch['changes'], message: string | RegExp) =>
    await assert.rejects(
      patch(2, changes),
      (error: MervError) =>
        error.code === 'invalid_paper_input' &&
        (typeof message === 'string' ? error.message === message : message.test(error.message)),
    );
  await refused(
    [{ id: 'design', edits: [{ find: 'Fourth paragraph.', replace: 'x' }] }],
    'Edit 1 of section design finds "Fourth paragraph." nowhere in methods revision 2: each find quotes text that occurs exactly once in the section as paper.read with kind methods and section design returns it',
  );
  await refused(
    [{ id: 'design', edits: [{ find: ' paragraph.', replace: 'x' }] }],
    /finds " paragraph\." more than once in methods revision 2: .*, so quote more of the text around it$/,
  );
  await refused(
    [
      {
        id: 'design',
        edits: [
          { find: 'First paragraph.', replace: 'Opening.' },
          { find: 'First paragraph.', replace: 'Again.' },
        ],
      },
    ],
    /^Edit 2 of section design finds "First paragraph\." nowhere in methods revision 2, after the edits before it: /,
  );
  await refused(
    [{ id: 'design', content: 'Whole.', edits: [{ find: 'First', replace: 'x' }] }],
    'Section design takes content, which replaces it whole, or edits, which change part of it, not both',
  );
  await refused(
    [{ id: 'results', edits: [{ find: 'First', replace: 'x' }] }],
    'edits change an existing section, and methods revision 2 has no section results: a new section needs title and content',
  );
  await refused(
    [{ id: 'design', remove: true, edits: [{ find: 'First', replace: 'x' }] }],
    'Remove must name one existing section without other changes',
  );
  // Another writer changed the first paragraph meanwhile: an edit read at revision 2 applies
  // to theirs wherever its find still occurs once.
  await patch(2, [{ id: 'design', edits: [{ find: 'First paragraph.', replace: 'Opening.' }] }]);
  const merged = await patch(2, [
    { id: 'design', edits: [{ find: 'Third paragraph.', replace: 'Closing.' }] },
  ]);
  assert.equal(
    merged.sections[0].content,
    ['Opening.', 'Second paragraph.', planned, 'Closing.'].join('\n\n'),
  );
  // Quoting text changed since, at an earlier revision, is a conflict that names the section.
  await assert.rejects(
    patch(2, [{ id: 'design', edits: [{ find: 'First paragraph.', replace: 'Start.' }] }]),
    (error: MervError) =>
      error.code === 'paper_revision_conflict' &&
      error.message ===
        'Expected revision 2, found 4, and since then section design changed where your edit does: read it again (paper.read with kind methods and section design) and resend your methods edit at revision 4',
  );
  // A whole section resent into a conflict is told what edits spare.
  await assert.rejects(
    patch(2, [{ id: 'design', content: text.replace('First paragraph.', 'Start.') }]),
    (error: MervError) =>
      error.code === 'paper_revision_conflict' &&
      error.message.endsWith(
        'resend your methods edit at revision 4, with edits [{find, replace}] for only what you change rather than content to replace a section whole',
      ),
  );
  // A reviewer's paperChanges take edits as well, and publish the section they changed.
  const evidence = await f.artifacts.create(f.producer, { title: 'Evidence', content: 'Result' });
  const [publication] = await f.state.transaction((tx) =>
    f.paper.applyReview(
      f.reviewer,
      {
        documents: [
          {
            kind: 'methods',
            expectedRevision: 4,
            changes: [
              { id: 'design', edits: [{ find: planned, replace: `${planned} Approved.` }] },
            ],
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
  assert.deepEqual([publication.revision, publication.sectionIds], [5, ['design']]);
  assert.match(
    (await f.paper.document(f.reader, 'methods')).current.sections[0].content,
    /Approved\.\n\nClosing\.$/,
  );
});

test('edits keep a section within the 100,000 characters its whole content may have', async (t) => {
  const f = await fixture(t);
  const patch = (expectedRevision: number, changes: PaperPatch['changes']) =>
    f.paper.patch(f.producer, {
      kind: 'results',
      expectedRevision,
      requestId: f.request(),
      changes,
    });
  await patch(0, [{ id: 'long', title: 'Long', content: `${'a'.repeat(99_986)}End.` }]);
  await assert.rejects(
    patch(1, [{ id: 'long', edits: [{ find: 'End.', replace: 'End. One sentence more.' }] }]),
    (error: MervError) =>
      error.code === 'paper_too_large' &&
      error.message ===
        'Section long would hold 100009 characters after its edits, and a section holds at most 100,000: put the rest in a section of its own',
  );
  const kept = await patch(1, [{ id: 'long', edits: [{ find: 'End.', replace: 'End. Ten.' }] }]);
  assert.equal(kept.sections[0].content.length, 99_995);
});

test('a conflict over a section removed since does not suggest edits, which it cannot take', async (t) => {
  const f = await fixture(t);
  const patch = (expectedRevision: number, changes: PaperPatch['changes']) =>
    f.paper.patch(f.producer, {
      kind: 'methods',
      expectedRevision,
      requestId: f.request(),
      changes,
    });
  await patch(0, [
    { id: 'kept', title: 'Kept', content: 'Stays.' },
    { id: 'gone', title: 'Gone', content: 'Goes.' },
  ]);
  await patch(1, [{ id: 'gone', remove: true }]);
  await assert.rejects(
    patch(1, [{ id: 'gone', content: 'Goes, revised.' }]),
    (error: MervError) =>
      error.code === 'paper_revision_conflict' &&
      error.message ===
        'Expected revision 1, found 2, and since then section gone changed where your edit does: read it again (paper.read with kind methods and section gone) and resend your methods edit at revision 2',
  );
});
