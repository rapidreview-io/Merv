/**
 * Documents, read. A brief or a delivery is Markdown an agent wrote, and these
 * tests are about what a person then sees: headings and tables instead of `#` and
 * pipes, a name where an id was written, and nothing an author typed ever reaching
 * the browser as an address it should not open. The parser is pure, so most of
 * this asserts on its tree; the last tests mount the component and read the DOM.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
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

test('headings keep their level and a newline inside a paragraph is a line break', () => {
  const tree = parseMarkdown(
    '# Goal\nShow the curve.\nReproduce grokking.\n\n## Checks ##\n#hashtag',
  );
  assert.deepEqual(
    tree.map((block: Node) => [block.type, block.level ?? null, said(block.children as Node[])]),
    [
      ['heading', 1, 'Goal'],
      // Agents write one fact per line: the second fact is not folded into the first.
      ['paragraph', null, 'Show the curve.\nReproduce grokking.'],
      ['heading', 2, 'Checks'],
      ['paragraph', null, '#hashtag'],
    ],
  );
});

test('lists nest, number from where they start, and carry read-only task boxes', () => {
  const [list, after] = parseMarkdown(
    '3. Train\n   - wd 0.0\n   - wd 0.3\n     - three seeds\n4. Compare\n  - two spaces still nest\n\nafter',
  );
  assert.equal(list.type, 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.loose, false);
  assert.equal(list.items.length, 2);
  const inner = list.items[0].children[1];
  assert.deepEqual([inner.type, inner.ordered, inner.items.length], ['list', false, 2]);
  assert.equal(inner.items[1].children[1].type, 'list');
  assert.equal(list.items[1].children[1].type, 'list');
  // A line back at the margin ends the list rather than joining its last item.
  assert.equal(said(after.children), 'after');

  const [tasks] = parseMarkdown('- [x] Curves attached\n- [ ] Rerun seed 3\n- plain');
  assert.deepEqual(
    tasks.items.map((item: { checked?: boolean }) => item.checked),
    [true, false, undefined],
  );
  const [loose] = parseMarkdown('- one\n\n- two');
  assert.deepEqual([loose.items.length, loose.loose], [2, true]);
});

test('a table needs its divider row, keeps column alignment, and squares ragged rows', () => {
  const [table, rest] = parseMarkdown(
    '| step | train | val | note |\n|-----:|:-----:|:----|------|\n| 1000 | 0.62 | 0.01 | a \\| b |\n| 2000 | 1.00 |\n\nSeed: 7.',
  );
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['right', 'center', 'left', null]);
  assert.deepEqual(table.head.map(said), ['step', 'train', 'val', 'note']);
  assert.deepEqual(
    table.rows.map((row: Node[][]) => row.map(said)),
    [
      ['1000', '0.62', '0.01', 'a | b'],
      ['2000', '1.00', '', ''],
    ],
  );
  assert.equal(said(rest.children), 'Seed: 7.');
  // Pipes with no divider under them are a sentence with pipes in it.
  assert.equal(parseMarkdown('| a | b |\n| 1 | 2 |')[0].type, 'paragraph');
  assert.equal(parseMarkdown('| a | b |\n|---|')[0].type, 'paragraph');
});

test('code is kept exactly: fenced, indented, unclosed and inline', () => {
  const tree = parseMarkdown(
    '```python\nrun(**args)  # not *emphasis*\n' +
      `see ${ART}\n\`\`\`\n\n    indented\n      deeper\n\n~~~\nunclosed`,
  );
  assert.deepEqual(tree, [
    { type: 'code', lang: 'python', value: `run(**args)  # not *emphasis*\nsee ${ART}` },
    { type: 'code', value: 'indented\n  deeper' },
    { type: 'code', value: 'unclosed' },
  ]);
  assert.deepEqual(parseInline('use `wd >= 0.3` and ``a ` b``'), [
    { type: 'text', value: 'use ' },
    { type: 'code', value: 'wd >= 0.3' },
    { type: 'text', value: ' and ' },
    { type: 'code', value: 'a ` b' },
  ]);
});

test('bold, italic and strikethrough pair up; a word with underscores is left alone', () => {
  assert.deepEqual(parseInline('**bold *and* more** ~~gone~~ snake_case_name 2 * 3 * 4'), [
    {
      type: 'strong',
      children: [
        { type: 'text', value: 'bold ' },
        { type: 'em', children: [{ type: 'text', value: 'and' }] },
        { type: 'text', value: ' more' },
      ],
    },
    { type: 'text', value: ' ' },
    { type: 'del', children: [{ type: 'text', value: 'gone' }] },
    { type: 'text', value: ' snake_case_name 2 * 3 * 4' },
  ]);
  assert.deepEqual(parseInline('***both***'), [
    { type: 'em', children: [{ type: 'strong', children: [{ type: 'text', value: 'both' }] }] },
  ]);
  assert.deepEqual(parseInline('\\*literal\\* and **unclosed'), [
    { type: 'text', value: '*literal* and **unclosed' },
  ]);
});

test('GFM reads as GitHub reads it, less what this app never draws', () => {
  const kinds = (nodes: Node[]) => nodes.map((node) => node.type);
  // Strikethrough takes two tildes: one is "about", as in ~5 minutes.
  assert.deepEqual(parseInline('~~old~~ in ~5 min'), [
    { type: 'del', children: [{ type: 'text', value: 'old' }] },
    { type: 'text', value: ' in ~5 min' },
  ]);
  // Bare addresses, www. ones and email addresses are links; the sentence keeps its full stop.
  const auto = parseInline('See www.example.org, lab@example.org and <https://a.example/x>.');
  assert.deepEqual(
    auto
      .filter((node: Node) => node.type === 'link')
      .map((node: Node) => [node.href, said([node])]),
    [
      ['http://www.example.org', 'www.example.org'],
      ['mailto:lab@example.org', 'lab@example.org'],
      ['https://a.example/x', 'https://a.example/x'],
    ],
  );
  // Raw HTML is never a construct: its tags are text and the Markdown inside it still reads.
  assert.deepEqual(kinds(parseInline('<details>**open**</details>')), ['text', 'strong', 'text']);
  assert.deepEqual(
    parseMarkdown('<div>\n*a*\n</div>').map((block: Node) => kinds(block.children as Node[])),
    [['text', 'break', 'em', 'break', 'text']],
  );
  // Footnotes and link definitions stay as written, so no line can change one before it.
  assert.deepEqual(
    parseMarkdown('Claim[^1] and [ref].\n\n[^1]: Source.\n\n[ref]: https://x.example').map(
      (block: Node) => said(block.children as Node[]),
    ),
    ['Claim[^1] and [ref].', '[^1]: Source.', '[ref]: https://x.example'],
  );
  // A table needs no outer pipes, and a pipe inside code is still a cell's edge unless escaped.
  const [table] = parseMarkdown('a | b\n--|:-:\n`x\\|y` | **z**');
  assert.deepEqual(
    [table.align, table.rows[0].map(said)],
    [
      [null, 'center'],
      ['x|y', 'z'],
    ],
  );
  // Task boxes at any depth, and an ordered list inside a bulleted one.
  const [list] = parseMarkdown('- [ ] one\n  - [x] two\n    1. three');
  assert.equal(list.items[0].checked, false);
  const two = list.items[0].children[1].items[0];
  assert.deepEqual([two.checked, two.children[1].ordered], [true, true]);
  // Setext headings, and a line with no marker carrying on its list item, as CommonMark has them.
  assert.deepEqual(
    parseMarkdown('Title\n=====\n\n- item\ncarried on').map((block: Node) => block.type),
    ['heading', 'list'],
  );
  // A formula on lines of its own stands apart, even across them; within a line it stays inline.
  assert.deepEqual(
    parseMarkdown('Where\n$$a\n= b$$\nholds, and $$c$$ inline.').map((block: Node) => [
      block.type,
      block.type === 'math' ? block.value : kinds(block.children as Node[]),
    ]),
    [
      ['paragraph', ['text']],
      ['math', 'a\n= b'],
      ['paragraph', ['text', 'math', 'text']],
    ],
  );
});

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

test('an image loads nothing: it is a link reading as its alt text, or just the text', () => {
  assert.deepEqual(parseInline('![learning curve](https://example.org/curve.png)'), [
    {
      type: 'link',
      href: 'https://example.org/curve.png',
      external: true,
      title: undefined,
      children: [{ type: 'text', value: 'learning curve' }],
    },
  ]);
  assert.deepEqual(parseInline('![pixel](data:image/png;base64,AAAA)'), [
    { type: 'text', value: 'pixel' },
  ]);
});

test('a record id is recognised in text and in a code span, and only as a whole id', () => {
  assert.deepEqual(parseInline(`Evidence: ${ART}, \`artifact:${ART}\`.`), [
    { type: 'text', value: 'Evidence: ' },
    { type: 'id', id: ART },
    { type: 'text', value: ', ' },
    { type: 'code', value: 'artifact:' },
    { type: 'id', id: ART },
    { type: 'text', value: '.' },
  ]);
  // Too short, too long, or glued to a word: the author's text, untouched.
  for (const not of ['art_bb6477', `${ART}0`, `X${ART}`, `9${ART}`, 'snake_case'])
    assert.deepEqual(idsIn(`see ${not} here`), [], not);
  assert.deepEqual(idsIn(`${ART} ${TASK} ${ART} exp_sub_${'0'.repeat(32)}`), [
    ART,
    TASK,
    `exp_sub_${'0'.repeat(32)}`,
  ]);
  assert.equal(shortId(ART), 'art_…e959e2');
});

test('names come from the lists the app already reads, and a review is named by its owner', () => {
  const review = `review_${'c'.repeat(32)}`;
  const names = recordNames(
    [{ id: ART, title: 'Delivery: grokking curve, seed 7' }],
    {
      tasks: [{ id: TASK, title: 'Reproduce grokking' }],
      reviews: [
        { id: review, subjectId: TASK },
        { id: 'review_unnamed', subjectId: 'wf_unknown' },
      ],
      actors: [
        { id: 'actor_1', name: 'Codex producer' },
        { id: 'actor_2', name: 'a3f0c2d19b7e4f6a8c5d' },
      ],
      experiments: null,
    },
    [
      { id: 'tasks', path: '/tasks' },
      { id: 'experiments', path: '/experiments' },
      { id: 'reviews', path: '/reviews' },
    ],
  );
  assert.deepEqual(names.get(ART), {
    name: 'Delivery: grokking curve, seed 7',
    to: `/artifacts/${ART}`,
  });
  assert.deepEqual(names.get(TASK), { name: 'Reproduce grokking', to: `/tasks/${TASK}` });
  // A review has no name of its own in a list: project.references names it (below).
  assert.equal(names.has(review), false);
  assert.equal(names.has('review_unnamed'), false);
  assert.deepEqual(names.get('actor_1'), { name: 'Codex producer' });
  // A directory name that is itself an identifier names nobody.
  assert.equal(names.has('actor_2'), false);
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

test('a worker still downloading is waited for: its clock runs only once it has loaded', async (t) => {
  // A module of its own, so no worker an earlier test started stands in for this one.
  const { Markdown: Fresh } = await import('../packages/ui/web/markdown.js?slow-start');
  // Loading takes longer than any one text is given to be read.
  await installWorker(t, 3000);
  await mount(
    createElement(MemoryRouter, null, createElement(Fresh, { source: 'A **slow** start.' })),
  );
  // Until it is read it stands as typed; it is read once the worker has loaded, not given up.
  for (let waited = 0; !document.querySelector('.md strong'); waited += 50) {
    assert.ok(waited < 15_000, 'read once the worker has loaded');
    await settle(50);
  }
});

test('bounding the work did not change what is read', () => {
  assert.equal(said(parseInline('[`a]`](/x) and `` ` `` and [b](</y z> "t")')), 'a] and ` and b');
  assert.deepEqual(
    parseMarkdown('# Goal #\n## ##\n### a#b ###   ').map((block: Node) => [
      block.level,
      said(block.children as Node[]),
    ]),
    [
      [1, 'Goal'],
      [2, ''],
      [3, 'a#b'],
    ],
  );
});

test('a link holds no link: a badge opens what its link names, not its picture', () => {
  const [badge] = parseInline('[![build](https://img.example/b.svg)](https://ci.example/run/1)');
  assert.deepEqual(badge, {
    type: 'link',
    href: 'https://ci.example/run/1',
    external: true,
    title: undefined,
    children: [{ type: 'text', value: 'build' }],
  });
  const links = (nodes: Node[]): Node[] =>
    nodes.flatMap((node) => [
      ...(node.type === 'link' ? [node] : []),
      ...links((node.children ?? []) as Node[]),
    ]);
  for (const source of [
    '[see http://x.example now](http://y.example)',
    '[mail <a@b.example> **now**](/here)',
  ]) {
    const found = links(parseInline(source));
    assert.equal(found.length, 1, source);
    assert.equal(links(found[0]!.children as Node[]).length, 0, source);
  }
  // As CommonMark has it, the inner link is the link and the outer brackets are text.
  const inner = parseInline('[a [b](http://inner.example) c](/outer)');
  assert.deepEqual(
    links(inner).map((link) => link.href),
    ['http://inner.example'],
  );
  assert.equal(said(inner), '[a b c](/outer)');
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

test('a document’s headings sit under its host’s, and a text too long to read is shown as typed', async (t) => {
  t.after(async () => await unmount());
  const under = (level?: number) =>
    createElement(
      MemoryRouter,
      null,
      createElement(Markdown, {
        source: '# One\n\n## Two\n\n###### Six',
        names: new Map(),
        under: level,
      }),
    );
  await mount(under());
  assert.deepEqual(
    all('.md .md-h').map((node) => node.tagName),
    ['H3', 'H4', 'H6'],
    'under the page’s h2 unless the host says it stands deeper',
  );
  await unmount();
  // A paper section is an h4: what is written inside it never stands beside that heading.
  await mount(under(4));
  assert.deepEqual(
    all('.md .md-h').map((node) => node.tagName),
    ['H5', 'H6', 'H6'],
  );
  await unmount();

  const long = `# Not read\n\n${'line of a log\n'.repeat(15_000)}`;
  assert.ok(long.length > MAX_READ);
  await mount(page(long, new Map()));
  assert.equal(document.querySelector('.md'), null);
  assert.ok(document.querySelector('pre.doc')!.textContent!.startsWith('# Not read'));
});

test('a growing text drawn in pieces reads as the whole does at every length', async (t) => {
  t.after(async () => await unmount());
  const source = [
    '# Findings',
    '',
    'A paragraph',
    'on two lines.',
    '',
    '1. first',
    '',
    '2. second',
    '   still the second',
    '',
    '```ts',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '> quoted',
    '',
    'Steps:',
    '',
    '1. **Install**',
    '',
    '   Run the installer.',
    '',
    '2. **Configure**',
    '',
    '   Set the key.',
    '',
    '10. **Check**',
    '',
    '    It answers.',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '    indented code',
    '',
    '    more of it',
    '',
    '- [x] done',
    '- open',
    '',
    'Cited [ref] and[^1].',
    '',
    '[ref]: /x',
    '',
    '[^1]: a note',
    '',
    '---',
    '',
    `See ${ART}.`,
  ].join('\n');
  const names = recordNames([{ id: ART, title: 'Notes' }]);
  // The fence's grammar loads only when the test lets it. A block drawn afresh is coloured once
  // its grammar is there, and one still streaming is not, so a grammar landing mid-stream would
  // make the pieces and the whole differ by when it landed, not by what they read.
  const { highlightNow, languageOf } = await import('../packages/ui/web/highlight.js');
  const ts = languageOf('ts')!;
  assert.equal(highlightNow('x', ts), undefined, 'the grammar is not loaded yet');
  const load = ts.load;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  ts.load = async () => (await released, await load());
  t.after(() => void (ts.load = load));
  let grow!: (text: string) => void;
  function Growing() {
    const [text, setText] = useState('');
    grow = setText;
    return createElement(MarkdownPieces, { source: text, names });
  }
  await mount(createElement(MemoryRouter, null, createElement(Growing)));
  const whole = document.createElement('div');
  const same = (end: number) => {
    whole.innerHTML = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(Markdown, { source: source.slice(0, end), names }),
      ),
    );
    // React sets a highlighted token's colours one property at a time, and jsdom prints
    // those back normalised: the static markup's are read the same way before comparing.
    for (const node of whole.querySelectorAll<HTMLElement>('[style]'))
      node.setAttribute('style', node.style.cssText);
    assert.equal(
      document.querySelector('.md')!.innerHTML,
      whole.firstElementChild!.innerHTML,
      `at ${end}`,
    );
  };
  // Every length: a frame may end anywhere, even at `2` before it becomes `2.`.
  for (let end = 1; end <= source.length; end++) {
    await act(async () => grow(source.slice(0, end)));
    same(end);
  }
  // Once the grammar is there and the text stands still, its fence is coloured as the whole's is.
  release();
  for (let tries = 0; !document.querySelector('.md .code-body [style]'); tries++) {
    assert.ok(tries < 400, 'the fence is coloured');
    await settle(25);
  }
  same(source.length);
  // A text too long to read whole is still read, piece by piece.
  const long = `# Read\n\n${'A line of an answer.\n\n'.repeat(12_000)}`;
  assert.ok(long.length > MAX_READ);
  await act(async () => grow(long));
  assert.equal(document.querySelectorAll('.md p').length, 12_000);
});

test('ids outside Markdown are named the same way, and a document reads its own names', async (t) => {
  t.after(async () => await unmount());
  const review = `review_${'c'.repeat(32)}`;
  const asked: unknown[] = [];
  // Each record is named and placed as its owner says, whatever its id looks like.
  serve('/tools/project.references', (_, sent) => {
    asked.push(sent.refs);
    const known: Record<string, object> = {
      [ART]: { kind: 'artifact', label: 'Delivery: grokking curve, seed 7' },
      [TASK]: { kind: 'task', label: 'Reproduce grokking' },
      [review]: { kind: 'review', label: 'Review of Reproduce grokking' },
    };
    return {
      body: {
        result: (sent.refs as string[]).map((id) =>
          known[id]
            ? { ref: id, id, status: 'resolved', ...known[id] }
            : { ref: id, id, status: 'missing', kind: null },
        ),
      },
    };
  });
  serve('/tools/ui.home', { body: { result: { actors: [{ id: 'actor_1', name: 'Ada' }] } } });
  serve('/tools/ui.shell', {
    body: {
      result: {
        rows: [
          { id: 'tasks', path: '/tasks', workflow: 'task', view: { kind: 'tasks' } },
          { id: 'verdicts', path: '/verdicts', view: { kind: 'reviews' } },
        ],
      },
    },
  });
  const nobody = `wf_${'d'.repeat(32)}`;
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RecordText, { text: `Pinned ${ART}.`, names: new Map() }),
      createElement(RecordText, { text: `Judged in ${review} by actor_1 of ${nobody}.` }),
      createElement(Markdown, { source: `Evidence: ${ART} for \`${TASK}\`` }),
    ),
  );
  await settle(10);
  // Given names it is not, a text names nothing; given none, it reads its own.
  assert.equal(
    text(),
    'Pinned art_…e959e2.' +
      `Judged in Review of Reproduce grokking by actor_1 of wf_…dddddd.` +
      'Evidence: Delivery: grokking curve, seed 7 for Reproduce grokking',
  );
  assert.deepEqual(
    all('a').map((a) => a.getAttribute('href')),
    [`/verdicts/${review}`, `/artifacts/${ART}`, `/tasks/${TASK}`],
  );
  // Every text on the page asks in the same request.
  assert.deepEqual(asked, [[review, nobody, ART, TASK]]);
});

test('names a growing text asks for come once, and stay while the next are asked', async (t) => {
  t.after(async () => await unmount());
  const asked: unknown[] = [];
  serve('/tools/project.references', (call, sent) => {
    asked.push(sent.refs);
    if (call > 1) return { network: true };
    const refs = sent.refs as string[];
    return {
      body: {
        result: refs.map((id) => ({
          ref: id,
          id,
          status: 'resolved',
          kind: 'artifact',
          label: `File ${id.at(-1)}`,
        })),
      },
    };
  });
  serve('/tools/ui.home', { body: { result: {} } });
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  const first = `art_${'1'.repeat(32)}`;
  const second = `art_${'2'.repeat(32)}`;
  let grow!: (source: string) => void;
  function Growing() {
    const [source, setSource] = useState(`See ${first}.`);
    grow = setSource;
    return createElement(MarkdownPieces, { source });
  }
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(Growing),
      createElement(RecordText, { text: `Also ${first}` }),
    ),
  );
  await settle(10);
  assert.equal(text(), 'See File 1.Also File 1');
  // The next answer fails: what the page already named stays named.
  await act(async () => grow(`See ${first}. Then ${second}.`));
  await settle(10);
  assert.equal(text(), 'See File 1. Then art_…222222.Also File 1');
  assert.deepEqual(asked, [[first], [second]]);
});

test('a file is named by a short human type, never by its media type', () => {
  const label = (mediaType: string, title = 'file') => fileType({ mediaType, title }).label;
  assert.deepEqual(
    [
      label('text/markdown'),
      label('text/markdown; charset=utf-8'),
      label('application/json'),
      label('application/vnd.api+json'),
      label('image/png'),
      label('image/svg+xml'),
      label('text/csv'),
      label('application/pdf'),
      label('text/x-python'),
      label('application/octet-stream'),
      label('text/plain'),
      label(''),
    ],
    [
      'Markdown',
      'Markdown',
      'JSON',
      'JSON',
      'PNG image',
      'SVG image',
      'CSV',
      'PDF',
      'Python',
      'Binary',
      'Text',
      'File',
    ],
  );
  // A type that says nothing of the kind leaves the end of the name to say it.
  assert.equal(label('text/plain', 'notes.md'), 'Markdown');
  assert.equal(label('application/octet-stream', 'metrics.json'), 'JSON');
  assert.equal(fileType({ mediaType: 'text/plain', title: 'notes.md' }).reads, 'markdown');
  assert.equal(fileType({ mediaType: 'application/json', title: 'm' }).reads, 'json');
  assert.equal(fileType({ mediaType: 'text/csv', title: 'm' }).reads, 'csv');
});

test('a Markdown file is read as a document, and one control shows its source', async (t) => {
  t.after(async () => await unmount());
  const artifact = {
    id: ART,
    projectId: 'project_1',
    createdBy: 'actor_1',
    title: 'Delivery: grokking curve, seed 7',
    mediaType: 'text/markdown',
    hash: '52d0a404b837827c',
    size: 457,
    createdAt: new Date().toISOString(),
  };
  serve('/tools/artifact.read', {
    body: {
      result: { artifact, encoding: 'utf8', content: '# Result\n| a | b |\n|---|---|\n| 1 | 2 |' },
    },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: ART, metadata: artifact }),
    ),
  );
  await settle(10);
  // The head says the type as a glyph and the weight as a number; the media type is not printed.
  assert.doesNotMatch(text(), /text\/markdown/);
  assert.match(text(), /457 B/);
  assert.equal(document.querySelector('.file-glyph')?.getAttribute('aria-label'), 'Markdown');
  assert.equal(document.querySelector('.md h3')?.textContent, 'Result');
  assert.equal(all('.md td').length, 2);

  const toggle = document.querySelector('button[aria-label="View source"]') as HTMLButtonElement;
  assert.deepEqual([toggle.title, toggle.getAttribute('aria-pressed')], ['View source', 'false']);
  const { act } = await import('react-dom/test-utils');
  await act(async () => toggle.click());
  await settle(0);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.md'), null);
  assert.match(
    document.querySelector('.code-block pre')?.textContent ?? '',
    /^# Result\n\| a \| b \|/,
  );
});

test('experiment references display names for bare IDs and explicit paper links', async (t) => {
  t.after(unmount);
  const id = 'wf_1234567890abcdef1234567890abcdef';
  serve('/tools/ui.home', { body: { result: { experiments: [{ id, name: 'retrieval-check' }] } } });
  serve('/tools/ui.shell', {
    body: { result: { rows: [{ id: 'experiments', path: '/experiments' }] } },
  });
  await mount(
    page(
      `The experiment ${id} is ongoing. See [${id}](/experiments/${id}) and [old label](/experiments/${id}).`,
    ),
  );
  await settle();
  const links = all(`a[href="/experiments/${id}"]`);
  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map((link) => link.textContent),
    ['retrieval-check', 'retrieval-check', 'retrieval-check'],
  );
  assert.ok(!text().includes(id));
});

test('a file older than the newest page is still named where it is cited', async (t) => {
  t.after(async () => await unmount());
  const { useArtifacts } = await import('../packages/ui/web/components.js');
  const old = 'art_00000000000000000000000000000abc';
  const newer = Array.from({ length: 200 }, (_, at) => ({
    id: `art_${String(at).padStart(32, '0')}`,
    title: `Newer ${at}`,
  }));
  // The tool's first page holds as many as were asked for, newest first.
  serve('/tools/artifact.list', (_, sent) => ({
    body: {
      result: [...newer, { id: old, title: 'Brief: the first sweep' }].slice(
        0,
        Number(sent.limit ?? 1000),
      ),
    },
  }));
  function Picked() {
    const files = useArtifacts();
    return createElement('p', { className: 'picked' }, files.get(old)?.title ?? 'missing');
  }
  serve('/tools/project.references', {
    body: {
      result: [
        {
          ref: old,
          id: old,
          status: 'resolved',
          kind: 'artifact',
          label: 'Brief: the first sweep',
        },
      ],
    },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(Markdown, { source: `Cites ${old}.` }),
      createElement(Picked),
    ),
  );
  await settle(10);
  assert.equal(document.querySelector('.md')!.textContent, 'Cites Brief: the first sweep.');
  assert.equal(document.querySelector('.picked')!.textContent, 'Brief: the first sweep');
});

test('a reference lookup asks once, and never again for what came back missing', async (t) => {
  t.after(async () => await unmount());
  const { ReferenceLookup } = await import('../packages/ui/web/views/paper-references.js');
  const asked: unknown[] = [];
  serve('/tools/project.references', (_, sent) => {
    asked.push(sent.refs);
    const refs = sent.refs as string[];
    return {
      body: { result: refs.map((ref) => ({ ref, id: ref, status: 'missing', kind: null })) },
    };
  });
  serve('/tools/ui.home', { body: { result: {} } });
  serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  await mount(createElement(MemoryRouter, null, createElement(ReferenceLookup)));
  const field = document.querySelector('textarea')!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  const refs = [`art_${'3'.repeat(32)}`, `wf_${'4'.repeat(32)}`];
  await act(async () => {
    set.call(field, refs.join('\n'));
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => document.querySelector('form')!.requestSubmit());
  await settle(10);
  assert.match(text(), /art_…333333/);
  assert.deepEqual(asked, [refs]);
});

test('a text drawn again names what it named before without asking again', async (t) => {
  t.after(async () => await unmount());
  const named = `art_${'5'.repeat(32)}`;
  const asked: unknown[] = [];
  const answer = () => {
    serve('/tools/project.references', (_, sent) => {
      asked.push(sent.refs);
      return {
        body: {
          result: [{ ref: named, id: named, status: 'resolved', kind: 'artifact', label: 'Fit' }],
        },
      };
    });
    serve('/tools/ui.home', { body: { result: {} } });
    serve('/tools/ui.shell', { body: { result: { rows: [] } } });
  };
  for (let draw = 0; draw < 2; draw++) {
    if (draw) await unmount();
    answer();
    await mount(
      createElement(MemoryRouter, null, createElement(RecordText, { text: `See ${named}` })),
    );
    await settle(10);
    assert.equal(text(), 'See Fit');
  }
  assert.deepEqual(asked, [[named]]);
});
