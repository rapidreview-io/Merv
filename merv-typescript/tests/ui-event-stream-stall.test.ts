/**
 * Cycle 11 review: the stall watch says "slow to connect" only of a stream that has not yet
 * spoken. A stream the server refused, or one reopened (tab shown again) from the last event
 * held while its agent is quiet, is not slow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventStream, jump, mount, serve, settle, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { AgentConversation } = await import('../packages/ui/web/views/agent-live.js');
const { STALL_MS } = await import('../packages/ui/web/event-stream.js');

const at = new Date().toISOString();
const visit = (id: string) => ({
  sessionId: id,
  at: new Date(0).toISOString(),
  divider: 'Visit 1',
  stream: `/sessions/${id}/events`,
});
const view = (id: string) =>
  createElement(
    MemoryRouter,
    null,
    createElement(AgentConversation, { label: 'Producer', visits: [visit(id)] }),
  );
const state = () => document.querySelector('.agent-live-state')?.textContent ?? null;

test('a refused live view stays refused past the stall wait', async (t) => {
  t.after(async () => await unmount());
  serve('/sessions/ses_gone/events', { status: 403, body: { error: { code: 'forbidden' } } });
  await mount(view('ses_gone'));
  await settle(20);
  assert.equal(state(), 'The live view isn’t available.Retry');
  await jump(STALL_MS);
  assert.equal(state(), 'The live view isn’t available.Retry');
});

test('a stream reopened from the last event it holds is not slow while its agent is quiet', async (t) => {
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  t.after(async () => {
    delete (document as { visibilityState?: unknown }).visibilityState;
    await unmount();
  });
  const first = eventStream();
  const again = eventStream();
  serve('/sessions/ses_q/events', { stream: first.stream });
  serve('/sessions/ses_q/events?after=1', { stream: again.stream });
  await mount(view('ses_q'));
  first.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'Running.', done: true } }],
  });
  await settle(10);
  assert.equal(state(), null);
  const flip = async (value: boolean) => {
    hidden = value;
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await settle(10);
  };
  await flip(true);
  await flip(false);
  // The reopened stream is open; the agent is in a long tool call and says nothing.
  await jump(STALL_MS);
  assert.equal(state(), null, 'a quiet agent on an open stream is not a slow connection');
});

test('a stream refused for a credential that expired opens again once, with the renewed one', async (t) => {
  const { setToken, setTokenRefresher } = await import('../packages/ui/web/api.js');
  setToken('expired');
  let renewals = 0;
  const forget = setTokenRefresher(
    async () => (renewals++, setToken('renewed', { refresh: true }), 'renewed'),
  );
  t.after(async () => {
    forget();
    setToken(null);
    await unmount();
  });
  const live = eventStream();
  serve('/sessions/ses_r/events', (call) =>
    call === 1
      ? { status: 401, body: { error: { code: 'unauthorized' } } }
      : { stream: live.stream },
  );
  await mount(view('ses_r'));
  live.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'text', id: 'a', delta: 'Back again.', done: true } }],
  });
  await settle(20);
  assert.equal(state(), null, 'the live view is open, not refused');
  assert.ok(document.body.textContent?.includes('Back again.'), 'what the agent said is drawn');
  await unmount();
  // A credential still refused once renewed is refused for good: one renewal, never a loop.
  serve('/sessions/ses_x/events', { status: 401, body: { error: { code: 'unauthorized' } } });
  await mount(view('ses_x'));
  await settle(20);
  assert.equal(state(), 'The live view isn’t available.Retry');
  assert.equal(renewals, 2, 'one renewal for each refused stream');
});
