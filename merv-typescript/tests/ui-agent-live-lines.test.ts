/**
 * Cycle 11 review: a live visit whose agent has only started (Codex's `thread.started`, a quiet
 * milestone) still says Starting…
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventStream, mount, serve, settle, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
await import('../packages/ui/web/components.js');
const { AgentConversation } = await import('../packages/ui/web/views/agent-live.js');

const at = new Date().toISOString();

test('a live visit that has only started says Starting…, not nothing', async (t) => {
  t.after(async () => await unmount());
  const stream = eventStream();
  serve('/sessions/ses_c/events', { stream: stream.stream });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(AgentConversation, {
        label: 'Producer',
        visits: [
          {
            sessionId: 'ses_c',
            at: new Date(0).toISOString(),
            divider: 'Visit 1',
            stream: '/sessions/ses_c/events',
          },
        ],
      }),
    ),
  );
  stream.send('snapshot', {
    events: [{ seq: 1, at, event: { kind: 'status', id: 'status-0', text: 'Started' } }],
  });
  await settle(10);
  assert.equal(
    document.querySelector('.agent-live-state')?.textContent ?? null,
    'Starting…',
    'the page is not blank while the agent works on its first item',
  );
});
