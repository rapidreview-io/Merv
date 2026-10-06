import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { ToolDefinition } from '@merv/api/types';
import { researchToolsPlugin } from '../packages/research/src/tools.js';
import { taskToolsPlugin } from '../packages/tasks/src/tools.js';
import { experimentsToolsPlugin } from '../packages/experiments/src/tools.js';

/** The tools a plugin registers, by name, read without running any of them. */
function registered(plugin: { apply(ctx: Context): void }) {
  const tools = new Map<string, ToolDefinition>();
  plugin.apply({
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return async () => {};
      },
      contributeInstructions: () => () => {},
    },
  } as unknown as Context);
  return tools;
}
const workflow = { state: 'researching', revision: 1 };

test('research.advance tells Pi the transition and every child ID, never the full Problem', () => {
  const cycle = {
    id: 'research_1',
    workflow,
    reflectionId: 'reflection_very_long_identifier_that_must_not_be_clipped',
    integrations: ['task_first', 'task_second'],
    successorId: 'research_successor',
    problem: { text: 'Full Problem content '.repeat(300) },
  };
  assert.deepEqual(registered(researchToolsPlugin).get('research.advance')!.receipt!(cycle, {}), {
    summary: {
      id: 'research_1',
      state: 'researching',
      revision: 1,
      reflectionId: cycle.reflectionId,
      integrations: cycle.integrations,
      successorId: 'research_successor',
    },
    reread: ['research.get', 'workflow.status_and_next'],
  });
  const bare = { ...cycle, reflectionId: null, successorId: null, integrations: [] };
  assert.deepEqual(
    registered(researchToolsPlugin).get('research.advance')!.receipt!(bare, {}).summary,
    { id: 'research_1', state: 'researching', revision: 1, integrations: [] },
  );
});

test('a task delivery or failure and an experiment transition tell Pi the record it moved', () => {
  const tasks = registered(taskToolsPlugin);
  const task = { id: 'task_1', workflow, reviewId: 'review_1', checks: ['long'] };
  assert.deepEqual(tasks.get('task.submit_delivery')!.receipt!(task, {}), {
    summary: { id: 'task_1', state: 'researching', revision: 1, reviewId: 'review_1' },
    reread: ['task.get', 'workflow.status_and_next'],
  });
  assert.deepEqual(tasks.get('task.mark_failed')!.receipt!(task, {}).summary, {
    id: 'task_1',
    state: 'researching',
    revision: 1,
  });
  const experiment = { id: 'experiment_1', workflow, reviewId: null, evidence: [] };
  assert.deepEqual(
    registered(experimentsToolsPlugin).get('experiment.transition')!.receipt!(experiment, {}),
    {
      summary: { id: 'experiment_1', state: 'researching', revision: 1, reviewId: null },
      reread: ['experiment.get_state', 'workflow.status_and_next'],
    },
  );
});
