/**
 * The paper, rendered. Each test states one thing the page must do without words:
 * offer a section's control as a glyph that still has a name, read a section as
 * the markdown it was written in, say nothing where there is nothing to say, and
 * never leave a bare heading or a dangling separator where a fact is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
// jsdom lays nothing out, so nothing ever scrolls into view: the outline's watcher is inert.
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
});

const { createElement } = await import('react');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');
const { PaperView } = await import('../packages/ui/web/views/paper.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const paper = {
  id: 'paper',
  label: 'Paper',
  group: 'work',
  order: 16,
  path: '/paper',
  view: { kind: 'paper' },
  status: {},
  readable: false,
};
const section = (id: string, title: string, content = '') => ({ id, title, content });
const revision = (kind: string, sections: unknown[], n = sections.length ? 1 : 0) => ({
  projectId: project.id,
  kind,
  revision: n,
  sections,
  updatedBy: n ? 'actor_1' : null,
  updatedAt: n ? '2026-09-19T10:00:00Z' : null,
});
const workspace = (problem: unknown[], literature: unknown[] = []) => ({
  documents: {
    problem: { current: revision('problem', problem), published: null },
    literature: { current: revision('literature', literature), published: null },
    methods: { current: revision('methods', []), published: null },
    results: { current: revision('results', []), published: null },
  },
  citations: [],
});

function boot(held: ReturnType<typeof workspace>, role = 'operator') {
  const actor = { id: 'actor_1', projectId: project.id, name: 'Operator', role, active: true };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor, projects: [project] } });
  serve('/tools/ui.shell', {
    body: { result: { actor, project, rows: [paper], plugins: [] } },
  });
  // One tool, two questions: the workspace, and the revisions one document retained.
  serve('/tools/paper.read', (_call, sent) => ({
    body: {
      result: sent.history
        ? [held.documents[sent.kind as keyof typeof held.documents].current]
        : held,
    },
  }));
  serve('/tools/artifact.list', { body: { result: [] } });
  serve('/tools/actor.list', { body: { result: [actor] } });
}
const open = async () => {
  await mount(createElement(MemoryRouter, { initialEntries: ['/paper'] }, createElement(App)));
  await settle(20);
};
const tools = () => [...document.querySelectorAll<HTMLButtonElement>('.paper .head-tool')];

test('a section’s control is a named glyph, its text is read as markdown, and nothing empty is drawn', async (t) => {
  t.after(async () => await unmount());
  boot(
    workspace([
      section('s_problem', 'Problem', '## Why\n\nGrokking is **late** generalisation.'),
      section('s_scope', 'Scope'),
    ]),
  );
  await open();

  // Every control beside a heading is one glyph with a name and a hover title, never a phrase.
  assert.deepEqual(
    tools().map((tool) => tool.getAttribute('aria-label')),
    ['Edit Problem', 'Edit Scope', 'New section', 'New citation', 'New section', 'New section'],
  );
  for (const tool of tools()) {
    assert.equal(tool.textContent, '', 'the face is the glyph alone');
    assert.equal(tool.getAttribute('title'), tool.getAttribute('aria-label'));
    assert.ok(tool.querySelector('svg[aria-hidden="true"]'));
  }

  const written = document.querySelector('.sec:not(.sec--unwritten)')!;
  assert.equal(written.querySelector('.md strong')!.textContent, 'late');
  assert.ok(!written.textContent!.includes('**'), 'the marks are read, not printed');
  // What nobody has written is its heading and the glyph that begins it, which is
  // always drawn there; no sentence repeats down the page that nothing is written.
  const unwritten = document.querySelector('.sec--unwritten')!;
  assert.equal(unwritten.textContent, '1.2Scope');
  assert.ok(unwritten.querySelector('.head-tool'));
  assert.equal(document.querySelectorAll('.paper-doc--unwritten').length, 3);
  assert.ok(!/not written|no sections/i.test(text()));

  // Every clause of the standing says something: none is drawn for a fact that is absent.
  for (const clause of document.querySelectorAll('.page-summary .states-clause'))
    assert.notEqual(clause.textContent, '');
  // Nothing relates to it yet, so no Related section; and the one revision there is
  // stands under its document's heading, so History has nothing earlier to add.
  const titles = [...document.querySelectorAll('.section-title')].map((node) => node.textContent);
  assert.deepEqual(titles, ['Document', 'Details']);
  assert.equal(text().split('never reviewed').length - 1, 1, 'the edit line is said once');
  assert.ok(!text().includes('Fullest document'));
  assert.ok(text().includes('Longest documentProblem & scope'));
});

test('a section is linked by its document and title, and only a repeated title adds the end of its id', async (t) => {
  t.after(async () => await unmount());
  boot(
    workspace([
      section('problem', 'Problem'),
      section('scope', 'Scope'),
      section('s_scope2', 'Scope'),
    ]),
  );
  await open();
  assert.deepEqual(
    [...document.querySelectorAll('.sec')].map((node) => node.id),
    ['problem-problem', 'problem-scope', 'problem-scope-scope2'],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.out-sec')].map((link) => link.getAttribute('href')),
    ['#problem-problem', '#problem-scope', '#problem-scope-scope2'],
  );
});

test('with nothing written the limits row is left out, and a reader is offered no control', async (t) => {
  t.after(async () => await unmount());
  boot(workspace([]), 'reader');
  await open();
  assert.equal(tools().length, 0);
  assert.ok(!text().includes('Longest document'));
  // An unpublished paper nobody has touched is its state word alone: no clause, no separator.
  assert.equal(document.querySelectorAll('.page-summary .states-clause').length, 1);
  assert.ok(!text().includes('—'), 'no em dash stands in for a fact that does not exist');
});

test('the form a glyph opens says Save or Create once, and Escape hands the cursor back', async (t) => {
  t.after(async () => await unmount());
  boot(workspace([section('s_problem', 'Problem', 'Text.')]));
  await open();
  const edit = tools().find((tool) => tool.getAttribute('aria-label') === 'Edit Problem')!;
  await act(async () => edit.click());
  const form = document.querySelector<HTMLFormElement>('form[aria-label="Edit Problem"]')!;
  assert.equal(form.querySelector('h3')!.textContent, 'Edit Problem');
  assert.deepEqual(
    [...form.querySelectorAll('button')].map((button) => button.textContent),
    ['Save', 'Cancel'],
  );
  // Booleans, not nodes: a failed comparison of two elements prints the whole document.
  assert.ok(document.activeElement === form.querySelector('input'), 'the first field has focus');
  // One section form at a time: the other section controls stand down, the ledger keeps its own.
  assert.deepEqual(
    tools().map((tool) => tool.getAttribute('aria-label')),
    ['New citation'],
  );

  await act(async () => {
    document.activeElement!.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle(0);
  assert.equal(document.querySelector('form[aria-label="Edit Problem"]'), null);
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Edit Problem');

  const add = tools().find((tool) => tool.getAttribute('aria-label') === 'New section')!;
  await act(async () => add.click());
  const made = document.querySelector<HTMLFormElement>('form[aria-label="New section"]')!;
  assert.equal(made.querySelector('button[type="submit"]')!.textContent, 'Create');
});

test('a citation’s retained files are chosen by name, and the tool is sent artifact references', async (t) => {
  t.after(async () => await unmount());
  const CURVE = `art_${'a'.repeat(32)}`;
  const TABLE = `art_${'b'.repeat(32)}`;
  const file = (id: string, title: string) => ({
    id,
    projectId: project.id,
    createdBy: 'actor_1',
    title,
    mediaType: 'text/markdown',
    hash: 'abc',
    size: 120,
    createdAt: '2026-09-19T10:00:00Z',
  });
  const held = workspace([section('s_problem', 'Problem', 'Text.')]);
  const cited = {
    id: 'cite_1',
    projectId: project.id,
    revision: 3,
    identifier: 'arxiv:2201.02177',
    title: 'Grokking',
    authors: ['Power'],
    year: 2022,
    url: null,
    notes: '',
    sectionIds: [],
    // One reference is a retained file; the other is of a shape only an import wrote.
    refs: [`artifact:${CURVE}`, 'legacy:figure-2'],
    createdAt: '2026-09-19T10:00:00Z',
    updatedAt: '2026-09-19T10:00:00Z',
    updatedBy: 'actor_1',
  };
  boot({ ...held, citations: [cited] as never[] });
  serve('/tools/artifact.list', {
    body: { result: [file(CURVE, 'Learning curve'), file(TABLE, 'Accuracy table')] },
  });
  let sent: Record<string, unknown> | undefined;
  serve('/tools/paper.cite', (_call, body) => {
    sent = body;
    return { body: { result: { ...cited, revision: 4 } } };
  });
  await open();
  // The entry's own control sits with the entry, inside the disclosure that holds its files.
  const edit = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Edit citation',
  )!;
  await act(async () => edit.click());
  await settle(10);
  const form = document.querySelector<HTMLFormElement>('form[aria-label="Edit citation"]')!;
  assert.ok(![...form.querySelectorAll('textarea')].some((area) => /art/.test(area.placeholder)));
  assert.deepEqual(
    [...form.querySelectorAll('.picker-chip-name')].map((chip) => chip.textContent),
    ['Learning curve'],
  );
  assert.doesNotMatch(form.textContent ?? '', /art_|legacy:/, 'no reference is shown as written');

  const search = form.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  assert.equal(form.querySelector(`label[for="${search.id}"]`)?.textContent, 'Retained files');
  const key = async (name: string) => {
    await act(async () => {
      search.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  };
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  await key('Escape');
  await act(async () => {
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  await settle(10);
  // What the entry already carried keeps its place; what was picked follows it.
  assert.deepEqual(sent?.refs, [`artifact:${CURVE}`, 'legacy:figure-2', `artifact:${TABLE}`]);
});

test('the main agent UI can save Methods and Results directly', async (t) => {
  t.after(async () => await unmount());
  const held = workspace([]);
  for (const kind of ['methods', 'results'] as const)
    held.documents[kind].current = revision(kind, [section(kind, kind, `Current ${kind}.`)]);
  boot(held);
  const sent: string[] = [];
  serve('/tools/paper.patch', (_call, body) => {
    const kind = body.kind as 'methods' | 'results';
    assert.equal(body.expectedRevision, 1);
    sent.push(kind);
    held.documents[kind].current = { ...held.documents[kind].current, revision: 2 };
    return { body: { result: held.documents[kind].current } };
  });
  await open();
  for (const kind of ['methods', 'results']) {
    const button = tools().find((tool) => tool.getAttribute('aria-label') === `Edit ${kind}`)!;
    assert.ok(button);
    await act(async () => button.click());
    const form = document.querySelector<HTMLFormElement>(`form[aria-label="Edit ${kind}"]`)!;
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await settle(10);
  }
  assert.deepEqual(sent, ['methods', 'results']);
});

test('the paper names its sources and reviews through their owners, and reads no list to do it', async (t) => {
  const EXPERIMENT = `wf_${'e'.repeat(32)}`;
  const REVIEW = `review_${'a'.repeat(32)}`;
  const at = '2026-10-01T00:00:00Z';
  const project = { id: 'project_1', name: 'Grokking', createdAt: at };
  const actor = { id: 'actor_o', projectId: project.id, name: 'Operator', role: 'operator' };
  const row = (id: string, kind: string, workflow?: string) => ({
    id,
    label: id,
    group: 'work',
    order: 1,
    path: `/${id}`,
    view: { kind },
    ...(workflow && { workflow }),
    status: {},
    readable: true,
  });
  const rows = [
    row('paper', 'paper'),
    row('experiments', 'experiments', 'experiment'),
    row('reviews', 'reviews'),
  ];
  const source = { kind: 'experiment', id: EXPERIMENT, revision: 3 };
  const empty = (kind: string) => ({
    current: {
      projectId: project.id,
      kind,
      revision: 0,
      sections: [],
      updatedBy: null,
      updatedAt: null,
    },
    published: null,
  });
  const methods = {
    projectId: project.id,
    kind: 'methods',
    revision: 1,
    sections: [{ id: 'sec_1', title: 'Setup', content: 'Three seeds.' }],
    updatedBy: 'actor_r',
    updatedAt: at,
    review: { id: REVIEW, source, verdict: 'pass' },
  };
  const workspace = {
    documents: {
      problem: empty('problem'),
      literature: empty('literature'),
      methods: {
        current: methods,
        published: {
          document: methods,
          publication: {
            id: 'paperpub_1',
            projectId: project.id,
            kind: 'methods',
            revision: 1,
            source,
            reviewId: REVIEW,
            verdict: 'pass',
            evidence: [],
            createdBy: 'actor_r',
            createdAt: at,
          },
        },
      },
      results: empty('results'),
    },
    citations: [],
  };
  t.after(unmount);
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows, plugins: [] } } });
  serve('/tools/actor.list', {
    body: { result: [{ ...actor }, { id: 'actor_r', name: 'Ada', role: 'reviewer' }] },
  });
  serve('/tools/artifact.list', { body: { result: [] } });
  serve('/tools/paper.read', (_count, input) => ({
    body: { result: input.history ? [] : workspace },
  }));
  const asked: string[][] = [];
  serve('/tools/project.references', (_count, input) => {
    asked.push(input.refs as string[]);
    return {
      body: {
        result: (input.refs as string[]).map((ref) =>
          ref === EXPERIMENT
            ? {
                ref,
                status: 'resolved',
                kind: 'experiment',
                id: ref,
                label: 'Seed sweep',
                state: 'done',
              }
            : ref === REVIEW
              ? {
                  ref,
                  status: 'resolved',
                  kind: 'review',
                  id: ref,
                  label: 'Review of Seed sweep',
                  state: 'submitted',
                }
              : { ref, status: 'missing', kind: null, id: ref },
        ),
      },
    };
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/paper'] },
      createElement(
        SessionProvider,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/paper/*',
            element: createElement(PaperView, {
              row: rows[0],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shell: { rows, plugins: [] } as any,
            }),
          }),
        ),
      ),
    ),
  );
  await settle(50);
  // No list is read to name a record: the paper's own references are asked, once each.
  assert.deepEqual(
    requests.filter((path) => /experiment\.list|reflection\.list|review\.list/.test(path)),
    [],
  );
  assert.deepEqual(asked.flat().sort(), [EXPERIMENT, REVIEW].sort());
  const links = [...document.querySelectorAll('a')].map((link) => [
    link.textContent,
    link.getAttribute('href'),
  ]);
  assert.ok(
    links.some(([name, to]) => name === 'Seed sweep review' && to === `/reviews/${REVIEW}`),
  );
  // The review stands in the verdict the paper recorded, by the reviewer the paper recorded.
  assert.match(document.body.textContent!, /Seed sweep reviewpass · Ada · published Methods/);
  // Paper proposals were retired: the page lists none, and keeps no retained-files group for them.
  assert.doesNotMatch(document.body.textContent!, /Earlier paper proposals|Evidence retained/);
});

test('a publication made before reviews wrote the paper stands behind its sections, read without proposals', async (t) => {
  t.after(async () => await unmount());
  const held = workspace([]);
  const methods = revision('methods', [section('s_setup', 'Setup', 'Three seeds.')]);
  // As paper proposals published it: no review on the revision, no section list on the publication.
  Object.assign(held.documents.methods, {
    current: methods,
    published: {
      document: methods,
      publication: {
        id: 'paperpub_old',
        projectId: project.id,
        kind: 'methods',
        revision: 1,
        source: { kind: 'experiment', id: 'wf_old', revision: 3 },
        reviewId: 'review_old',
        evidence: [],
        createdBy: 'actor_1',
        createdAt: '2026-09-19T10:00:00Z',
      },
    },
  });
  boot(held);
  await open();
  const setup = document.getElementById('methods-setup')!;
  // It names no sections, so whoever wrote this one is not known: it is credited to nobody.
  assert.equal(setup.querySelector('.from')?.textContent, 'published');
  assert.ok(!text().includes('never reviewed'));
});

test('a review’s state on the paper moves as the page polls, while its name stands', async (t) => {
  t.after(async () => await unmount());
  // Only the page's own interval is driven by hand; every other timer runs as it would.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const SOURCE = `wf_${'c'.repeat(32)}`;
  const REVIEW = `review_${'c'.repeat(32)}`;
  const held = workspace([]);
  const methods = revision('methods', [section('s_poll', 'Setup', 'Three seeds.')]);
  Object.assign(held.documents.methods, {
    current: methods,
    published: {
      document: methods,
      // A publication that recorded no verdict stands in its review's own state.
      publication: {
        id: 'paperpub_poll',
        projectId: project.id,
        kind: 'methods',
        revision: 1,
        source: { kind: 'experiment', id: SOURCE, revision: 1 },
        reviewId: REVIEW,
        evidence: [],
        createdBy: 'actor_1',
        createdAt: '2026-09-19T10:00:00Z',
      },
    },
  });
  boot(held);
  let state = 'in_progress';
  let asked = 0;
  serve('/tools/project.references', (_call, sent) => {
    asked++;
    return {
      body: {
        result: (sent.refs as string[]).map((ref) => ({
          ref,
          status: 'resolved',
          kind: ref === REVIEW ? 'review' : 'experiment',
          id: ref,
          label: ref === REVIEW ? 'Review of the sweep' : 'Seed sweep',
          ...(ref === REVIEW && { state }),
        })),
      },
    };
  });
  await open();
  assert.match(text(), /Seed sweep review/);
  assert.match(text(), /in_progress|in progress/i);
  const before = asked;
  state = 'submitted';
  await act(async () => t.mock.timers.tick(10_000));
  await settle(20);
  assert.ok(asked > before, 'the references were asked again with the poll');
  assert.match(text(), /submitted/i);
  assert.match(text(), /Seed sweep review/);
});
