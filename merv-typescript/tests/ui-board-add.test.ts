import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
await import('../packages/ui/web/components.js');
const { CardPicker, asksToAdd } = await import('../packages/ui/web/views/board-add.js');
const { cameraFor, inView, landing, overlaps } =
  await import('../packages/ui/web/views/board-place.js');
const { statusLine } = await import('../packages/ui/web/views/board-talk.js');

const view = { x: 0, y: 0, width: 1000, height: 800 };
const card = { width: 280, height: 110 };

test('the view follows by the least move, and zooms out only when it must', () => {
  const clear = { x: 16, y: 72, width: 968, height: 668 };
  const now = { scrollX: 0, scrollY: 0, zoom: 1 };
  // In sight, it does not move at all.
  assert.deepEqual(cameraFor({ x: 100, y: 200, width: 100, height: 100 }, clear, now), now);
  // Past the right edge, it pans just far enough, keeping the zoom.
  assert.deepEqual(cameraFor({ x: 2000, y: 200, width: 100, height: 100 }, clear, now), {
    zoom: 1,
    scrollX: 16 + 968 - 2100 - 48,
    scrollY: 0,
  });
  // Under the toolbar, it pans down clear of it.
  assert.equal(cameraFor({ x: 100, y: 0, width: 100, height: 100 }, clear, now).scrollY, 72 + 48);
  // Too large to fit, it zooms out and centres; it never zooms in.
  const big = cameraFor({ x: 0, y: 0, width: 3000, height: 200 }, clear, now);
  assert.ok(big.zoom < 1);
  assert.equal(Math.round((1500 + big.scrollX) * big.zoom), 16 + 484);
  const far = { scrollX: 0, scrollY: 0, zoom: 0.5 };
  assert.equal(cameraFor({ x: 0, y: 200, width: 10, height: 10 }, clear, far).zoom, 0.5);
});

test('the line says who is doing what, while it is happening and only then', () => {
  const idle = { waiting: 0, playing: false, thinking: false };
  assert.equal(statusLine(idle), null);
  assert.equal(statusLine({ ...idle, name: 'Pi', drewMs: 60_000 }), null);
  assert.equal(statusLine({ ...idle, name: 'Pi', drewMs: 3_200 }), 'Pi drew 3 s ago');
  assert.equal(statusLine({ ...idle, name: 'Pi', drewMs: 200 }), 'Pi is drawing');
  assert.equal(statusLine({ ...idle, name: 'Pi', playing: true }), 'Pi is drawing');
  assert.equal(statusLine({ ...idle, name: 'Pi', waiting: 4 }), '4 waiting from Pi');
  assert.equal(statusLine({ ...idle, waiting: 4 }), '4 waiting');
  assert.equal(statusLine({ ...idle, looking: 'Worker' }), 'Worker is looking');
  assert.equal(statusLine({ ...idle, thinking: true }), 'Pi is thinking');
  // What a person draws, with no agent heard of, is nobody's to announce.
  assert.equal(statusLine({ ...idle, playing: true }), null);
});

test('what is added lands in the middle of the view with nothing chosen', () => {
  assert.deepEqual(landing(card, [], undefined, view), [360, 345]);
});

test('what is added lands to the right of what is chosen, level with its top', () => {
  const chosen = { x: 100, y: 50, width: 200, height: 100 };
  assert.deepEqual(landing(card, [chosen], chosen, view), [340, 50]);
});

test('a taken place sends what is added to the first free place below it', () => {
  const taken = { x: 300, y: 300, width: 400, height: 200 };
  const [x, y] = landing(card, [taken], undefined, view);
  assert.equal(x, 360);
  assert.ok(y >= taken.y + taken.height, `${y} is below what stands there`);
  assert.ok(!overlaps(taken, { x, y, ...card }));
});

test('a place of its own does not count as the place being tried', () => {
  // A shape already drawn is placed again by its true size, which comes with where it stands.
  const standing = { x: 340, y: 300, width: 320, height: 300 };
  const drawn = { x: 340, y: 300, width: 320, height: 300 };
  const [x, y] = landing(drawn, [standing], undefined, view);
  assert.ok(!overlaps(standing, { ...drawn, x, y }), `${x},${y} is clear of what stands there`);
});

test('with nowhere free the first place is taken, rather than one far off', () => {
  const huge = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };
  assert.deepEqual(landing(card, [huge], undefined, view), [360, 345]);
});

test('a long column of what stands there is walked past, not landed on', () => {
  const column = Array.from({ length: 30 }, (_, row) => ({ ...card, x: 360, y: 345 + row * 150 }));
  const [x, y] = landing(card, column, undefined, view);
  assert.ok(!column.some((rect) => overlaps(rect, { ...card, x, y })), `${x},${y}`);
});

test('whether a place is in view', () => {
  assert.ok(inView({ x: 10, y: 10, width: 100, height: 100 }, view));
  assert.ok(!inView({ x: 950, y: 10, width: 100, height: 100 }, view));
});

test('the panel is asked for by ⌘K or Ctrl+K alone', () => {
  const press = (key: string, more = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...more,
  });
  assert.ok(asksToAdd(press('k', { metaKey: true })));
  assert.ok(asksToAdd(press('k', { ctrlKey: true })));
  assert.ok(asksToAdd(press('K', { metaKey: true })), 'caps lock');
  assert.ok(!asksToAdd(press('k')), 'K alone is the laser');
  assert.ok(!asksToAdd(press('k', { metaKey: true, shiftKey: true })));
  assert.ok(!asksToAdd(press('k', { ctrlKey: true, altKey: true })));
  assert.ok(!asksToAdd(press('j', { metaKey: true })));
});

const file = (id: string, title: string, mediaType: string, createdAt: string) => ({
  id,
  title,
  mediaType,
  createdAt,
  size: 2048,
  hash: 'x',
  projectId: 'p',
  createdBy: 'a',
});
const FILES = [
  file('art_png', 'Figure.png', 'image/png', '2026-10-30T00:00:00Z'),
  file('art_jpg', 'Photo.jpg', 'image/jpeg', '2026-10-29T00:00:00Z'),
  file('art_webp', 'Plot.webp', 'image/webp', '2026-10-28T00:00:00Z'),
  file('art_gif', 'Moving.gif', 'image/gif', '2026-10-27T00:00:00Z'),
  file('art_svg', 'Vector.svg', 'image/svg+xml', '2026-10-26T00:00:00Z'),
  file('art_md', 'Notes.md', 'text/markdown', '2026-10-25T00:00:00Z'),
];
const flow = (state: string, updatedAt: string) => ({ state, updatedAt });
const HOME = {
  tasks: [
    {
      id: 'task_old',
      title: 'An older task',
      workflow: flow('in_progress', '2026-10-01T00:00:00Z'),
    },
    {
      id: 'task_merge',
      title: 'Merge ‘a’ into ‘b’',
      workflow: flow('in_progress', '2026-10-31T00:00:00Z'),
    },
  ],
  experiments: [
    { id: 'exp_new', name: 'A newer run', workflow: flow('running', '2026-10-20T00:00:00Z') },
  ],
};
const cited = (over: Record<string, unknown>) => ({
  id: 'cite',
  title: 'A paper',
  identifier: 'arxiv:2303.08774',
  url: null,
  year: 2023,
  updatedAt: '2026-10-10T00:00:00Z',
  ...over,
});
function servePanel() {
  serve('/tools/board.read', {
    body: {
      result: {
        boards: [
          { id: 'board_me', title: 'This board', updatedAt: '2026-10-31T00:00:00Z' },
          { id: 'board_x', title: 'Older board', updatedAt: '2026-10-29T12:00:00Z' },
        ],
      },
    },
  });
  serve('/tools/artifact.read:list', { body: { result: FILES } });
  serve('/tools/ui.home', { body: { result: HOME } });
  serve('/tools/paper.read', {
    body: {
      result: {
        citations: [
          cited({ title: 'By arXiv id' }),
          cited({
            id: 'c2',
            title: 'By doi',
            identifier: 'doi:10.1/x',
            updatedAt: '2026-09-01T00:00:00Z',
          }),
          cited({
            id: 'c3',
            title: 'With a url',
            identifier: 'x:1',
            url: 'https://example.org/p',
            updatedAt: '2026-08-01T00:00:00Z',
          }),
          cited({ id: 'c4', title: 'Nowhere to open', identifier: 'x:2' }),
        ],
      },
    },
  });
}
async function openPanel(t: TestContext) {
  t.after(unmount);
  servePanel();
  const added: unknown[][] = [];
  const closed: boolean[] = [];
  await mount(
    createElement(CardPicker, {
      board: 'board_me',
      close: () => closed.push(true),
      add: (items: unknown[]) => added.push(items),
    }),
  );
  await settle();
  return { added, closed };
}
const panel = () => document.querySelector<HTMLElement>('.board-add-panel')!;
const names = () =>
  [...document.querySelectorAll('[role=option] .finder-name')].map((name) => name.textContent);
const key = async (key: string, target: Element = document.activeElement ?? panel()) =>
  await act(async () =>
    target.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    ),
  );

test('the panel lists what is most recent first, and an image the board can show is a picture', async (t) => {
  const { added, closed } = await openPanel(t);
  assert.deepEqual(names(), ['Older board'], 'not the board itself');
  await click('Collection');
  assert.deepEqual(
    names().slice(0, 3),
    ['Figure.png', 'Older board', 'Photo.jpg'],
    'merged by time',
  );
  await click('Files');
  assert.deepEqual(
    names(),
    FILES.map((f) => f.title),
  );
  await act(async () => document.querySelectorAll<HTMLElement>('[role=option]')[0]!.click());
  assert.equal(closed.length, 1);
  assert.deepEqual(
    (added[0] as { target: string; picture?: boolean }[]).map(({ target, picture }) => [
      target,
      picture,
    ]),
    [['art_png', true]],
  );
});

for (const [title, target, picture] of [
  ['Photo.jpg', 'art_jpg', true],
  ['Plot.webp', 'art_webp', true],
  ['Moving.gif', 'art_gif', undefined],
  ['Vector.svg', 'art_svg', undefined],
  ['Notes.md', 'art_md', undefined],
] as const)
  test(`${title} is added as a ${picture ? 'picture' : 'card'}`, async (t) => {
    const { added } = await openPanel(t);
    await click('Files');
    const row = [...document.querySelectorAll<HTMLElement>('[role=option]')].find((one) =>
      one.textContent!.includes(title),
    )!;
    await act(async () => row.click());
    const [item] = added[0] as { target: string; picture?: boolean; fact: string }[];
    assert.equal(item!.target, target);
    assert.equal(item!.picture, picture);
    assert.ok(item!.fact, 'with its one fact');
  });

test('keys walk the panel and none of them reach Excalidraw', async (t) => {
  const { added } = await openPanel(t);
  const heard: string[] = [];
  const listen = (event: KeyboardEvent) => heard.push(event.key);
  document.addEventListener('keydown', listen);
  t.after(() => document.removeEventListener('keydown', listen));
  assert.equal(document.activeElement, panel(), 'the panel takes the keys as it opens');
  await click('Boards');
  await key('ArrowRight');
  assert.equal(
    document.querySelector('.tabs [aria-pressed=true]')!.childNodes[0]!.textContent,
    'Files',
  );
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowUp');
  assert.equal(
    document.querySelector('[role=option][aria-selected=true] .finder-name')!.textContent,
    'Photo.jpg',
  );
  await key('Delete');
  assert.deepEqual(heard, [], 'nothing on the board is moved or erased by them');
  await key('Enter');
  assert.equal((added[0] as { target: string }[])[0]!.target, 'art_jpg');
});

test('an arrow from a tab takes the focus to the list, so Enter adds', async (t) => {
  const { added } = await openPanel(t);
  await click('Boards');
  const tab = document.querySelector<HTMLElement>('.tabs button')!;
  tab.focus();
  await key('ArrowDown');
  assert.equal(document.activeElement?.getAttribute('role'), 'listbox');
  await key('Enter');
  assert.equal((added[0] as { target: string }[])[0]!.target, 'board_x');
});

test('Escape shuts the panel and is not also heard by the board', async (t) => {
  const { closed } = await openPanel(t);
  const heard: string[] = [];
  const listen = (event: KeyboardEvent) => heard.push(event.key);
  document.addEventListener('keydown', listen);
  t.after(() => document.removeEventListener('keydown', listen));
  await key('Escape');
  assert.equal(closed.length, 1);
  assert.deepEqual(heard, []);
});

test('Records lists tasks, experiments and papers as what a card can open', async (t) => {
  const { added } = await openPanel(t);
  const asked = requests.filter((request) => request.includes('paper.read')).length;
  assert.equal(asked, 0, 'the paper is read only on the tab that lists it');
  await click('Records');
  await settle();
  assert.deepEqual(names(), [
    'A newer run',
    'By arXiv id',
    'An older task',
    'By doi',
    'With a url',
  ]);
  const pick = async (title: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('[role=option]')].find((one) =>
      one.textContent!.includes(title),
    )!;
    await act(async () => row.click());
    return (added.at(-1) as { target: string; fact: string }[])[0]!;
  };
  assert.deepEqual(await pick('A newer run').then(({ target, fact }) => [target, fact]), [
    'exp_new',
    'Experiment',
  ]);
  assert.equal((await pick('By arXiv id')).target, 'https://arxiv.org/abs/2303.08774');
  assert.equal((await pick('By doi')).target, 'https://doi.org/10.1/x');
  assert.equal((await pick('With a url')).target, 'https://example.org/p');
  assert.equal((await pick('An older task')).fact, 'Task');
});

const choose = async (...files: File[]) => {
  const input = document.querySelector<HTMLInputElement>('.board-add-upload input')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle();
};

test('uploading saves to Files and adds each file as what it is', async (t) => {
  const { added, closed } = await openPanel(t);
  serve('/tools/artifact.write:create', (_call, sent) => ({
    body: {
      result: file(
        `art_${sent.title}`,
        String(sent.title),
        String(sent.mediaType),
        '2026-10-31T00:00:00Z',
      ),
    },
  }));
  await click('Files');
  await choose(
    new File(['png'], 'new.png', { type: 'image/png' }),
    new File(['text'], 'new.md', { type: 'text/markdown' }),
  );
  assert.equal(closed.length, 1, 'the panel closes');
  assert.deepEqual(
    (added[0] as { target: string; picture?: boolean }[]).map(({ target, picture }) => [
      target,
      picture,
    ]),
    [
      ['art_new.png', true],
      ['art_new.md', undefined],
    ],
    'in one go',
  );
});

test('an upload refused says which and why, adds what was kept, and stays open', async (t) => {
  const { added, closed } = await openPanel(t);
  serve('/tools/artifact.write:create', (_call, sent) =>
    sent.title === 'bad.txt'
      ? { status: 500, body: { error: { code: 'boom', message: 'Storage said no' } } }
      : { body: { result: file('art_ok', 'ok.txt', 'text/plain', '2026-10-31T00:00:00Z') } },
  );
  await click('Files');
  await choose(
    new File(['x'], 'bad.txt', { type: 'text/plain' }),
    new File([], 'empty.txt', { type: 'text/plain' }),
    new File(['y'], 'ok.txt', { type: 'text/plain' }),
  );
  assert.ok(text().includes('bad.txt: Storage said no'), text());
  assert.ok(text().includes('empty.txt: This file is empty'), text());
  assert.equal(closed.length, 0);
  assert.deepEqual(
    (added[0] as { target: string }[]).map(({ target }) => target),
    ['art_ok'],
  );
  await click('Back');
  assert.ok(document.querySelector('[role=listbox]'), 'and the list is back');
});

test('a large file with no project storage is refused before anything is sent', async (t) => {
  const { added } = await openPanel(t);
  serve('/tools/artifact.read:storage', { body: { result: { available: false } } });
  await click('Files');
  await choose(new File([new Uint8Array(2_000_001)], 'large.bin'));
  assert.ok(text().includes('large.bin: Files over 2 MB need project storage'), text());
  assert.ok(!requests.some((request) => request.includes('artifact.write')));
  assert.equal(added.length, 0);
});

test('a large upload goes to storage, says how far it is, and stops with the panel', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  });
  const sent: { aborted: boolean }[] = [];
  class StorageRequest {
    aborted = false;
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    send(file: File) {
      sent.push(this);
      this.upload.onprogress?.({ loaded: file.size / 2 });
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: StorageRequest,
  });
  const { added } = await openPanel(t);
  serve('/tools/artifact.read:storage', { body: { result: { available: true } } });
  serve('/tools/artifact.write:upload_begin', {
    body: { result: { uploadId: 'up', parts: [{ url: 'https://storage.test/x', headers: {} }] } },
  });
  await click('Files');
  await choose(new File([new Uint8Array(2_000_001)], 'large.bin'));
  await settle(20);
  assert.ok(/Uploading large\.bin 5\d%/.test(text()), text());
  await unmount();
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.aborted, 'the bytes stop');
  await settle();
  assert.equal(added.length, 0, 'and nothing is added');
});
