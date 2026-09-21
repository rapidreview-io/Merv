/**
 * JSON, read. A results file is a tree a person opens as far as they need, and
 * these tests are about what is then on the page: two levels open and the rest a
 * count, nothing rendered that is closed, a commit cut to its two ends, a record
 * id as the record's name, an address as a link and nothing else as one — and a
 * file that does not parse left exactly as it was written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { JsonView, readJson } = await import('../packages/ui/web/json-view.js');
const { recordNames } = await import('../packages/ui/web/markdown.js');
const { ArtifactBody } = await import('../packages/ui/web/views/artifacts.js');

const ART = 'art_bb6477ae526d45c99b2d066a4ae959e2';
const TASK = 'wf_8e08957bb7e146dab8d4232432daeeee';
const COMMIT = '3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345';
const DIGEST = `${'ab12'.repeat(15)}cafe`;
const all = (selector: string) => [...document.querySelectorAll(selector)];
const tree = (value: unknown, names?: unknown) =>
  mount(createElement(MemoryRouter, null, createElement(JsonView, { value, names })));
/** The toggle that carries this key, found by the name a person reads on it. */
const toggle = (key: string) => {
  const found = all('.json-toggle').find((button) => button.textContent === key);
  assert.ok(found, `no toggle reading “${key}”`);
  return found as HTMLButtonElement;
};
const press = async (button: HTMLElement, init: MouseEventInit = {}) => {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...init }));
  });
};

test('two levels stand open, the rest is a count, and what is closed is not rendered', async (t) => {
  t.after(async () => await unmount());
  await tree({
    run: { seed: 7, config: { lr: 0.001, layers: [1, 2, 3] }, tags: [] },
    ok: true,
    note: null,
    empty: {},
  });
  // The root and its entries are open; `config` is two levels down and is a count.
  assert.equal(
    document.querySelector('.json-toggle')?.getAttribute('aria-label'),
    'Object',
    'the root has no key, so its toggle is named by what it is',
  );
  assert.equal(toggle('run').getAttribute('aria-expanded'), 'true');
  assert.equal(toggle('config').getAttribute('aria-expanded'), 'false');
  assert.equal(toggle('config').parentElement?.querySelector('.json-count')?.textContent, '{ 2 }');
  assert.doesNotMatch(text(), /lr|layers|0\.001/, 'a closed node renders none of its children');
  // Each kind of value is told apart by an element of its own; an empty branch has no toggle.
  assert.deepEqual(
    all('.json-number, .json-boolean, .json-null').map((node) => [
      node.className,
      node.textContent,
    ]),
    [
      ['json-number', '7'],
      ['json-boolean', 'true'],
      ['json-null', 'null'],
    ],
  );
  assert.deepEqual(
    all('.json-row--leaf .json-count').map((node) => node.textContent),
    ['[ ]', '{ }'],
  );

  await press(toggle('config'));
  assert.equal(toggle('config').getAttribute('aria-expanded'), 'true');
  assert.equal(toggle('config').parentElement?.querySelector('.json-count'), null);
  assert.match(text(), /lr0\.001/);
  assert.equal(toggle('layers').parentElement?.querySelector('.json-count')?.textContent, '[ 3 ]');

  await press(toggle('run'));
  assert.equal(toggle('run').getAttribute('aria-expanded'), 'false');
  assert.equal(toggle('run').parentElement?.querySelector('.json-count')?.textContent, '{ 3 }');
  assert.doesNotMatch(text(), /seed|config/);
});

test('an Alt-press opens or closes everything beneath a node, and a plain press ends it', async (t) => {
  t.after(async () => await unmount());
  await tree({ a: { b: { c: { d: [1] } } } });
  assert.doesNotMatch(text(), /c/);
  await press(toggle('a'), { altKey: true });
  assert.equal(all('.json-toggle').length, 1 + 1, 'Alt on an open node closes it');
  await press(toggle('a'), { altKey: true });
  assert.deepEqual(
    all('.json-toggle').map((button) => button.getAttribute('aria-expanded')),
    ['true', 'true', 'true', 'true', 'true'],
  );
  // Closed and opened again by a plain press, what is beneath stands at its default.
  await press(toggle('b'));
  await press(toggle('b'));
  assert.equal(toggle('c').getAttribute('aria-expanded'), 'false');
});

test('a hash is its two ends with all of it in the title; a long string is cut until asked for', async (t) => {
  t.after(async () => await unmount());
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void (copied = value) },
  });
  t.after(() => Reflect.deleteProperty(navigator, 'clipboard'));
  const long = 'grokking '.repeat(40).trim();
  await tree({ commit: COMMIT, digest: DIGEST, almost: COMMIT.slice(1), long, short: 'seed 7' });
  assert.deepEqual(
    all('.json-hash').map((node) => [node.textContent, node.getAttribute('title')]),
    [
      ['3f2a9c1b…012345', COMMIT],
      [`${DIGEST.slice(0, 8)}…${DIGEST.slice(-6)}`, DIGEST],
    ],
  );
  // Thirty-nine hex digits are a string like any other.
  assert.ok(all('.json-string').some((node) => node.textContent === COMMIT.slice(1)));
  const copy = all('button[aria-label="Copy hash"]') as HTMLButtonElement[];
  assert.equal(copy.length, 2);
  await press(copy[0]!);
  assert.equal(copied, COMMIT);

  const shown = () => all('.json-string').find((node) => node.textContent?.startsWith('grokking'));
  assert.ok(shown()!.textContent!.length <= 121 && shown()!.textContent!.endsWith('…'));
  await click('Show all');
  assert.equal(shown()!.textContent, long);
  await click('Show less');
  assert.ok(shown()!.textContent!.endsWith('…'));
});

test('a record id is the record’s name, an address is a link, and nothing else is one', async (t) => {
  t.after(async () => await unmount());
  const names = recordNames([{ id: ART, title: 'curve.png' }], {
    tasks: [{ id: TASK, title: 'Reproduce grokking' }],
  });
  await tree(
    {
      task: TASK,
      file: ART,
      unknown: 'wf_00000000000000000000000000000000',
      site: 'https://example.org/a?b=1',
      script: 'javascript:alert(1)',
      data: 'data:text/html,<script>alert(1)</script>',
      tabbed: 'java\tscript:alert(1)',
      relative: '/artifacts/x',
      prose: `see https://example.org and ${TASK}`,
      markup: '<img src=x onerror=alert(1)>',
    },
    names,
  );
  assert.deepEqual(
    all('.json a').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('title')]),
    [
      ['Reproduce grokking', `/tasks/${TASK}`, TASK],
      ['curve.png', `/artifacts/${ART}`, ART],
      ['https://example.org/a?b=1', 'https://example.org/a?b=1', null],
    ],
  );
  const site = document.querySelector('.json-link')!;
  assert.deepEqual(
    [site.getAttribute('target'), site.getAttribute('rel')],
    ['_blank', 'noopener noreferrer'],
  );
  // An id no list names is its short form, never the id; one inside prose is the author's text.
  assert.match(text(), /wf_…000000/);
  assert.doesNotMatch(text(), /wf_0{32}/);
  assert.ok(all('.json-string').some((node) => node.textContent?.includes(TASK)));
  // What an author typed is text: no element is made of it.
  assert.equal(document.querySelector('.json img, .json script'), null);
  assert.match(text(), /<img src=x onerror=alert\(1\)>/);
});

test('a long array is drawn a hundred at a time', async (t) => {
  t.after(async () => await unmount());
  await tree({ losses: Array.from({ length: 258 }, (_, at) => at / 1000) });
  const rows = () => all('.json-number').length;
  assert.equal(toggle('losses').getAttribute('aria-expanded'), 'true');
  assert.equal(rows(), 100);
  await click('Show 100 more');
  assert.equal(rows(), 200);
  await click('Show 58 more');
  assert.equal(rows(), 258);
  assert.doesNotMatch(text(), /Show \d+ more/);
});

const artifact = (title: string, size: number) => ({
  id: ART,
  projectId: 'project_1',
  createdBy: 'actor_1',
  title,
  mediaType: 'application/json',
  hash: 'abc',
  size,
  createdAt: new Date().toISOString(),
});
const file = (meta: ReturnType<typeof artifact>, content: string) => {
  serve('/tools/artifact.read', {
    body: { result: { artifact: meta, encoding: 'utf8', content } },
  });
  return mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: ART, metadata: meta }),
    ),
  );
};

test('a JSON file is read as a tree, names its records, and one control shows its source', async (t) => {
  t.after(async () => await unmount());
  const content = `{"seed":7,"task":"${TASK}","val":[0.97]}`;
  serve('/tools/ui.home', {
    body: { result: { tasks: [{ id: TASK, title: 'Reproduce grokking' }] } },
  });
  await file(artifact('metrics.json', content.length), content);
  await settle(10);
  assert.equal(document.querySelector('pre.doc'), null);
  assert.match(text(), /seed7/);
  assert.equal(document.querySelector('.json a')?.textContent, 'Reproduce grokking');

  const source = document.querySelector('button[aria-label="View source"]') as HTMLButtonElement;
  assert.equal(source.getAttribute('aria-pressed'), 'false');
  await press(source);
  assert.equal(source.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.json'), null);
  assert.equal(document.querySelector('pre.doc')?.textContent, content);
  await press(source);
  assert.equal(document.querySelector('pre.doc'), null);
  assert.ok(document.querySelector('.json'));
});

test('JSON that does not parse stays the text it was, with no source to turn to', async (t) => {
  t.after(async () => await unmount());
  const content = '{"seed": 7,\n  "val": [0.97,]}';
  assert.equal(readJson(content), undefined);
  assert.deepEqual(readJson('null'), { value: null });
  await file(artifact('broken.json', content.length), content);
  await settle(10);
  assert.equal(document.querySelector('.json'), null);
  assert.equal(document.querySelector('pre.doc')?.textContent, content);
  assert.equal(document.querySelector('button[aria-label="View source"]'), null);
});
