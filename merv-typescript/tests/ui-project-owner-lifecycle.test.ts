import { mount, unmount, settle, text } from './ui-render.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { createElement: el, useContext, useEffect, useState, act } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { SessionProvider, SessionContext } = await import('../packages/ui/web/session.js');
const { setToken, setProject, accountRequest, call, projectSelection } =
  await import('../packages/ui/web/api.js');
const { deferred } = await import('./fixtures/deferred.js');

test('real Session lifecycle pins cleanup to A through chooser, B and reopened A', async (t) => {
  setToken('fixture');
  setProject('a');
  t.after(async () => {
    await unmount();
    setToken(null);
  });
  const projects = ['a', 'b'].map((id) => ({
    id,
    name: `Project ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
  }));
  const writes: string[] = [],
    instances: {
      owner: NonNullable<React.ContextType<typeof SessionContext>>['owner'];
      flush: () => Promise<void>;
    }[] = [];
  const release = deferred<void>();
  const completions: Promise<void>[] = [];
  let active: React.ContextType<typeof SessionContext>;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const path = String(input),
      project = new Headers(init?.headers).get('x-merv-project-id');
    if (path === '/auth/config') return Response.json({ enabled: false });
    if (path === '/account')
      return Response.json({
        kind: 'user',
        user: { id: 'user', email: 'user@example.com' },
        projects,
      });
    if (path === '/account/invitations') return Response.json({ invitations: [] });
    if (path === '/tools/ui.shell')
      return Response.json({
        result: {
          project: projects.find((p) => p.id === project),
          actor: {
            id: `actor-${project}`,
            projectId: project,
            name: 'User',
            role: 'operator',
            active: true,
          },
          rows: [],
          plugins: [],
        },
      });
    if (path === '/board-images/image' || path === '/tools/board.save') {
      writes.push(`${path}:${project}`);
      return Response.json({ result: {} });
    }
    return Response.json({ error: { code: 'fixture', message: path } }, { status: 404 });
  });
  function CanvasLifecycleProbe() {
    const session = useContext(SessionContext)!;
    active = session;
    const [owner] = useState(() => session.owner);
    const [saved, setSaved] = useState(false);
    useEffect(() => {
      const flush = async () => {
        await release.promise;
        await accountRequest('/board-images/image', {
          method: 'PUT',
          raw: new Uint8Array([1]),
          owner,
        });
        await call('board.save', { id: `board-${owner?.project}` }, owner);
        setSaved(true);
      };
      instances.push({ owner, flush });
      return () => {
        completions.push(flush());
      };
    }, [owner]);
    return el('p', null, `${owner?.project}:${saved ? 'saved' : 'unsaved'}`);
  }
  await mount(
    el(
      MemoryRouter,
      null,
      el(
        SessionProvider,
        {
          Anonymous: () => null,
          Chooser: ({ account, choose }: any) =>
            el(
              'div',
              null,
              ...account.projects.map((p: any) =>
                el('button', { key: p.id, onClick: () => choose(p.id) }, p.name),
              ),
            ),
        },
        el(CanvasLifecycleProbe),
      ),
    ),
  );
  await settle(15);
  assert.equal(text(), 'a:unsaved');
  assert.ok(instances[0]!.owner);
  await act(async () => active!.chooseProject());
  await settle(10);
  assert.equal(projectSelection(), null);
  assert.equal(completions.length, 1);
  // The chooser callback uses SessionProvider.choose and reload.
  const choose = async (name: string) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(name),
    );
    assert.ok(button, text());
    await act(async () => button.click());
    await settle(10);
  };
  await choose('Project b');
  assert.equal(text(), 'b:unsaved');
  await act(async () => {
    release.resolve();
    await Promise.all(completions);
  });
  assert.deepEqual(writes, ['/board-images/image:a', '/tools/board.save:a']);
  assert.equal(text(), 'b:unsaved', 'late old completion cannot update the new instance');
  await act(async () => active!.chooseProject());
  await settle(10);
  await choose('Project a');
  assert.equal(text(), 'a:unsaved');
  assert.notEqual(instances[0]!.owner, instances[2]!.owner);
  await act(async () => {
    await instances[0]!.flush();
  });
  assert.equal(text(), 'a:unsaved');
  const count = instances.length;
  await act(async () => setToken('refreshed', { refresh: true }));
  await settle(5);
  assert.equal(instances.length, count, 'same-identity refresh does not replace rendered owner');
  await act(async () => {
    await Promise.all(completions);
    await unmount();
  });
  await Promise.all(completions);
});
