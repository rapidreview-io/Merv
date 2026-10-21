/**
 * Documents, read. A brief or a delivery is Markdown an agent wrote, and these
 * tests are about what a person then sees: headings and tables instead of `#` and
 * pipes, a name where an id was written, and nothing an author typed ever reaching
 * the browser as an address it should not open. The parser is pure, so most of
 * this asserts on its tree; the last tests mount the component and read the DOM.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mount, rawView, serve, settle, text, unmount } from './ui-render.js';

const { Profiler, createElement, useState } = await import('react');
const { act } = await import('react-dom/test-utils');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const {
  MAX_READ,
  Markdown,
  MarkdownPieces,
  RecordText,
  idsIn,
  loadParser,
  recordNames,
  safeHref,
  shortId,
  useReferences,
} = await import('../packages/ui/web/markdown.js');
const { parseInline, parseMarkdown } = await import('../packages/ui/web/markdown-parse.js');
const { ArtifactBody, fileType } = await import('../packages/ui/web/views/artifacts.js');

type Node = { type: string; [key: string]: unknown };
const ART = 'art_bb6477ae526d45c99b2d066a4ae959e2';
const TASK = 'wf_8e08957bb7e146dab8d4232432daeeee';
const said = (nodes: Node[]): string =>
  nodes
    .map((node) =>
      node.type === 'text' || node.type === 'code'
        ? (node.value as string)
        : node.type === 'break'
          ? '\n'
          : node.type === 'id'
            ? (node.id as string)
            : said((node.children ?? []) as Node[]),
    )
    .join('');
const page = (source: string, names?: unknown) =>
  createElement(MemoryRouter, null, createElement(Markdown, { source, names }));
const all = (selector: string) => [...document.querySelectorAll(selector)];

test('only http, https, mailto and relative addresses ever become an href', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.org/x',
    '',
  ])
    assert.equal(safeHref(bad), null, bad);
  // A file in the project's code: an exact ref and a path inside the repository, nothing else.
  const commit = 'a'.repeat(40);
  for (const good of [
    `code-file:${commit}:experiments/x/metrics.json`,
    'code-file:main:README.md',
    `code-file:wf_${'b'.repeat(32)}:src/a.py`,
  ])
    assert.deepEqual(safeHref(good), { href: good, external: false }, good);
  for (const bad of [
    `code-file:${commit}:/etc/passwd`,
    `code-file:${commit}:a/../../b`,
    'code-file:HEAD~1:a.py',
    `code-file:${commit}:`,
    'code-file:main:a//b',
  ])
    assert.equal(safeHref(bad), null, bad);
  assert.deepEqual(safeHref('https://example.org/a'), {
    href: 'https://example.org/a',
    external: true,
  });
  assert.deepEqual(safeHref('mailto:lab@example.org'), {
    href: 'mailto:lab@example.org',
    external: true,
  });
  assert.deepEqual(safeHref('notes/run.md#seed'), { href: 'notes/run.md#seed', external: false });
  // Two slashes, or a slash and a backslash, leave this origin: they are external, never relative.
  assert.deepEqual(safeHref('/\\evil.example/x'), {
    href: 'https://evil.example/x',
    external: true,
  });

  // A refused address leaves its words behind as plain text.
  assert.deepEqual(parseInline('[click](javascript:alert(1)) <javascript:alert(1)>'), [
    { type: 'text', value: 'click <javascript:alert(1)>' },
  ]);
  const [titled, , angle, , bare] = parseInline(
    '[Power et al.](https://arxiv.org/abs/2201.02177 "the paper") <https://a.example> https://b.example/path_(x).',
  );
  assert.deepEqual(titled, {
    type: 'link',
    href: 'https://arxiv.org/abs/2201.02177',
    external: true,
    title: 'the paper',
    children: [{ type: 'text', value: 'Power et al.' }],
  });
  assert.equal(angle.href, 'https://a.example');
  // The full stop belongs to the sentence, the bracket to the address.
  assert.equal(bare.href, 'https://b.example/path_(x)');
});

test('whatever it is given, the parser answers with blocks and never throws', () => {
  const hostile = [
    '',
    '\n\n\n',
    '#',
    '####### seven',
    '|',
    '|||\n|-|',
    '| a |\n|---|---|',
    '```',
    '[unclosed](',
    '[a](<b',
    '![',
    '<',
    '\\',
    '* * *',
    '- ',
    '1.',
    '>'.repeat(500) + ' deep',
    '- '.repeat(200) + 'deep',
    '*'.repeat(5000) + 'a' + '*'.repeat(5000),
    '*a '.repeat(3000),
    '['.repeat(2000) + ']'.repeat(2000),
    '`'.repeat(999),
    '\u0000\ud800 lone surrogate',
    'tab\tseparated\r\nwindows\rold mac',
  ];
  for (const source of hostile) {
    const tree = parseMarkdown(source);
    assert.ok(Array.isArray(tree), JSON.stringify(source.slice(0, 20)));
  }
  assert.deepEqual(parseMarkdown('####### seven'), [
    { type: 'paragraph', children: [{ type: 'text', value: '####### seven' }] },
  ]);
  // Past the depth the parser reads, the rest is kept as the text it was.
  assert.match(JSON.stringify(parseMarkdown('>'.repeat(50) + ' deep')), /deep/);
});

/**
 * The browser's Worker, on a Node thread that loads the worker module as the page would, after
 * `startMs` as a page still downloading it does.
 */
async function installWorker(t: TestContext, startMs = 0) {
  const { Worker: Thread } = await import('node:worker_threads');
  const threads: InstanceType<typeof Thread>[] = [];
  class PageWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    private thread: InstanceType<typeof Thread>;
    constructor(url: URL) {
      this.thread = new Thread(
        `const { parentPort } = require('node:worker_threads');
        require('tsx/esm/api').register();
        globalThis.addEventListener = (_, listener) => parentPort.on('message', (data) => listener({ data }));
        globalThis.postMessage = (data) => parentPort.postMessage(data);
        setTimeout(() => import(${JSON.stringify(url.href)}), ${startMs});`,
        { eval: true },
      );
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', () => this.onerror?.());
      threads.push(this.thread);
    }
    postMessage(data: unknown) {
      this.thread.postMessage(data);
    }
    terminate() {
      void this.thread.terminate();
    }
  }
  Object.assign(globalThis, { Worker: PageWorker });
  t.after(async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    await unmount();
    await Promise.all(threads.map((thread) => thread.terminate()));
  });
  return threads;
}

test('no text a member can post holds the page: each is read off its thread, in time or not at all', async (t) => {
  // A text read in the worker draws as it does when read on the page (a trailing newline keeps
  // the page's reading out of the worker's way and changes nothing drawn).
  const rich =
    '# Goal\n\n- [x] **done** and `code`\n  - nested\n\n> a quote\n>\n> on two lines\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [the run](/runs/1).';
  await loadParser();
  const drawn = document.createElement('div');
  drawn.innerHTML = renderToStaticMarkup(page(`${rich}\n`));
  await installWorker(t);
  const runs = (count: number) =>
    Array.from({ length: count }, (_, index) => '`'.repeat(index + 1)).join(' ');
  // Each of these held the page's thread for seconds, or minutes, when it was read there.
  const slow = [
    '['.repeat(3000) + runs(95),
    `# a${' '.repeat(80_000)}b`,
    `a${' '.repeat(80_000)}b\nc`,
    '[a]('.repeat(20_000),
    '[a](<'.repeat(16_000),
    '[a](b "'.repeat(11_430),
    'a*'.repeat(40_000),
    `a|b\n|-|-|${' '.repeat(80_000)}x`,
    `- ${' '.repeat(80_000)} `,
    `<a@${'b.'.repeat(40_000)}@>`,
    `http://a.b/${')'.repeat(80_000)}`,
  ];
  // How long the page's thread goes without a turn, sampled every few milliseconds.
  let longest = 0;
  let last = performance.now();
  const ticks = setInterval(() => {
    longest = Math.max(longest, performance.now() - last);
    last = performance.now();
  }, 5);
  t.after(() => clearInterval(ticks));
  const texts = [...slow, rich];
  await mount(
    createElement(
      MemoryRouter,
      null,
      ...texts.map((source, key) =>
        createElement('section', { key }, createElement(Markdown, { source })),
      ),
    ),
  );
  // The worker reads in order, so once the last text is drawn every other one is settled.
  for (let waited = 0; !document.querySelector('section:last-child .md'); waited += 50) {
    assert.ok(waited < 120_000, 'the worker reads every text, or gives it up');
    await settle(50);
  }
  clearInterval(ticks);
  assert.ok(longest <= 300, `the page's thread was held for ${Math.round(longest)} ms`);
  assert.equal(document.querySelector('section:last-child')!.innerHTML, drawn.innerHTML);
  // Each is read, or, where the worker could not read it in time (emphasis that never closes
  // takes a minute), it stands as its author typed it.
  const sections = [...document.querySelectorAll('section')];
  slow.forEach((source, at) => {
    const typed = sections[at]!.querySelector('pre.doc');
    assert.ok(sections[at]!.querySelector('.md') || typed?.textContent === source, `${at}`);
  });
  assert.equal(sections[6]!.querySelector('pre.doc')?.textContent, slow[6]);
});

test('no code a member can post holds the page: it is coloured off its thread, in time or not at all', async (t) => {
  // A module of its own, so its colours are done by the worker this test starts.
  const { CodeBlock } = await import('../packages/ui/web/code-block.js?off-thread');
  await installWorker(t);
  // Forty lines a grammar takes over a second each: tens of seconds on the page's thread.
  const slow = Array(40).fill('<'.repeat(999)).join('\n');
  let longest = 0;
  let last = performance.now();
  const ticks = setInterval(() => {
    longest = Math.max(longest, performance.now() - last);
    last = performance.now();
  }, 5);
  t.after(() => clearInterval(ticks));
  await mount(
    createElement(
      'div',
      null,
      createElement('section', null, createElement(CodeBlock, { code: slow, lang: 'sh' })),
      createElement('section', null, createElement(CodeBlock, { code: 'ls -la', lang: 'sh' })),
    ),
  );
  // Colours come in order, so once the short block is coloured the long one is settled.
  for (let waited = 0; !document.querySelector('section:last-child .code-body [style]');) {
    assert.ok((waited += 50) < 60_000, 'the short block is coloured');
    await settle(50);
  }
  clearInterval(ticks);
  assert.ok(longest < 200, `the page's thread was held for ${Math.round(longest)} ms`);
  const long = document.querySelector('section:first-child .code-body')!;
  assert.equal(long.querySelectorAll('[style]').length, 0, 'given up, it stands plain');
  assert.equal(long.textContent, slow);
});

test('a document renders as elements: no markup characters, no images, no unsafe address', async (t) => {
  t.after(async () => await unmount());
  const names = recordNames([{ id: ART, title: 'Delivery: grokking curve, seed 7' }]);
  await mount(
    page(
      [
        '# Result',
        '## Checks',
        '- [x] Curve attached',
        '',
        '| step | val |',
        '|-----:|:---:|',
        '| 1000 | 0.01 |',
        '',
        `Evidence: ${ART} and ${TASK}.`,
        '',
        '![curve](https://example.org/c.png) [x](javascript:alert(1)) [out](https://example.org) <b>bold</b>',
        '',
        '[the task](/tasks/wf_1) and [a sibling file](notes/run.md)',
        '',
        '```\n<script>alert(1)</script>\n```',
      ].join('\n'),
      names,
    ),
  );
  // The page's own section heading is an h2; a document's headings start beneath it.
  assert.deepEqual(
    all('.md .md-h').map((h) => [h.tagName, h.className, h.textContent]),
    [
      ['H3', 'md-h md-h1', 'Result'],
      ['H4', 'md-h md-h2', 'Checks'],
    ],
  );
  const box = document.querySelector('.md-task input') as HTMLInputElement;
  assert.deepEqual([box.type, box.checked, box.disabled], ['checkbox', true, true]);
  assert.deepEqual(
    all('.md-table th').map((cell) => [cell.textContent, cell.className]),
    [
      ['step', 'md-right'],
      ['val', 'md-center'],
    ],
  );
  assert.equal(all('.md img, .md script, .md b').length, 0);
  assert.match(text(), /<b>bold<\/b>/);
  assert.match(text(), /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(text(), /^#|\| step|\*\*|art_bb64/m);

  const links = all('.md a') as HTMLAnchorElement[];
  assert.deepEqual(
    links.map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel, a.title]),
    [
      // A named id reads as the record's title; the id itself stays in the hover title.
      ['Delivery: grokking curve, seed 7', `/artifacts/${ART}`, '', '', ART],
      ['curve', 'https://example.org/c.png', '_blank', 'noopener noreferrer', ''],
      ['out', 'https://example.org', '_blank', 'noopener noreferrer', ''],
      // An address from the root is a page of the app and goes through the router; any
      // other relative one is left to the browser.
      ['the task', '/tasks/wf_1', '', '', ''],
      ['a sibling file', 'notes/run.md', '', '', ''],
    ],
  );
  for (const a of links)
    assert.doesNotMatch(a.getAttribute('href') ?? '', /^\s*(javascript|data):/i);
  // A task nobody named has no page its shape can point to: a short form, the whole id on hover.
  const unnamed = document.querySelector('.record-link--id') as HTMLElement;
  assert.deepEqual(
    [unnamed.tagName, unnamed.textContent, unnamed.title],
    ['SPAN', 'wf_…daeeee', TASK],
  );
});

test('an HTML file is drawn as its page in a sandbox, and its source is behind raw view', async (t) => {
  t.after(async () => await unmount());
  const artifact = {
    id: ART,
    projectId: 'project_1',
    createdBy: 'actor_1',
    title: 'report.html',
    mediaType: 'text/html',
    hash: '52d0a404b837827d',
    size: 64,
    createdAt: new Date().toISOString(),
  };
  const html = '<h1>Report</h1><script>document.title = "ran"</script>';
  serve('/tools/artifact.read', {
    body: { result: { artifact, encoding: 'utf8', content: html } },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: ART, metadata: artifact }),
    ),
  );
  await settle(10);
  const frame = document.querySelector('.file-html iframe');
  assert.equal(frame?.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame?.getAttribute('srcdoc'), html);
  // Never Merv's own document: the page is only ever inside the frame.
  assert.equal(document.querySelector('h1')?.textContent ?? null, null);
  assert.equal(await rawView(true), 'off');
  assert.equal(await rawView(), 'on');
  assert.equal(document.querySelector('.file-html'), null);
  assert.match(document.querySelector('.code-block pre')?.textContent ?? '', /^<h1>Report<\/h1>/);
});
