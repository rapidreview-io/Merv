/**
 * The experiment page's retained files, grouped by the part each plays. Every role the
 * domain writes has a group of its own; only a role it no longer writes is "other".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, settle, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { EvidenceFiles } = await import('../packages/ui/web/views/experiments.js');

const retained = (role: string, n: number) => ({
  id: `ev_${n}`,
  experimentId: 'wf_exp',
  attemptIndex: 1,
  role,
  path: `${role}.md`,
  artifactId: `art_0000000000000000000000000000000${n}`,
  hash: 'abc',
  figureIds: [],
  createdBy: 'actor_1',
  sessionId: null,
  createdAt: new Date().toISOString(),
  sequence: n,
  current: true,
});

test('a feasibility statement is its own group beside the plan, never an other retained file', async (t) => {
  t.after(async () => await unmount());
  const evidence = ['report', 'feasibility', 'plan', 'result', 'legacy'].map(retained);
  await mount(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(
      MemoryRouter,
      null,
      createElement(EvidenceFiles as any, { evidence, figures: [] }),
    ),
  );
  await settle(10);
  assert.deepEqual(
    [...document.querySelectorAll('.ev-role')].map((node) => node.textContent),
    ['plan', 'feasibility', 'result', 'report', 'other retained files'],
  );
});
