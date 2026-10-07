/**
 * The documents agents write are visual, brief and scannable (owner, 2026-10-06): the plan, the
 * experiment report and the task delivery report each have a short Markdown template in their
 * producer's recipe, and each review judges the format as its last criterion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  designCriteria,
  EXPERIMENT_RECIPES,
  feasibilityCriterion,
  resultsCriteria,
} from '@merv/experiments/definitions';
import { DELIVERY_REPORT_CRITERION, reportsDelivery, TASK_TYPES } from '@merv/tasks/definitions';

const recipe = (name: string, version?: number) => {
  const found = [...EXPERIMENT_RECIPES, ...TASK_TYPES].filter(
    (r) => r.name === name && (version === undefined || r.version === version),
  );
  assert.equal(found.length, 1, `${name}@${version ?? '*'} is registered once`);
  return found[0]!;
};
const includesAll = (text: string, parts: string[]) => {
  for (const part of parts) assert.ok(text.includes(part), `missing ${JSON.stringify(part)}`);
};

test('the plan template: question, flowchart, arms table, measure, threshold, budget, risks', () => {
  const design = recipe('experiment.design');
  assert.equal(design.version, 12);
  includesAll(design.recipe.outputInstructions, [
    'about one screen',
    'appendix artifact',
    // The headings validatePlan requires.
    '## Summary',
    '## Objective & hypothesis',
    '## Evaluation',
    'Question: <one line>',
    '```mermaid\nflowchart LR',
    '| Arm | What it varies |',
    '- Primary measure: <one line>',
    '- Success: <threshold, one line>',
    '- Budget: <compute and time, one line>',
    'Risks:\n- <at most 3 bullets>',
  ]);
});

test('the report template stands alone: answer, results table, diagram, meaning, limits, evidence', () => {
  const execute = recipe('experiment.execute');
  assert.equal(execute.version, 12);
  includesAll(execute.recipe.outputInstructions, [
    'stands alone',
    'one to two screens',
    // The headings validateReport requires.
    '## Summary',
    '## Results',
    '## Deviations from plan',
    '## Conclusion',
    '<the answer, two sentences>',
    '± <uncertainty>',
    '```mermaid\nflowchart LR',
    'Evidence: [<name>](/artifacts/<artifact id>)',
    'at most 3 bullets',
    'Limits:\n- <at most 3 bullets>',
  ]);
});

test('a new task asks for the delivery report; tasks pinned to task.work@4 keep their recipe', () => {
  const old = recipe('task.work', 4);
  const reported = recipe('task.work', 5);
  assert.doesNotMatch(old.recipe.outputInstructions, /delivery report/);
  assert.deepEqual(
    { ...reported.recipe, outputInstructions: '' },
    {
      ...old.recipe,
      outputInstructions: '',
    },
  );
  includesAll(reported.recipe.outputInstructions, [
    'text/markdown',
    '<what was done, one or two sentences>',
    '| Check | Status | Evidence |',
    'met / not met',
    'Changed: <N files, M commits>',
    'Follow-ups:\n- <at most 3 bullets>',
    'List the report first in artifactIds',
  ]);
  assert.equal(reportsDelivery('task.work', 4), false);
  assert.equal(reportsDelivery('task.work', 5), true);
  assert.equal(reportsDelivery('project.reflection', 5), false);
});

test('each review judges its document’s format last, and feasibility stays criterion 4', () => {
  assert.match(designCriteria.at(-1)!, /^Format: the plan .*mermaid flowchart.*at most 3 risks/);
  assert.match(resultsCriteria.at(-1)!, /^Format: the report stands alone .*mermaid diagram/);
  assert.match(DELIVERY_REPORT_CRITERION, /^Format: the delivery report .*table of every check/);
  assert.equal(feasibilityCriterion, 4);
  assert.match(designCriteria[feasibilityCriterion - 1]!, /feasibility statement/);
  for (const criterion of [
    designCriteria.at(-1)!,
    resultsCriteria.at(-1)!,
    DELIVERY_REPORT_CRITERION,
  ])
    assert.ok(criterion.length < 400, 'a format criterion stays short');
});

test('the templates leave the recipes far inside their budgets', () => {
  for (const r of [
    recipe('experiment.design'),
    recipe('experiment.execute'),
    recipe('task.work', 5),
  ]) {
    const own = r.recipe.instructions.length + r.recipe.outputInstructions.length;
    assert.ok(
      own < r.recipe.maxChars / 20,
      `${r.name}@${r.version}: ${own} of ${r.recipe.maxChars}`,
    );
  }
});
