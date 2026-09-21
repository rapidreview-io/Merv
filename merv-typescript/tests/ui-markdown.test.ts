/**
 * Documents, read. A brief or a delivery is Markdown an agent wrote, and these
 * tests are about what a person then sees: headings and tables instead of `#` and
 * pipes, a name where an id was written, and nothing an author typed ever reaching
 * the browser as an address it should not open. The parser is pure, so most of
 * this asserts on its tree; the last tests mount the component and read the DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const {
  MAX_READ,
  Markdown,
  RecordText,
  idsIn,
  parseInline,
  parseMarkdown,
  recordNames,
  recordRoute,
  safeHref,
  shortId,
} = await import('../packages/ui/web/markdown.js');
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
  assert.equal(recordRoute(ART), `/artifacts/${ART}`);
  assert.equal(recordRoute(`review_${'a'.repeat(32)}`), `/reviews/review_${'a'.repeat(32)}`);
  // A wf_ may be a task, an experiment, a cycle or a reflection: its shape names no page.
  assert.equal(recordRoute(TASK), undefined);
});

test('names come from the lists the app already reads, a review named by what it judges', () => {
  const review = `review_${'c'.repeat(32)}`;
  const names = recordNames([{ id: ART, title: 'Delivery: grokking curve, seed 7' }], {
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
  });
  assert.deepEqual(names.get(ART), {
    name: 'Delivery: grokking curve, seed 7',
    to: `/artifacts/${ART}`,
  });
  assert.deepEqual(names.get(TASK), { name: 'Reproduce grokking', to: `/tasks/${TASK}` });
  assert.deepEqual(names.get(review), {
    name: 'Review of Reproduce grokking',
    to: `/reviews/${review}`,
  });
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

test('no text a member can post holds the page: the work is bounded per character', () => {
  const runs = (count: number) =>
    Array.from({ length: count }, (_, index) => '`'.repeat(index + 1)).join(' ');
  // Each of these took seconds, or minutes, when every bracket walked to the paragraph's end.
  const slow: [string, string][] = [
    ['brackets before backtick runs', '['.repeat(3000) + runs(95)],
    ['a heading of spaces', `# a${' '.repeat(80_000)}b`],
    ['a line of spaces before a break', `a${' '.repeat(80_000)}b\nc`],
    ['links that never close', '[a]('.repeat(20_000)],
    ['angle destinations that never close', '[a](<'.repeat(16_000)],
    ['titles that never close', '[a](b "'.repeat(11_000)],
    ['a divider of spaces', `a|b\n|-|-|${' '.repeat(80_000)}x`],
    ['a list item of spaces', `- ${' '.repeat(80_000)} `],
    [
      'a table of nothing but pipes',
      `${'|'.repeat(8000)}\n${'|-'.repeat(8000)}\n${'|'.repeat(8000)}`,
    ],
    ['an address of dots', `<a@${'b.'.repeat(40_000)}@>`],
    ['an address of closing brackets', `http://a.b/${')'.repeat(80_000)}`],
  ];
  for (const [name, source] of slow) {
    const started = performance.now();
    assert.ok(Array.isArray(parseMarkdown(source)), name);
    // A generous budget for a slow machine; the defect it guards against was 100x over it.
    assert.ok(performance.now() - started < 1500, `${name} took too long`);
  }
  // Bounding the work did not change what is read.
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
    '[a [b](http://inner.example) c](http://outer.example)',
    '[mail <a@b.example> **now**](/here)',
  ]) {
    const found = links(parseInline(source));
    assert.equal(found.length, 1, source);
    assert.equal(links(found[0]!.children as Node[]).length, 0, source);
  }
  assert.equal(said(parseInline('[a [b](http://inner.example) c](/outer)')), 'a b c');
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

test('ids outside Markdown are named the same way, and a document reads its own names', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/artifact.list', {
    body: { result: [{ id: ART, title: 'Delivery: grokking curve, seed 7' }] },
  });
  serve('/tools/ui.home', {
    body: { result: { tasks: [{ id: TASK, title: 'Reproduce grokking' }] } },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RecordText, { text: `Pinned ${ART}.`, names: new Map() }),
      createElement(Markdown, { source: `Evidence: ${ART} for \`${TASK}\`` }),
    ),
  );
  await settle(10);
  assert.equal(
    text(),
    'Pinned art_…e959e2.Evidence: Delivery: grokking curve, seed 7 for Reproduce grokking',
  );
  assert.deepEqual(
    all('a').map((a) => a.getAttribute('href')),
    [`/artifacts/${ART}`, `/artifacts/${ART}`, `/tasks/${TASK}`],
  );
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
  assert.equal(fileType({ mediaType: 'text/csv', title: 'm' }).reads, 'text');
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
  assert.match(document.querySelector('pre.doc')?.textContent ?? '', /^# Result\n\| a \| b \|/);
});

test('JSON is indented where it parses and left alone where it does not', async (t) => {
  t.after(async () => await unmount());
  const artifact = {
    id: 'art_json',
    projectId: 'project_1',
    createdBy: 'actor_1',
    title: 'metrics.json',
    mediaType: 'application/json',
    hash: 'abc',
    size: 20,
    createdAt: new Date().toISOString(),
  };
  serve('/tools/artifact.read', {
    body: { result: { artifact, encoding: 'utf8', content: '{"seed":7,"val":[0.97]}' } },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: 'art_json', metadata: artifact }),
    ),
  );
  await settle(10);
  assert.equal(
    document.querySelector('pre.doc')?.textContent,
    '{\n  "seed": 7,\n  "val": [\n    0.97\n  ]\n}',
  );
  // Only a document has a source to turn back to.
  assert.equal(document.querySelector('button[aria-label="View source"]'), null);
});

test('experiment references display names for bare IDs and explicit paper links', async (t) => {
  t.after(unmount);
  const id = 'wf_1234567890abcdef1234567890abcdef';
  serve('/tools/ui.home', { body: { result: { experiments: [{ id, name: 'retrieval-check' }] } } });
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
