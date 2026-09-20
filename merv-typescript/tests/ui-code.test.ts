/**
 * The Code page, rendered. With no repository and nothing made it says one thing
 * and offers one control; with a repository and nothing made, each section is its
 * name and a zero, and never a sentence about what is not there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { CodePage } = await import('../packages/ui/web/views/code.js');

const row = {
  id: 'code',
  label: 'Code',
  group: 'operations',
  order: 30,
  path: '/code',
  view: { kind: 'code' },
  status: {},
  readable: true,
};
const shell = { rows: [row], plugins: [] };
const page = () =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/code'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(CodePage as any, { row, shell, operator: true, named: () => undefined }),
  );
const github = (over: Record<string, unknown> = {}) => ({
  body: {
    configured: true,
    revision: 0,
    status: 'disconnected',
    user: null,
    repository: null,
    canManage: true,
    canBrowse: false,
    installUrl: null,
    automationConfigured: false,
    automation: 'off',
    baseBranch: null,
    ...over,
  },
});
const nothingMade = () => {
  serve('/tools/ui.read', { body: { result: { operations: [], proposals: [] } } });
  serve('/code/publications', { body: { publications: [] } });
};

test('with GitHub not connected the page is one empty state and its one control', async (t) => {
  t.after(unmount);
  nothingMade();
  serve('/code/github', github());
  await mount(page());
  const empty = document.querySelector('.empty-state');
  assert.ok(empty, text().slice(0, 400));
  assert.ok(empty.querySelector('svg'), 'the state wears its glyph');
  assert.equal(empty.querySelector('h2')?.textContent, 'GitHub not connected');
  const control = empty.querySelector('a.btn--primary');
  assert.equal(control?.textContent, 'Connect GitHub');
  assert.equal(control?.getAttribute('href'), '/settings/integrations');
  for (const gone of ['Branches', 'Pull requests', 'No branches yet', 'No pull requests yet'])
    assert.ok(!text().includes(gone), `“${gone}” is still on the page: ${text()}`);
});

test('connected with nothing made, a section is its name and a zero', async (t) => {
  t.after(unmount);
  nothingMade();
  serve(
    '/code/github',
    github({
      status: 'connected',
      repository: { fullName: 'lab/grokking', defaultBranch: 'main', private: true, url: '' },
    }),
  );
  await mount(page());
  assert.equal(document.querySelector('.empty-state'), null);
  assert.ok(text().includes('Branches 0'), text());
  assert.ok(text().includes('Pull requests 0'), text());
  assert.ok(!/No (branches|pull requests)/.test(text()), text());
});
