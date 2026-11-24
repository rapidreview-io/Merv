import assert from 'node:assert/strict';
import test from 'node:test';
import {
  armsOfRuns,
  findingOf,
  itemState,
  parsePlan,
  stagesOf,
} from '../packages/ui/web/item-model.js';
import { keyMetric, sparkPaths } from '@merv/metrics/chart';

test("a plan in its brief's shape gives the card its question, arms, measure and check", () => {
  const plan = parsePlan(
    [
      '## Summary',
      'Question: Does decay move the grokking step?',
      '## Evaluation',
      '| Arm | What it varies |',
      '|---|---|',
      '| **Low** | decay 0.3 |',
      '| High | decay 3.0 |',
      '',
      '- Primary measure: validation accuracy',
      '- Success: the step falls with decay.',
      '- Budget: <compute and time, one line>',
    ].join('\n'),
  );
  assert.deepEqual(plan, {
    question: 'Does decay move the grokking step?',
    arms: [
      { name: 'Low', detail: 'decay 0.3' },
      { name: 'High', detail: 'decay 3.0' },
    ],
    measure: 'validation accuracy',
    success: 'the step falls with decay.',
  });
  // The template's placeholders are not a plan.
  assert.deepEqual(parsePlan('| Arm | What it varies |\n|---|---|\n| <arm> | <what> |'), {
    arms: [],
  });
});

test('what an item found is its report summary’s first sentence, past any front matter', () => {
  assert.equal(
    findingOf(
      '---\nid: "x"\ncriteria:\n  - {a: 1}\n---\n## Result\nYes: it falls, from 14,200 to 6,050. More.',
    ),
    'Yes: it falls, from 14,200 to 6,050.',
  );
  assert.equal(
    findingOf('## Summary\nNo effect at p = 113.\n## Results\n| a |'),
    'No effect at p = 113.',
  );
  assert.equal(findingOf(undefined), undefined);
});

test('four marks, the same everywhere', () => {
  assert.equal(itemState({ settled: true, failed: true }), 'failed');
  assert.equal(itemState({ settled: true }), 'done');
  assert.equal(itemState({ attention: true }), 'needs');
  assert.equal(itemState({}), 'working');
  assert.deepEqual(
    stagesOf('task', 'in_review', false).map((step) => `${step.label}:${step.at}`),
    ['Work:done', 'Review:now', 'Done:next'],
  );
});

test('the key metric is the measure the plan names, else a held-out score, never bookkeeping', () => {
  const logged = ['cost_usd', 'lr', 'train/acc', 'train/loss', 'val/acc', 'val/loss'];
  assert.equal(keyMetric(logged), 'val/acc');
  assert.equal(keyMetric(logged, 'validation loss'), 'val/loss');
  assert.equal(keyMetric(['loss', 'lr']), 'loss');
  assert.equal(keyMetric(['cost_usd']), undefined);
  assert.deepEqual(
    armsOfRuns([{ run: 'baseline-seed1' }, { run: 'baseline-seed2' }, { run: 'ablation_s1' }]),
    [{ name: 'ablation' }, { name: 'baseline', detail: '×2 seeds' }],
  );
  // A run of one point draws no line; two runs share one frame.
  assert.deepEqual(sparkPaths([{ id: 'a', color: '#2a78d6', points: [[0, 1]] }]), []);
  const paths = sparkPaths([
    {
      id: 'a',
      color: '#2a78d6',
      points: [
        [0, 0],
        [10, 1],
      ],
    },
    {
      id: 'b',
      color: '#eb6834',
      muted: true,
      points: [
        [0, 1],
        [10, 0.5],
      ],
    },
  ]);
  assert.deepEqual(
    paths.map((path) => path.id),
    ['b', 'a'],
    'the muted run is drawn first, under',
  );
  assert.equal(paths[1]!.color, 'var(--mc-1, #2a78d6)');
});
