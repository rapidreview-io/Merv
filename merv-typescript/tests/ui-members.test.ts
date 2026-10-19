/**
 * Settings → Members, rendered: who the project is billed to is a fact on the page, and an
 * operator alone gets the quiet ⋯: the admin's names the others to bill, another's bills them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { PeopleView } = await import('../packages/ui/web/views/people.js');
const { setProject } = await import('../packages/ui/web/api.js');

const issuer = 'https://login.example';
const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-10-01T00:00:00.000Z' };
const member = (subject: string, role: string, signedIn = true) => ({
  id: `membership_${subject}`,
  projectId: project.id,
  issuer,
  subject,
  actorId: `actor_${subject}`,
  role,
  active: true,
  signedIn,
});
const memberships = (role: string) => [
  member('me', role),
  member('bea', 'operator'),
  member('cy', 'reader'),
  member('dee', 'operator', false),
];

async function open(role: string, admin = 'me') {
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: {
      kind: 'user',
      user: { issuer, subject: 'me', createdAt: project.createdAt },
      projects: [project],
    },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/actor.list', {
    body: {
      result: [
        { id: 'actor_me', name: 'Me Myself' },
        { id: 'actor_bea', name: 'Bea Payer' },
        { id: 'actor_cy', name: 'Cy Reader' },
        { id: 'actor_dee', name: 'Dee Invited' },
      ],
    },
  });
  serve(`/projects/${project.id}/members`, {
    body: { memberships: memberships(role), admin: { issuer, subject: admin } },
  });
  for (const path of ['/account/invitations', `/projects/${project.id}/invitations`])
    serve(path, { body: { invitations: [] } });
  setProject(project.id);
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(SessionProvider, null, createElement(PeopleView)),
    ),
  );
  await settle(20);
}

test('the page says who is billed; the admin hands billing on from ⋯, another operator takes it', async (t) => {
  t.after(async () => await unmount());
  await open('operator');
  assert.equal(document.querySelector('.billed > span')?.textContent, 'Billed to Me Myself');
  let sent: unknown;
  serve(`/projects/${project.id}/admin`, (_call, body) => {
    sent = body;
    return { body: { project } };
  });
  await click('⋯');
  const offered = [...document.querySelectorAll('.billed [role="menuitem"]')].map(
    (b) => b.textContent,
  );
  // Operators who have signed in only, the one billed now left out.
  assert.deepEqual(offered, ['Bea Payer']);
  serve(`/projects/${project.id}/members`, {
    body: { memberships: memberships('operator'), admin: { issuer, subject: 'bea' } },
  });
  await click('Bea Payer');
  await settle(20);
  assert.ok(requests.includes(`PATCH /projects/${project.id}/admin`));
  assert.deepEqual(sent, { issuer, subject: 'bea' });
  assert.equal(document.querySelector('.billed > span')?.textContent, 'Billed to Bea Payer');
  // No longer the admin, an operator can only take billing back on.
  await click('⋯');
  assert.deepEqual(
    [...document.querySelectorAll('.billed [role="menuitem"]')].map((b) => b.textContent),
    ['Bill me'],
  );
  await click('Bill me');
  assert.deepEqual(sent, { issuer, subject: 'me' });
});

test('a member who is not an operator reads the fact with no control', async (t) => {
  t.after(async () => await unmount());
  await open('reader', 'bea');
  assert.match(text(), /Billed to/);
  assert.equal(document.querySelector('.billed .file-menu'), null);
});
