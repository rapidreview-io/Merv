import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { ToolDefinition } from '@merv/api/types';
import { taskToolsPlugin } from '../packages/tasks/src/tools.js';

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
      noun: () => async () => {},
      contributeInstructions: () => () => {},
    },
  } as unknown as Context);
  return tools;
}
test('a task delivery past MAX_ARTIFACT_IDS is refused as input, before its lookups bind every id', () => {
  const delivery = (count: number) =>
    registered(taskToolsPlugin)
      .get('task.submit_delivery')!
      .inputSchema.safeParse({
        taskId: 'task_1',
        artifactIds: Array.from({ length: count }, (_, index) => `a${index}`),
        expectedRevision: 1,
        requestId: 'r',
      }).success;
  assert.deepEqual([delivery(2000), delivery(2001)], [true, false]);
});
