/** A page card's Markdown shows pictures and Mermaid diagrams, and never a blank where either failed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mount, serve, settle, unmount } from './ui-render.js';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
  export async function resolve(name, context, next) {
    if (name.endsWith('.css')) return {url:'data:text/javascript,export {};',shortCircuit:true};
    return next(name,context);
  }
`),
  import.meta.url,
);
const { createElement: el } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { BoardLinkDetails, PAGE_LINK } =
  await import('../packages/ui/web/views/board-link-details.js');

const ART = 'art_0123456789abcdef0123456789abcdef';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const page = (body: string) => ({
  id: 'card',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 280,
  height: 85,
  link: PAGE_LINK,
  customData: { target: '', details: { title: 'Notes', text: body } },
});
const open = async (body: string, theme: 'light' | 'dark' = 'light', close = () => {}) =>
  mount(
    el(MemoryRouter, null, el(BoardLinkDetails, { element: page(body) as never, close, theme })),
  );
const notes = () => document.querySelector('.board-reference-notes')!;
test('a card loads authorized images and refuses unsafe sources', async (t) => {
  t.after(unmount);
  const artifact = {
    id: ART,
    projectId: 'p',
    createdBy: 'a',
    title: 'chart.png',
    mediaType: 'image/png',
    hash: 'h',
    size: PNG_BYTES.length,
    createdAt: '2026-11-18T00:00:00.000Z',
  };
  serve('/tools/artifact.get', { body: { result: artifact } });
  serve('/tools/artifact.read:content', {
    body: {
      result: {
        artifact,
        encoding: 'base64',
        content: PNG_BYTES.toString('base64'),
        offset: 0,
        total: PNG_BYTES.toString('base64').length,
      },
    },
  });
  const made: Blob[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    made.push(blob);
    return 'blob:http://localhost/chart';
  });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const png = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  await open(
    [
      `![Chart](${ART})`,
      `![dot](${png})`,
      '![js](javascript:alert(1)) ![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) ![http](http://example.com/a.png) ![local](/Users/me/chart.png)',
    ].join('\n\n'),
  );
  await settle();
  const images = [...notes().querySelectorAll('img')].map((img) => img.getAttribute('src'));
  assert.deepEqual(images, ['blob:http://localhost/chart', png]);
  assert.equal(made[0]?.type, 'image/png');
  const text = notes().querySelector('p:last-of-type')!.textContent!;
  for (const words of ['js', 'svg', 'http', 'local'])
    assert.match(text, new RegExp(`\\b${words}\\b`));
  const hrefs = [...notes().querySelectorAll('p:last-of-type a')].map((a) =>
    a.getAttribute('href'),
  );
  assert.deepEqual(
    hrefs,
    ['http://example.com/a.png'],
    'only the web address links; a path is not one here',
  );
  assert.doesNotMatch(notes().innerHTML, /javascript:|svg\+xml/);
});
