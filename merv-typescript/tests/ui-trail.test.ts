import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, settle, unmount } from './ui-render.js';

const { createElement: h, useEffect } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter, Link, Route, Routes } = await import('react-router-dom');
const { BackLink, useTrail } = await import('../packages/ui/web/trail.js');

/** A place that titles the tab as the shell does, from its own name. */
function Page({ title, children }: { title: string; children?: unknown }) {
  useEffect(() => {
    document.title = `${title} · Project · Merv`;
  }, [title]);
  return h('main', null, children as never);
}
/** Work, which links to a file, the file with its way back, and Files. */
function Pages() {
  useTrail();
  return h(
    Routes,
    null,
    h(Route, {
      path: '/work',
      element: h(Page, { title: 'Work' }, h(Link, { to: '/files/a' }, 'Open file')),
    }),
    h(Route, {
      path: '/files/a',
      element: h(Page, { title: 'A file' }, h(BackLink, { home: '/files', label: 'Files' })),
    }),
    h(Route, { path: '/files', element: h(Page, { title: 'Files' }, 'the list') }),
  );
}
const backLink = () => document.querySelector<HTMLAnchorElement>('.back-link')!;

test('the way back names the page the reader came from and returns to it', async (t) => {
  t.after(async () => {
    await unmount();
    sessionStorage.clear();
  });
  sessionStorage.clear();
  await mount(h(MemoryRouter, { initialEntries: ['/work'] }, h(Pages)));
  await settle(10);
  await act(async () => document.querySelector<HTMLAnchorElement>('a')!.click());
  await settle(10);
  assert.equal(backLink().textContent, '← Work');
  await act(async () =>
    backLink().dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 })),
  );
  await settle(10);
  assert.equal(document.title.split(' · ')[0], 'Work');
});

test('a page opened cold goes back to the place it belongs to', async (t) => {
  t.after(async () => {
    await unmount();
    sessionStorage.clear();
  });
  sessionStorage.clear();
  await mount(h(MemoryRouter, { initialEntries: ['/files/a'] }, h(Pages)));
  await settle(10);
  assert.equal(backLink().textContent, '← Files');
  assert.equal(backLink().getAttribute('href'), '/files');
});
