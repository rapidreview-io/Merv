/**
 * The paper, rendered. Each test states one thing the page must do without words:
 * offer a section's control as a glyph that still has a name, read a section as
 * the markdown it was written in, say nothing where there is nothing to say, and
 * never leave a bare heading or a dangling separator where a fact is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
// jsdom lays nothing out, so nothing ever scrolls into view: the outline's watcher is inert.
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
});

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');

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
  updateId: null,
});
const workspace = (problem: unknown[], literature: unknown[] = []) => ({
  documents: {
    problem: { current: revision('problem', problem), published: null },
    literature: { current: revision('literature', literature), published: null },
    methods: { current: revision('methods', []), published: null },
    results: { current: revision('results', []), published: null },
  },
  citations: [],
  proposals: [],
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
    ['Edit Problem', 'Edit Scope', 'New section', 'New citation'],
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
