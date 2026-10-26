import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, serve, settle, text, unmount, click, requests } from './ui-render.js';
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { MetricsView } = await import('../packages/ui/web/views/metrics.js');
const { UnitView } = await import('../packages/ui/web/views/unit.js');
const { railSections } = await import('../packages/ui/web/navigation.js');
const metricRow = {
  id: 'metrics',
  label: 'Metrics',
  group: 'hidden',
  order: 34,
  path: '/metrics',
  view: { kind: 'metrics' },
  status: {},
  readable: true,
};
const experimentRow = {
  id: 'experiments',
  label: 'Experiments',
  group: 'hidden',
  order: 20,
  path: '/experiments',
  workflow: 'experiment',
  view: { kind: 'experiments' },
  status: {},
  readable: true,
};
const graph = {
  instanceId: 'experiment',
  workflow: 'experiment',
  version: 46,
  revision: 1,
  state: 'running',
  currentGate: '',
  terminal: false,
  nodes: [],
  edges: [],
  dependencies: [],
};
const session = { url: '/trackio/?project=project&hide_empty_tabs=true&run_ids=one', runs: 1 };
const chart = {
  metrics: ['train/loss'],
  runs: [
    {
      id: 'one',
      run: 'lr-3e-3',
      experimentId: 'experiment',
      experiment: 'decay-sweep',
      attempt: 2,
      state: 'running',
      color: '#2563eb',
      metrics: {
        'train/loss': [
          [0, 2],
          [10, 1],
        ],
      },
    },
    {
      id: 'two',
      run: 'lr-1e-3',
      experimentId: 'experiment',
      experiment: 'decay-sweep',
      attempt: 1,
      state: 'running',
      muted: true,
      color: '#0f766e',
      metrics: {
        'train/loss': [
          [0, 2.5],
          [10, 1.5],
        ],
      },
    },
  ],
  marks: [{ run: 'one', step: 5, at: '2026-10-26T00:00:05Z', label: 'Message: <b>lower</b>' }],
  live: false,
};
function setup(enabled = true, runs = 1) {
  serve('/tools/ui.shell', {
    body: { result: { rows: enabled ? [metricRow, experimentRow] : [], workflows: [] } },
  });
  serve('/sessions/threads?instanceId=experiment', { body: { threads: [] } });
  serve('/metrics/session', { body: { ...session, runs } });
  serve('/tools/metrics.chart', { body: { result: chart } });
}
const unit = () =>
  createElement(
    MemoryRouter,
    null,
    createElement(UnitView, {
      unit: {},
      graph,
      kind: 'Experiment',
      title: 'Training',
      wide: true,
    }),
  );
test('Metrics is reachable without adding a rail row', () => {
  assert.equal(railSections([metricRow]).flatMap((section) => section.rows).length, 0);
});
test('experiment Metrics tab exists only with the plugin and runs, drawn by Merv', async () => {
  for (const [enabled, runs] of [
    [false, 1],
    [true, 0],
    [true, 1],
  ] as const) {
    setup(enabled, runs);
    await mount(unit());
    await settle();
    const shown = enabled && runs > 0;
    assert.equal(
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'Metrics'),
      shown,
    );
    if (shown) {
      await click('Metrics');
      await settle();
      assert.equal(document.querySelector('iframe'), null);
      assert.equal(document.querySelectorAll('.metrics-chart svg').length, 1);
      const href = (label: string) =>
        [...document.querySelectorAll('a')]
          .find((a) => a.textContent?.startsWith(label))
          ?.getAttribute('href');
      assert.equal(href('All runs'), '/metrics');
      assert.equal(href('Open in Trackio'), session.url);
      // The record names the experiment already: its runs say only their attempt.
      assert.match(text(), /lr-3e-3 · attempt 2/);
      assert.doesNotMatch(text(), /decay-sweep|run_ids/);
    }
    if (!enabled) assert.equal(requests.includes('POST /metrics/session'), false);
    await unmount();
  }
});
// Last: the shell read it leaves cached carries the Metrics row.
test('Metrics page lists experiments by name and state and draws the picked ones', async () => {
  setup();
  const asked: unknown[] = [];
  serve('/tools/metrics.chart', (_call, sent) => {
    asked.push(sent.runs);
    return { body: { result: chart } };
  });
  serve('/tools/metrics.read:runs', {
    body: {
      result: [
        { id: 'one', run: 'lr-3e-3', experimentId: 'experiment', experiment: 'decay-sweep' },
        { id: 'two', run: 'lr-1e-3', experimentId: 'experiment', experiment: 'decay-sweep' },
      ],
    },
  });
  serve('/tools/project.read:references', {
    body: {
      result: [
        {
          ref: 'experiment',
          status: 'resolved',
          kind: 'experiment',
          id: 'experiment',
          label: 'decay-sweep',
          state: 'running',
        },
      ],
    },
  });
  await mount(createElement(MemoryRouter, null, createElement(MetricsView)));
  await settle();
  assert.match(text(), /decay-sweep\s*running · 2 runs/);
  assert.match(text(), /lr-3e-3 · decay-sweep · attempt 2 · running/);
  assert.equal(document.querySelectorAll('.metrics-chart svg').length, 1);
  // A label is drawn as text, never as markup.
  assert.equal(document.querySelector('.metrics-chart b'), null);
  assert.match(document.querySelector('.metrics-chart title')!.textContent!, /<b>lower<\/b>/);
  assert.ok(
    [...document.querySelectorAll('a')].some(
      (a) => a.getAttribute('href') === '/experiments/experiment',
    ),
  );
  // Typing a filter keeps the box (and the charts) while the narrower read is asked.
  await click('Filter');
  const box = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  box.focus();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setValue.call(box, 'loss');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  assert.ok(box.isConnected);
  assert.equal(document.activeElement, box);
  assert.equal(document.querySelectorAll('.metrics-chart svg').length, 1);
  await click('decay-sweep');
  assert.deepEqual(asked.at(-1), ['one', 'two']);
  assert.doesNotMatch(text(), /run_ids|project_/);
  await unmount();
});
