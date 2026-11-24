/** A PDF's card on the board opens the full-size reader at once; other files keep their small preview. */
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
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { BoardLinkDetails } = await import('../packages/ui/web/views/board-link-details.js');

const card = (artifactId: string) => ({
  id: 'card',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 300,
  height: 100,
  link: `merv:${artifactId}`,
  customData: { details: { artifactId } },
});
const file = (id: string, mediaType: string, title: string) => ({
  id,
  projectId: 'p',
  createdBy: 'a',
  title,
  mediaType,
  hash: 'h',
  size: 3_000_000,
  createdAt: '2026-11-16T00:00:00.000Z',
});
const escape = () =>
  act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });

test('a PDF card opens the reader in full, and leaving the reader closes the card', async (t) => {
  t.after(unmount);
  serve('/tools/artifact.read:get', {
    body: { result: file('art_pdf', 'application/pdf', 'Brief.pdf') },
  });
  let closed = 0;
  await mount(
    el(
      MemoryRouter,
      null,
      el(BoardLinkDetails, {
        element: card('art_pdf') as never,
        close: () => {
          closed++;
        },
        theme: 'dark',
      }),
    ),
  );
  await settle(80);
  const dialog = document.querySelector('.board-reference-overlay > .board-link-details');
  assert.ok(dialog, 'the reader is over the board without a press on "Read in full"');
  assert.match(dialog.className, /is-expanded is-fullscreen/);
  assert.equal(dialog.getAttribute('role'), 'dialog');
  await escape();
  assert.equal(closed, 1, 'Escape leaves the card: there is no small preview to fall back to');
});
