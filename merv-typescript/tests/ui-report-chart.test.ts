import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, settle, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { Markdown } = await import('../packages/ui/web/markdown.js');
const { ROLES } = await import('../packages/reports/src/format/spec.js');

const page = (source: string) =>
  createElement(MemoryRouter, null, createElement(Markdown, { source }));

// The chart a results report writes under Result, as the seeded decay sweep does.
const CHART = {
  id: 'results',
  message: 'Stronger decay groks sooner.',
  data: {
    values: [
      {
        metric: 'Step at decay 0.3',
        delta: 14200,
        lo: 13300,
        hi: 15100,
        status: 'met',
        bar: 20000,
      },
      {
        metric: 'Step at decay 3.0',
        delta: 6050,
        lo: 5550,
        hi: 6550,
        status: 'not met',
        bar: 20000,
      },
    ],
  },
  y: { field: 'metric' },
  x: { title: 'Grokking step', domain: [0, 20000] },
  layer: [
    {
      mark: 'rule',
      x: 'lo',
      x2: 'hi',
      size: 'l',
      emphasis: 'low',
      color: { field: 'status', map: { met: 'result', 'not met': 'warn' } },
    },
    {
      mark: 'point',
      x: 'delta',
      size: 'l',
      color: { field: 'status', map: { met: 'result', 'not met': 'warn' } },
    },
    { mark: 'tick', x: 'bar', style: 'dashed', size: 's' },
  ],
};
const fenced = (body: string) => `Yes: it falls.\n\n\`\`\`chart\n${body}\n\`\`\`\n`;

/** Wait for Vega, which loads the first time a chart is shown, to have drawn. */
async function drawn() {
  for (let i = 0; i < 200 && !document.querySelector('.report-chart-view svg'); i++)
    await settle(25);
  return document.querySelector('.report-chart-view svg');
}

test("a report's chart block is drawn as a chart in the report palette, not shown as JSON", async (t) => {
  t.after(unmount);
  document.documentElement.dataset.theme = 'light';
  await mount(page(fenced(JSON.stringify(CHART))));
  const svg = await drawn();
  assert.ok(svg, 'the chart is drawn');
  const figure = document.querySelector('.report-chart')!;
  assert.match(figure.textContent ?? '', /Stronger decay groks sooner\./);
  // Neither the spec nor its rows are on the page as text.
  assert.equal(document.querySelector('.report-chart pre'), null);
  assert.doesNotMatch(document.body.textContent ?? '', /"message"|"values"/);
  // Met and not-met take the report's own result and warn colours.
  const markup = svg!.outerHTML.toLowerCase();
  assert.ok(markup.includes(ROLES.result.toLowerCase()), 'result colour');
  assert.ok(markup.includes(ROLES.warn.toLowerCase()), 'warn colour');
  assert.match(svg!.textContent ?? '', /Step at decay 0\.3/);
  // Its source stays one press away.
  const source = document.querySelector<HTMLButtonElement>(
    '.report-chart [aria-label="View source"]',
  );
  assert.ok(source);
  await act(async () => source!.click());
  assert.match(document.querySelector('.report-chart pre')?.textContent ?? '', /"id":"results"/);
});

test('in the dark the ink turns light and the colour roles stay', async (t) => {
  t.after(() => {
    document.documentElement.dataset.theme = 'light';
    return unmount();
  });
  document.documentElement.dataset.theme = 'dark';
  await mount(page(fenced(JSON.stringify(CHART))));
  const markup = (await drawn())!.outerHTML.toLowerCase();
  assert.ok(markup.includes(ROLES.result.toLowerCase()));
  assert.ok(!markup.includes(ROLES.ink.toLowerCase()), 'no near-black ink on a dark page');
});

test('a chart the page cannot draw is shown as written', async (t) => {
  t.after(unmount);
  for (const body of [
    '{"id": "results", "message": "Half a spec',
    JSON.stringify({ ...CHART, data: { file: 'results.csv' } }),
    JSON.stringify({ ...CHART, layer: [{ mark: 'pie' }] }),
  ]) {
    await mount(page(fenced(body)));
    await settle(20);
    assert.equal(document.querySelector('.report-chart'), null, body);
    assert.equal(document.querySelector('.code-body')?.textContent?.trim(), body);
    await unmount();
  }
});
