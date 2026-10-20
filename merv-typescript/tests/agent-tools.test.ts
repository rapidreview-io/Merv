import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createService } from '@merv/contracts';
import { ProjectScope } from '../packages/scope/src/index.js';
import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import type { ToolDefinition } from '../packages/api/src/types.js';
import { openState } from './fixtures/state.js';

test("a person's agent over MCP is offered what a Pi conversation is, while Merv's pages keep every tool", async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  t.after(async () => {
    await tools.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({
    projectName: 'Agent tools',
    actorName: 'Owner',
  });
  const owner = { projectId: boot.project.id, actorId: boot.actor.id };
  const issued = await scope.credentials.issueActor(owner, { name: 'Reader', role: 'reader' });
  const reader = { projectId: boot.project.id, actorId: issued.actor.id };
  const input = z.object({}).strict();
  const handler = () => ({ ran: true });
  tools.register({
    name: 'x.read',
    description: 'A read',
    readOnly: true,
    inputSchema: input,
    handler,
  });
  tools.register({ name: 'x.write', description: 'A write', inputSchema: input, handler });
  tools.register({
    name: 'x.propose',
    description: 'A write the person runs',
    inputSchema: input,
    conversation: 'propose',
    handler,
  });
  tools.register({
    name: 'x.page',
    description: "The page's own read",
    readOnly: true,
    inputSchema: input,
    conversation: 'never',
    handler,
  });
  // Pi's own and its profiles' tools, which no outside agent can use.
  tools.register({ name: 'x.pi', description: 'Pi', inputSchema: input, handler, agent: 'never' });
  tools.register({
    name: 'x.intake',
    description: 'A profile',
    inputSchema: input,
    handler,
    conversationProfile: 'intake',
  });
  const names = async (caller: typeof owner, agent: boolean) =>
    (await tools.describe(caller, agent)).map(({ name }) => name);

  // The pages (POST /tools) see everything the caller may call.
  assert.deepEqual(await names(owner, false), [
    'x.intake',
    'x.page',
    'x.pi',
    'x.propose',
    'x.read',
    'x.write',
  ]);
  // An agent is not offered what no conversation is, and a reader's agent only reads.
  assert.deepEqual(await names(owner, true), ['x.propose', 'x.read', 'x.write']);
  assert.deepEqual(await names(reader, true), ['x.read']);
  // Nor can it call it; the page still can.
  for (const name of ['x.page', 'x.pi'])
    await assert.rejects(tools.invoke(name, owner, {}, true), { code: 'tool_forbidden' });
  assert.deepEqual((await tools.invoke('x.page', owner, {})).value, { ran: true });
  // A proposal runs over MCP as the person's own call: the agent there is the person's.
  assert.deepEqual((await tools.invoke('x.propose', owner, {}, true)).value, { ran: true });
});

test("a tool's description carries its guard for a client's own permission prompt", () => {
  const handler = () => undefined;
  const requestId = z.string();
  const hints = (definition: Partial<ToolDefinition>) =>
    describeTool({ name: 'x', description: 'x', inputSchema: z.object({}), handler, ...definition })
      .annotations;
  assert.deepEqual(hints({ readOnly: true, openWorld: true }), {
    readOnlyHint: true,
    openWorldHint: true,
  });
  // A proposed or secret call, or one decided per input, is the person's to allow; its card's
  // title is the client's; a call keyed by requestId may be retried.
  for (const conversation of ['propose', 'secret', () => 'propose' as const] as const)
    assert.deepEqual(
      hints({
        conversation,
        act: { title: 'Submit verdict' },
        inputSchema: z.object({ requestId }),
      }),
      {
        title: 'Submit verdict',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    );
  // A title read from the input is the card's alone; 'never' is no guard, as nothing proposes it.
  assert.deepEqual(hints({ conversation: 'never', act: { title: () => 'Run' } }), {
    readOnlyHint: false,
    openWorldHint: false,
  });
});
