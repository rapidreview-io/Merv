import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, text, unmount, settle } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom');
const { Integrations } = await import('../packages/ui/web/views/settings.js');
const { SandboxesView } = await import('../packages/ui/web/views/sandboxes.js');
const { SandboxesNav } = await import('../packages/ui/web/shell.js');
const { setProject } = await import('../packages/ui/web/api.js');
const row = {
  id: 'sandboxes',
  label: 'Sandboxes',
  group: 'operations',
  order: 40,
  path: '/sandboxes',
  rooms: true,
  view: { kind: 'sandboxes' },
  status: {},
  readable: false,
};
const props = { row, shell: { rows: [row], plugins: [] } } as never;
function Route() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    'div',
    null,
    createElement('output', null, location.pathname + location.search),
    createElement('button', { onClick: () => navigate(-1) }, 'Back'),
    createElement('button', { onClick: () => navigate(1) }, 'Forward'),
  );
}
const frame = () => document.querySelector('iframe')!;
const children = () => document.querySelector<HTMLElement>('.sandboxes-nav-children')!;
const minted: string[] = [];
function sessions() {
  minted.length = 0;
  serve('/sandboxes/console-session', (n, input) => {
    minted.push(String(input.path));
    return {
      body: {
        url: `/sbx/ui/#code=code_${n}`,
      },
    };
  });
}
async function open(path = '/sandboxes') {
  sessions();
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(SandboxesNav, { row }),
      createElement(SandboxesView, props),
      createElement(Route),
    ),
  );
}
async function link(path: string) {
  await act(async () => document.querySelector<HTMLAnchorElement>(`a[href="${path}"]`)!.click());
  await settle(0);
}
async function message(
  data: object,
  origin = window.location.origin,
  source = frame().contentWindow,
) {
  await act(async () =>
    window.dispatchEvent(new window.MessageEvent('message', { data, origin, source })),
  );
}

test('Integrations has no old compute connection flow', async (t) => {
  t.after(unmount);
  await mount(createElement(Integrations, props));
  assert.match(text(), /No integrations/);
  assert.equal(requests.length, 0);
});

for (const [route, console] of [
  ['', '/ui/'],
  ['/machines', '/ui/machines'],
  ['/jobs', '/ui/jobs'],
  ['/spend', '/ui/spend'],
]) {
  test(`Sandboxes deep link ${route || 'home'} opens the embedded console`, async (t) => {
    t.after(unmount);
    await open(`/sandboxes${route}`);
    assert.deepEqual(minted, [console]);
    assert.equal(frame().getAttribute('src'), `/sbx${console}#code=code_1`);
    assert.equal(requests.filter((r) => r.includes('ui.read')).length, 0);
    assert.deepEqual(
      [...children().querySelectorAll('a')].map((a) => a.textContent),
      ['Machines', 'Jobs', 'Spend'],
    );
  });
}

test('children remain while active and parent opens home', async (t) => {
  t.after(unmount);
  await open();
  assert.ok(document.querySelector('.sandboxes-nav.open'));
  assert.equal(children().querySelectorAll('a').length, 3);
  await link('/sandboxes/machines');
  assert.ok(document.querySelector('.sandboxes-nav.open'));
  assert.ok(children().querySelector('a[href="/sandboxes/machines"].active'));
  assert.equal(frame().getAttribute('src'), '/sbx/ui/machines#code=code_2');
  assert.equal(minted.length, 2);
  await link('/sandboxes');
  assert.ok(document.querySelector('.sandboxes-nav.open'));
  assert.equal(frame().getAttribute('src'), '/sbx/ui/#code=code_3');
  assert.equal(document.querySelector('output')!.textContent, '/sandboxes');
  assert.equal(minted.length, 3);
});

test('only the console window and origin can navigate; paths and heights are validated', async (t) => {
  t.after(unmount);
  await open('/sandboxes/jobs');
  for (const [path, origin, source] of [
    ['/sbx/ui/machines', 'https://elsewhere.example', frame().contentWindow],
    ['/sbx/ui/machines', window.location.origin, window],
    ['//elsewhere.example', window.location.origin, frame().contentWindow],
    ['/sbx/ui/../mcp', window.location.origin, frame().contentWindow],
    ['/sbx/ui/%2e%2e/mcp', window.location.origin, frame().contentWindow],
    ['/sbx/ui/\\evil', window.location.origin, frame().contentWindow],
  ] as const)
    await message({ type: 'sandboxes:navigate', path }, origin, source);
  assert.equal(document.querySelector('output')!.textContent, '/sandboxes/jobs');
  await message({ type: 'sandboxes:height', height: 100000 });
  assert.equal(frame().style.height, '700px');
  await message({ type: 'sandboxes:height', height: 900 });
  assert.equal(frame().style.height, '900px');
  await link('/sandboxes/machines');
  await link('/sandboxes/jobs');
  const src = frame().getAttribute('src');
  await message({ type: 'sandboxes:navigate', path: '/sbx/ui/machines/sbx_a?tab=terminal' });
  assert.equal(
    document.querySelector('output')!.textContent,
    '/sandboxes/machines/sbx_a?tab=terminal',
  );
  assert.equal(frame().getAttribute('src'), src, 'console navigation does not reload the frame');
  const navigated = frame();
  await click('Back');
  assert.notEqual(
    frame(),
    navigated,
    'Back reloads even when the src attribute still names the old page',
  );
  assert.equal(frame().getAttribute('src'), '/sbx/ui/jobs#code=code_4');
  assert.equal(minted.length, 4);
  await click('Forward');
  assert.equal(frame().getAttribute('src'), '/sbx/ui/machines/sbx_a?tab=terminal#code=code_5');
  assert.equal(minted.length, 5);
});

test('project changes remount the frame and Reload renews without another sign-in', async (t) => {
  t.after(unmount);
  await open('/sandboxes/spend');
  const first = frame();
  await act(async () => setProject('project-next'));
  assert.notEqual(frame(), first);
  assert.deepEqual(minted, ['/ui/spend', '/ui/spend']);
  await click('Reload');
  assert.equal(frame().getAttribute('src'), '/sbx/ui/spend#code=code_3');
  assert.equal(requests.filter((r) => !r.endsWith('/sandboxes/console-session')).length, 0);
});
