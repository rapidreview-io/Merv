/**
 * Files and agent text, read as what they are: code coloured and copyable, a
 * terminal's colours kept and its escapes gone, formulas typeset, diagrams drawn,
 * tables as tables, notebooks as cells and pictures as pictures. Each of those is
 * asserted as a person meets it, and so is what must never happen: a price read as
 * a formula, an SVG's script run, a notebook's HTML executed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
const { act } = await import('react-dom/test-utils');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { parseAnsi } = await import('../packages/ui/web/ansi.js');
const { lineElements } = await import('../packages/ui/web/code-block.js');
const { parseDelimited } = await import('../packages/ui/web/csv.js');
const { languageOf } = await import('../packages/ui/web/highlight.js');
const { Markdown } = await import('../packages/ui/web/markdown.js');
const { parseInline, parseMarkdown } = await import('../packages/ui/web/markdown-parse.js');
const { Mermaid, mermaidLoader } = await import('../packages/ui/web/mermaid.js');
const { ArtifactBody, fileType } = await import('../packages/ui/web/views/artifacts.js');

/** A file of its own for every mount: the read layer keeps the last answer for an id. */
let files = 0;
const nextId = () => `art_${String(++files).padStart(32, '0')}`;
const all = (selector: string) => [...document.querySelectorAll(selector)];
const one = (selector: string) => document.querySelector(selector);
const page = (source: string) =>
  createElement(MemoryRouter, null, createElement(Markdown, { source, names: new Map() }));
const press = async (selector: string) => {
  const button = one(selector) as HTMLButtonElement | null;
  assert.ok(button, `no control ${selector}`);
  await act(async () => button.click());
  await settle(0);
};
/** Wait, a little at a time, for what a lazy chunk draws once it has loaded. */
const until = async (ready: () => boolean, ms = 8000) => {
  for (const start = Date.now(); !ready();) {
    if (Date.now() - start > ms) return false;
    await settle(25);
  }
  return true;
};
const clipboard = (t: { after(fn: () => void): void }) => {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void copied.push(value) },
  });
  t.after(() => Reflect.deleteProperty(navigator, 'clipboard'));
  return copied;
};
const file = async (
  meta: { title: string; mediaType: string },
  content: string,
  encoding = 'utf8',
) => {
  const id = nextId();
  const artifact = {
    id,
    projectId: 'project_1',
    createdBy: 'actor_1',
    hash: 'abc',
    size: content.length,
    createdAt: new Date().toISOString(),
    ...meta,
  };
  serve('/tools/artifact.read', { body: { result: { artifact, encoding, content } } });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: id, metadata: artifact }),
    ),
  );
  await settle(10);
};

test('a fence is a code block with its language, a copy control, and plain text until it is coloured', async (t) => {
  t.after(async () => await unmount());
  const copied = clipboard(t);
  const code = 'def train(seed):\n    return seed * 2  # twice';
  await mount(page(`Run it:\n\n\`\`\`python\n${code}\n\`\`\``));
  assert.equal(one('.md pre[data-lang]'), null);
  assert.equal(one('.code-block .code-lang')?.textContent, 'Python');
  // Drawn plain at once: the text is all there before the grammar arrives.
  assert.equal(one('.code-body')?.textContent, code);
  assert.equal(all('.code-body [style]').length, 0);
  await press('.code-block button[aria-label="Copy"]');
  assert.deepEqual(copied, [code]);
  // A short fence is not numbered; wrapping is one press.
  assert.equal(one('.code-block--numbered'), null);
  await press('button[aria-label="Wrap long lines"]');
  assert.ok(one('.code-block--wrap'));

  assert.ok(await until(() => all('.code-body [style]').length > 0), 'python is coloured');
  assert.equal(one('.code-body')?.textContent, code, 'colour changes no character');
  const keyword = all('.code-body [style]').find(
    (node) => node.textContent === 'def',
  ) as HTMLElement;
  assert.ok(keyword.style.getPropertyValue('--shiki-light'));
  assert.ok(keyword.style.getPropertyValue('--shiki-dark'));
});

test('a TypeScript fence is coloured as tokens, never as HTML, and a long one is numbered', async (t) => {
  t.after(async () => await unmount());
  const code = Array.from({ length: 12 }, (_, at) => `const line${at}: number = ${at};`).join('\n');
  await mount(page(`\`\`\`ts\n${code}\n\`\`\``));
  assert.ok(one('.code-block--numbered'), 'past ten lines a fence is numbered');
  assert.equal(all('.code-line').length, 12);
  assert.ok(await until(() => all('.code-body [style]').length > 0), 'typescript is coloured');
  assert.equal(one('.code-body')?.textContent, code);
  // The numbers are the stylesheet's: nothing but the code is in the text.
  assert.doesNotMatch(one('.code-body')!.textContent!, /^1/);

  // What the highlighter's tokens become: a span for a styled stretch, text for a plain one.
  const markup = renderToStaticMarkup(
    createElement(
      'code',
      null,
      lineElements([
        { content: '<b>', style: { '--shiki-light': '#D73A49', '--shiki-dark': '#F97583' } },
        { content: ' & plain' },
      ]),
    ),
  );
  assert.equal(
    markup,
    '<code><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">&lt;b&gt;</span> &amp; plain</code>',
  );
  assert.deepEqual(
    ['ts', 'Python', 'train.py', 'Dockerfile', 'proof.lean', 'x.unknown', undefined].map(
      (word) => languageOf(word)?.id,
    ),
    ['typescript', 'python', 'python', 'dockerfile', 'lean', undefined, undefined],
  );
});

test('a diff tints what it adds and removes', async (t) => {
  t.after(async () => await unmount());
  await mount(page('```diff\n--- a/x\n+++ b/x\n-old\n+new\n same\n```'));
  assert.deepEqual(
    all('.code-line').map((line) => line.className),
    ['code-line', 'code-line', 'code-line code-line--del', 'code-line code-line--add', 'code-line'],
  );
});

test('ANSI colour and weight become spans, and every other escape is dropped', () => {
  assert.deepEqual(parseAnsi('\x1b[1;31mFAIL\x1b[0m done\x1b[2K\x1b]0;title\x07!'), [
    { text: 'FAIL', className: 'ansi-fg1 ansi-bold' },
    { text: ' done!' },
  ]);
  // A 256-colour form is read past, not mistaken for blink and a colour.
  assert.deepEqual(parseAnsi('\x1b[38;5;196mred\x1b[39m \x1b[92;44mok\x1b[22;49m'), [
    { text: 'red ' },
    { text: 'ok', className: 'ansi-fg2 ansi-bg4' },
  ]);
  assert.deepEqual(parseAnsi('plain'), [{ text: 'plain' }]);
});

test('math: inline by pandoc’s rule, display blocks and fences, and prices stay prices', async (t) => {
  t.after(async () => await unmount());
  const kinds = (source: string) => parseInline(source).map((node) => node.type);
  assert.deepEqual(parseInline('It costs $5 and $10 today.'), [
    { type: 'text', value: 'It costs $5 and $10 today.' },
  ]);
  assert.deepEqual(parseInline('Energy $E = mc^2$ holds.')[1], { type: 'math', value: 'E = mc^2' });
  assert.deepEqual(kinds('$ x$ and $y $'), ['text']);
  assert.deepEqual(kinds('`$x$` is code'), ['code', 'text']);
  assert.deepEqual(kinds('\\$x$ is escaped'), ['text']);
  assert.deepEqual(
    parseMarkdown(
      'Before\n$$\n\\int_0^1 x\\,dx\n$$\n\n$$ a+b $$\n\n```math\nx^2\n```\n\n```latex\ny\n```\n\n$$5 is a lot',
    ).map((block) => [block.type, 'value' in block ? block.value : null]),
    [
      ['paragraph', null],
      ['math', '\\int_0^1 x\\,dx'],
      ['math', 'a+b'],
      ['math', 'x^2'],
      ['math', 'y'],
      ['paragraph', null],
    ],
  );

  await mount(page('Inline $x^2$ here.\n\n$$\\frac{1}{2}$$'));
  // The TeX stands as written until KaTeX arrives, then is typeset.
  assert.equal(one('code.math')?.textContent, 'x^2');
  assert.ok(await until(() => all('.katex').length === 2), 'KaTeX typesets both');
  assert.ok(one('.math--display .katex-display'));
});

test('a Mermaid fence is a diagram with its source a press away, drawn again in a new theme', async (t) => {
  t.after(async () => await unmount());
  const load = mermaidLoader.load;
  t.after(() => {
    mermaidLoader.load = load;
    delete document.documentElement.dataset.theme;
  });
  const themes: string[] = [];
  const ids: string[] = [];
  mermaidLoader.load = async () =>
    ({
      initialize: (config: { theme: string; securityLevel: string }) => {
        assert.equal(config.securityLevel, 'strict');
        themes.push(config.theme);
      },
      render: async (id: string) => {
        ids.push(id);
        return { svg: `<svg id="${id}" style="max-width: 900px;"><g></g></svg>` };
      },
    }) as never;
  const source = 'graph TD\n  A --> B';
  await mount(page(`\`\`\`mermaid\n${source}\n\`\`\``));
  // Until it is drawn, the source stands in its place.
  assert.equal(one('.mermaid pre')?.textContent, source);
  await settle(200);
  assert.ok(one('.mermaid-view svg'));
  assert.equal((one('.mermaid-view > div') as HTMLElement).style.width, '900px');
  await press('.mermaid button[aria-label="View source"]');
  assert.equal(one('.mermaid-view'), null);
  assert.equal(one('.mermaid pre')?.textContent, source);
  await press('.mermaid button[aria-label="View source"]');
  await act(async () => {
    document.documentElement.dataset.theme = 'dark';
  });
  await settle(200);
  assert.deepEqual(themes, ['default', 'dark']);
  assert.equal(new Set(ids).size, ids.length, 'every drawing has an id of its own');
});

test('a Mermaid source that does not parse is shown with the complaint, never a blank', async (t) => {
  t.after(async () => await unmount());
  const load = mermaidLoader.load;
  t.after(() => void (mermaidLoader.load = load));
  mermaidLoader.load = async () =>
    ({
      initialize() {},
      render: async () => {
        throw new Error('Parse error on line 2:\n...A -->\n-----^');
      },
    }) as never;
  await file({ title: 'flow.mmd', mediaType: 'text/plain' }, 'graph TD\n  A -->');
  await settle(200);
  assert.equal(one('.mermaid pre')?.textContent, 'graph TD\n  A -->');
  assert.equal(one('.mermaid-error')?.textContent, 'Diagram not drawn: Parse error on line 2:');
  assert.equal(one('.mermaid-view'), null);
});

test('each kind of file is read as what it is, decided in one place', () => {
  const read = (mediaType: string, title: string) => {
    const type = fileType({ mediaType, title });
    return [type.label, type.reads, type.lang ?? null, type.image ?? null];
  };
  assert.deepEqual(read('text/plain', 'events.jsonl'), ['JSON Lines', 'jsonl', null, null]);
  assert.deepEqual(read('application/x-ndjson', 'e'), ['JSON Lines', 'jsonl', null, null]);
  assert.deepEqual(read('text/csv', 'm'), ['CSV', 'csv', null, null]);
  assert.deepEqual(read('text/plain', 'm.tsv'), ['TSV', 'tsv', null, null]);
  assert.deepEqual(read('application/octet-stream', 'run.ipynb'), [
    'Notebook',
    'notebook',
    'json',
    null,
  ]);
  assert.deepEqual(read('application/x-ipynb+json', 'n'), ['Notebook', 'notebook', 'json', null]);
  assert.deepEqual(read('text/plain', 'flow.mmd'), ['Mermaid', 'mermaid', null, null]);
  assert.deepEqual(read('image/png', 'plot'), ['PNG image', 'image', null, 'image/png']);
  assert.deepEqual(read('application/octet-stream', 'plot.webp'), [
    'WEBP image',
    'image',
    null,
    'image/webp',
  ]);
  assert.deepEqual(read('image/svg+xml', 'fig'), ['SVG image', 'image', 'xml', 'image/svg+xml']);
  assert.deepEqual(read('text/plain', 'train.py'), ['Python', 'code', 'train.py', null]);
  assert.deepEqual(read('text/x-rust', 'main'), ['Rust', 'code', 'rust', null]);
  assert.deepEqual(read('text/plain', 'Main.lean'), ['Lean', 'code', 'Main.lean', null]);
  assert.deepEqual(read('text/plain', 'run.log'), ['Log', 'text', null, null]);
  assert.deepEqual(read('text/plain', 'notes'), ['Text', 'text', null, null]);
  assert.deepEqual(read('text/markdown', 'a'), ['Markdown', 'markdown', 'markdown', null]);
  assert.deepEqual(read('application/json', 'a'), ['JSON', 'json', 'json', null]);
});

test('the CSV parser reads quotes, doubled quotes and newlines inside quotes, and refuses a ragged file', () => {
  assert.deepEqual(parseDelimited('a,b,c\r\n1,"x, y","say ""hi"""\n2,"two\nlines",\n', ','), [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'say "hi"'],
    ['2', 'two\nlines', ''],
  ]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.equal(parseDelimited('a,b\n1,2,3', ','), undefined, 'ragged');
  assert.equal(parseDelimited('a,b\n"1,2', ','), undefined, 'unclosed quote');
  assert.equal(parseDelimited('a,b\n"1"x,2', ','), undefined, 'text after a quote');
});

test('a CSV file is a table with a head, numbered rows, numbers set right and rows a page at a time', async (t) => {
  t.after(async () => await unmount());
  const rows = Array.from({ length: 450 }, (_, at) => `run ${at},${at / 10},"note, ${at}"`);
  await file({ title: 'runs.csv', mediaType: 'text/csv' }, `name,loss,note\n${rows.join('\n')}`);
  assert.equal(one('.table-file-size')?.textContent, '450 rows · 3 columns');
  assert.deepEqual(
    all('.table-file thead th').map((cell) => cell.textContent),
    ['', 'name', 'loss', 'note'],
  );
  assert.deepEqual(
    all('.table-file thead th.num').map((cell) => cell.textContent),
    ['loss'],
  );
  assert.equal(all('.table-file tbody tr').length, 200);
  assert.equal(one('.table-file tbody th')?.textContent, '1');
  assert.equal(all('.table-file tbody tr')[0]!.lastElementChild!.textContent, 'note, 0');
  await press('.table-file > .btn-text');
  assert.equal(all('.table-file tbody tr').length, 400);
  assert.equal(one('.table-file > .btn-text')?.textContent, 'Show 50 more');
  // The one control on the head turns the table back into its text.
  await press('button[aria-label="View source"]');
  assert.equal(one('.table-file'), null);
  assert.match(one('.code-block pre')?.textContent ?? '', /^name,loss,note\nrun 0,0,"note, 0"/);
});

test('a ragged CSV stays its text, with no source to turn to', async (t) => {
  t.after(async () => await unmount());
  await file({ title: 'bad.csv', mediaType: 'text/csv' }, 'a,b\n1,2,3');
  assert.equal(one('.table-file'), null);
  assert.equal(one('.code-block pre')?.textContent, 'a,b\n1,2,3');
  assert.equal(one('button[aria-label="View source"]'), null);
});

test('a long cell that is nearly a number is read at once, not tried every way it could be cut', async (t) => {
  t.after(async () => await unmount());
  const started = performance.now();
  await file({ title: 'long.csv', mediaType: 'text/csv' }, `id\n1\n${'9'.repeat(100_000)}x\n`);
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
  assert.equal(all('.table-file tbody tr').length, 2);
  assert.equal(one('.table-file thead th.num'), null, 'a column with a word in it is text');
});

test('JSON Lines: a tree a line, numbered as the file numbers it, and a bad line marked as text', async (t) => {
  t.after(async () => await unmount());
  await file(
    { title: 'events.jsonl', mediaType: 'text/plain' },
    '{"step":1,"loss":0.5}\n{"step":2,\n\n{"step":3}\n',
  );
  assert.deepEqual(
    all('.jsonl-number').map((node) => node.textContent),
    ['1', '2', '4'],
  );
  assert.equal(all('.jsonl .json').length, 2);
  const bad = one('.jsonl-bad');
  assert.equal(bad?.querySelector('code')?.textContent, '{"step":2,');
  assert.equal(bad?.querySelector('[aria-label="Not JSON"]')?.textContent, '!');
});

test('a notebook reads as its cells; HTML and scripts it holds are text, and its images its own', async (t) => {
  t.after(async () => await unmount());
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const notebook = {
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Results\n', 'Loss **fell**.'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: 'print(loss)',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['\x1b[31m0.12\x1b[0m\n'] },
          {
            output_type: 'display_data',
            data: { 'text/html': ['<b>bold</b><script>window.ran = true</script>'] },
          },
          { output_type: 'display_data', data: { 'image/png': PNG, 'text/plain': '<Figure>' } },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad',
            traceback: ['\x1b[0;31mValueError\x1b[0m: bad'],
          },
        ],
      },
    ],
  };
  await file(
    { title: 'run.ipynb', mediaType: 'application/octet-stream' },
    JSON.stringify(notebook),
  );
  assert.equal(one('.notebook .md h4')?.textContent, 'Results');
  assert.equal(one('.notebook .md strong')?.textContent, 'fell');
  assert.equal(one('.nb-count')?.textContent, '[3]');
  assert.equal(one('.notebook .code-lang')?.textContent, 'Python');
  assert.equal(one('.notebook .code-body')?.textContent, 'print(loss)');
  assert.equal(one('.nb-output .ansi-fg1')?.textContent, '0.12');
  // The HTML output is shown as the text it is: nothing in it becomes an element.
  assert.equal(one('.notebook b'), null);
  assert.equal(one('.notebook script'), null);
  assert.equal((window as unknown as { ran?: boolean }).ran, undefined);
  assert.match(
    one('.nb-markup')?.textContent ?? '',
    /text\/html, shown as text<b>bold<\/b><script>/,
  );
  assert.equal(one('.nb-image')?.getAttribute('src'), `data:image/png;base64,${PNG}`);
  assert.equal(one('.nb-output--error .ansi-fg1')?.textContent, 'ValueError');
  await press('button[aria-label="View source"]');
  assert.equal(one('.notebook'), null);
  assert.equal(one('.code-block pre')?.textContent, JSON.stringify(notebook));
});

test('an SVG is an image from its own bytes, never inline, and a picture opens at full size', async (t) => {
  t.after(async () => await unmount());
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.ran = true</script><rect/></svg>';
  await file({ title: 'fig.svg', mediaType: 'image/svg+xml' }, svg);
  const image = one('.file-image img');
  assert.equal(
    image?.getAttribute('src'),
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
  assert.equal(one('.doc-frame svg rect'), null);
  assert.equal(one('.doc-frame script'), null);
  assert.equal((window as unknown as { ran?: boolean }).ran, undefined);
  await press('.file-image');
  assert.equal(one('.file-image')?.getAttribute('aria-pressed'), 'true');
  await press('button[aria-label="View source"]');
  assert.equal(one('.file-image'), null);
  assert.equal(one('.code-block pre')?.textContent, svg);
  await unmount();

  await file({ title: 'plot.png', mediaType: 'image/png' }, 'iVBORw0KGgo=', 'base64');
  assert.equal(one('.file-image img')?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(one('button[aria-label="View source"]'), null);
});

test('code is numbered with its language, and a log keeps its colours', async (t) => {
  t.after(async () => await unmount());
  await file({ title: 'train.py', mediaType: 'text/plain' }, 'import torch\nprint(1)\n');
  assert.ok(one('.code-block--numbered'));
  assert.equal(one('.code-lang')?.textContent, 'Python');
  assert.equal(all('.code-line').length, 2);
  assert.equal(one('button[aria-label="View source"]'), null);
  await unmount();

  await file({ title: 'run.log', mediaType: 'text/plain' }, 'step 1\n\x1b[33mwarn\x1b[0m slow\n');
  assert.equal(one('.code-body .ansi-fg3')?.textContent, 'warn');
  assert.equal(one('.code-body')?.textContent, 'step 1\nwarn slow');
  assert.doesNotMatch(one('.doc-frame')!.textContent!, /\x1b/);
});

test('a notebook bent by hand or by a crash still reads as its cells', async (t) => {
  t.after(async () => await unmount());
  const cell = (outputs: unknown) => ({ cell_type: 'code', source: 'x', outputs });
  await file(
    { title: 'bent.ipynb', mediaType: 'application/x-ipynb+json' },
    JSON.stringify({
      cells: [
        cell({}),
        cell([null, 'text', { output_type: 'stream', text: 'ran\n' }]),
        cell([{ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: 'boom' }]),
      ],
    }),
  );
  assert.equal(all('.notebook .nb-cell').length, 3);
  assert.deepEqual(
    all('.nb-output').map((node) => node.textContent),
    ['ran\n', 'ValueError: bad'],
  );
});

test('a view that fails to draw says so in its place, and tries again when asked or moved on', async (t) => {
  t.after(async () => await unmount());
  const { ErrorBoundary } = await import('../packages/ui/web/components.js');
  const failing = { now: true };
  const Fragile = () => {
    if (failing.now) throw new Error('outputs.map is not a function');
    return createElement('p', { className: 'drawn' }, 'drawn');
  };
  let show: (reset: number) => void = () => {};
  const Page = () => {
    const [reset, setReset] = useState(0);
    show = setReset;
    return createElement(
      'main',
      null,
      createElement('h1', null, 'Head'),
      createElement(ErrorBoundary, { reset }, createElement(Fragile)),
    );
  };
  const quiet = console.error;
  console.error = () => {};
  t.after(() => void (console.error = quiet));
  await mount(createElement(Page));
  assert.equal(one('h1')?.textContent, 'Head');
  assert.equal(one('[role="alert"] .empty-title')?.textContent, 'This view failed to render');
  assert.match(one('[role="alert"]')?.textContent ?? '', /outputs\.map is not a function/);
  await click('Retry');
  assert.ok(one('[role="alert"]'), 'still failing, still said');
  failing.now = false;
  await act(async () => show(1));
  assert.equal(one('.drawn')?.textContent, 'drawn');
  failing.now = true;
  await act(async () => show(2));
  assert.ok(one('[role="alert"]'));
  failing.now = false;
  await click('Retry');
  assert.equal(one('.drawn')?.textContent, 'drawn');
});

test('a view that fails at the address it moved to stays failed there, drawn no more than once', async (t) => {
  t.after(async () => await unmount());
  const { ErrorBoundary } = await import('../packages/ui/web/components.js');
  let draws = 0;
  const Fragile = ({ at }: { at: string }) => {
    draws++;
    if (at === '/broken') throw new Error('outputs.map is not a function');
    return createElement('p', { className: 'drawn' }, at);
  };
  let go: (at: string) => void = () => {};
  const Page = () => {
    const [at, setAt] = useState('/broken');
    go = setAt;
    return createElement(ErrorBoundary, { reset: at }, createElement(Fragile, { at }));
  };
  const quiet = console.error;
  console.error = () => {};
  t.after(() => void (console.error = quiet));
  await mount(createElement(Page));
  // However many times React itself retries a failing draw, arriving there is the measure.
  const arriving = draws;
  assert.ok(document.querySelector('[role="alert"]'));
  await act(async () => go('/fine'));
  assert.equal(document.querySelector('.drawn')?.textContent, '/fine');
  draws = 0;
  await act(async () => go('/broken'));
  assert.ok(document.querySelector('[role="alert"]'), 'the failure is said at its address');
  assert.equal(draws, arriving, 'and the failing view is not drawn again on the way');
  await act(async () => go('/fine'));
  assert.equal(document.querySelector('.drawn')?.textContent, '/fine', 'moving on clears it');
});

test('how one file is read, its source shown, does not carry over to the next', async (t) => {
  t.after(async () => await unmount());
  const notebook = JSON.stringify({ cells: [{ cell_type: 'markdown', source: '# One' }] });
  const artifactOf = (id: string) => ({
    id,
    projectId: 'project_1',
    createdBy: 'actor_1',
    hash: 'abc',
    size: notebook.length,
    createdAt: new Date().toISOString(),
    title: `${id}.ipynb`,
    mediaType: 'application/x-ipynb+json',
  });
  const [first, second] = [nextId(), nextId()];
  serve('/tools/artifact.read', (_, sent) => ({
    body: {
      result: {
        artifact: artifactOf(String(sent.artifactId)),
        encoding: 'utf8',
        content: notebook,
      },
    },
  }));
  let open: (id: string) => void = () => {};
  const Reader = () => {
    const [id, setId] = useState(first);
    open = setId;
    return createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: id, metadata: artifactOf(id) }),
    );
  };
  await mount(createElement(Reader));
  await settle(10);
  await press('button[aria-label="View source"]');
  assert.equal(one('.notebook'), null);
  await act(async () => open(second));
  await settle(10);
  assert.equal(one('button[aria-label="View source"]')?.getAttribute('aria-pressed'), 'false');
  assert.ok(one('.notebook'));
});

test('a line is coloured whole however long its grammar takes to read it', async () => {
  const { highlight, languageOf } = await import('../packages/ui/web/highlight.js');
  const ts = languageOf('ts')!;
  const code = 'const a = 1;';
  const steady = await highlight(code, ts);
  assert.ok(steady && steady[0]!.length >= 7, 'every token of the line');
  // A grammar reads its first lines slowly while it compiles, more so on a busy machine: a clock
  // that leaps a second with each look stands for that. The line must not be cut short.
  const now = Date.now;
  let clock = now();
  Date.now = () => (clock += 1000);
  try {
    assert.deepEqual(await highlight(code, ts), steady);
  } finally {
    Date.now = now;
  }
});

test('code still streaming in is drawn plain and coloured once it stands still; a long file never is', async (t) => {
  t.after(async () => await unmount());
  const { CodeBlock } = await import('../packages/ui/web/code-block.js');
  const { highlightable } = await import('../packages/ui/web/highlight.js');
  const start = 'def train(seed):\n    return seed';
  let write: (code: string) => void = () => {};
  const Stream = () => {
    const [code, setCode] = useState(start);
    write = setCode;
    return createElement(CodeBlock, { code, lang: 'python' });
  };
  await mount(createElement(Stream));
  assert.ok(await until(() => all('.code-body [style]').length > 0), 'python is coloured');
  const more = `${start} * 2\nprint(train(1))`;
  await act(async () => write(more));
  // Read again with every piece that arrives, a long reply would hold the page each time.
  assert.equal(one('.code-body')?.textContent, more);
  assert.equal(all('.code-body [style]').length, 0, 'plain while it changes');
  assert.ok(await until(() => all('.code-body [style]').length > 0), 'coloured once still');
  assert.equal(one('.code-body')?.textContent, more);
  assert.equal(highlightable('x = 1\n'.repeat(10_000)), false, 'sixty thousand characters');
});
