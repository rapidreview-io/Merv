/**
 * Machine keys, rendered. The panel reads as every list does: with no key yet the
 * empty state carries the one control, the form it opens is headed once and
 * closed by Cancel or Escape, and a key is a row whose times are times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { KeysPanel } = await import('../packages/ui/web/views/keys.js');

const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const account = {
  kind: 'user' as const,
  user: { issuer: 'https://login.example', subject: 'subject-1', createdAt: project.createdAt },
  projects: [project],
};
const key = {
  id: 'key_1',
  owner: { issuer: account.user.issuer, subject: account.user.subject },
  projectId: project.id,
  grantScope: 'project',
  label: 'Laptop runner',
  createdAt: '2026-09-10T09:00:00Z',
  expiresAt: null,
  revokedAt: null,
  previousId: null,
};
const open = async (keys: unknown[], onClose?: () => void) => {
  serve('/account/keys', { body: { keys } });
  serve('/account', { body: account });
  await mount(createElement(KeysPanel, { account, initialProjectId: project.id, onClose }));
  await settle(10);
};

test('with no key yet the empty state offers the first one, and the form is headed once', async (t) => {
  t.after(async () => await unmount());
  await open([]);
  // Under Settings the page already has its title, and an account is never named by its id.
  assert.equal(document.querySelector('h1'), null);
  assert.ok(!text().includes('subject-1'));
  const offered = document.querySelector<HTMLButtonElement>('.empty-state button')!;
  assert.equal(offered.textContent, 'New key');
  assert.ok(document.querySelector('.empty-state .empty-icon svg'));
  assert.equal(document.querySelectorAll('form').length, 0, 'the form waits to be asked for');

  await click('New key');
  assert.equal(document.querySelector('.empty-state'), null);
  const form = document.querySelector('form')!;
  assert.equal(form.querySelector('h2')!.textContent, 'New key');
  assert.equal(form.querySelector('button[type="submit"]')!.textContent, 'Create');
  const opener = document.querySelector<HTMLButtonElement>('.action-row button')!;
  assert.equal(opener.textContent, 'Cancel');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.ok(!opener.classList.contains('btn--primary'), 'Cancel is never the accent');
  assert.equal((text().match(/New key/g) ?? []).length, 1, 'the words are said once');

  await act(async () => {
    form.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  assert.equal(document.querySelector('form'), null, 'Escape means Cancel');
});

test('a key is a row: its name, how it stands, and times that are times', async (t) => {
  t.after(async () => await unmount());
  let closed = false;
  await open([key], () => (closed = true));
  // Standing alone, the panel names itself and carries its way back.
  assert.equal(document.querySelector('h1')!.textContent, 'Machine keys');
  const row = document.querySelector('.rows > .row')!;
  assert.equal(row.querySelector('strong')!.textContent, 'Laptop runner');
  assert.ok(row.querySelector('.status')!.textContent!.includes('active'));
  assert.equal(row.querySelector('time')!.getAttribute('datetime'), key.createdAt);
  assert.ok(!row.textContent!.includes('no expiration'), 'an absent fact is not drawn');
  assert.equal(document.querySelector('.action-row button')!.textContent, 'New key');
  await click('Close');
  assert.ok(closed);
});
