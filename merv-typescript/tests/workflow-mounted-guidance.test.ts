import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition, WorkflowPolicy } from '@merv/contracts';
import { createApp } from './fixtures/app.js';

const definition = (name: string): WorkflowDefinition => ({
  name,
  version: 1,
  initial: 'ready',
  states: ['ready', 'done'],
  terminal: ['done'],
  edges: [{ from: 'ready', action: 'ask', to: 'done' }],
});

const policy = (tool: string): WorkflowPolicy => ({
  actions: [
    {
      name: 'ask',
      states: ['ready'],
      transitions: ['ask'],
      tool,
      instruction: 'Ask the research question.',
      check: async () => {},
    },
  ],
});

test('workflow guidance preserves supported published tool names, including mounted tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-mounted-guidance-'));
  const app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Mounted guidance',
      actorName: 'Operator',
    });
    const caller = { actorId: boot.actor.id, projectId: boot.project.id };
    const names = ['_nisa.ask', '_nisa.papers.search', '7native.tool', `_nisa.${'a'.repeat(122)}`];
    for (const [index, tool] of names.entries()) {
      const graph = definition(`mounted_lookup_${index}`);
      await app.ctx.workflows.register(graph, policy(tool));
      const instance = await app.ctx.workflows.start(caller, {
        workflow: graph.name,
        requestId: graph.name,
      });
      const guidance = await app.ctx.workflows.evaluate(caller, instance.id);
      assert.equal(guidance.nextAction?.tool, tool);
      assert.equal(guidance.nextAction?.status, 'ready');
    }

    // A policy names a tool; it neither publishes that tool nor performs a remote call.
    for (const [index, tool] of [
      '',
      'bad name',
      'bad/tool',
      'bad:tool',
      '\nask',
      'a'.repeat(129),
    ].entries()) {
      await assert.rejects(
        async () =>
          await app.ctx.workflows.register(definition(`invalid_lookup_${index}`), policy(tool)),
        { code: 'invalid_workflow_policy' },
      );
    }
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
