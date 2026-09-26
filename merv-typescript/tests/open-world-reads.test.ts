import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MervError, createService, type Actor, type Caller, type Data } from '@merv/contracts';
import { ProjectScope } from '../packages/scope/src/index.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { ToolDefinition } from '../packages/api/src/types.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

test('an open-world read waits on its service holding no snapshot or reader connection', async (t) => {
  // One reader connection: a read that kept it while another service answered would stall
  // every other read behind it.
  const state = await openState(undefined, { readConnections: 1, connectionTimeoutMs: 2000 });
  let tools: ToolRegistry | undefined;
  let entered = deferred();
  let answer = deferred();
  // A failed assertion must not leave a handler waiting on its answer, or closing hangs.
  t.after(async () => {
    answer.resolve();
    await tools?.close();
    await state.close();
  });
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Open-world reads', actorName: 'Owner' });
  const operator = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(operator, { name: 'Reader', role: 'reader' });
  const reader = {
    projectId: boot.project.id,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  // The snapshot wrapper the shipped toolsPlugin passes.
  tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  const inSnapshot: boolean[] = [];
  const hold = async () => {
    inSnapshot.push(state.readScope);
    entered.resolve();
    await answer.promise;
    return { answered: true };
  };
  tools.register({
    name: 'remote.search',
    description: 'Asks another service',
    readOnly: true,
    openWorld: true,
    inputSchema: z.object({}).strict(),
    handler: hold,
  });
  tools.register({
    name: 'local.slow',
    description: 'A read that waits in its snapshot',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: hold,
  });
  tools.register({
    name: 'local.read',
    description: 'Reads this database',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: async () => ({
      inSnapshot: state.readScope,
      one: (await state.transaction((tx) => tx.get<{ one: number }>('SELECT 1 AS one')))?.one,
    }),
  });
  const read = { inSnapshot: true, one: 1 };

  const searching = tools.call('remote.search', reader, {});
  await entered.promise;
  assert.deepEqual(await tools.call('local.read', reader, {}), read);
  answer.resolve();
  assert.deepEqual(await searching, { answered: true });

  // The same wait inside a snapshot holds the one connection until it ends.
  entered = deferred();
  answer = deferred();
  const waiting = tools.call('local.slow', reader, {});
  await entered.promise;
  let finished = false;
  const behind = tools.call('local.read', reader, {}).finally(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(finished, false);
  answer.resolve();
  assert.deepEqual(await waiting, { answered: true });
  assert.deepEqual(await behind, read);
  assert.deepEqual(inSnapshot, [false, true]);

  // Without a snapshot the result is still withheld from a caller revoked while it waited.
  entered = deferred();
  answer = deferred();
  const revoked = assert.rejects(tools.call('remote.search', reader, {}), { code: 'forbidden' });
  await entered.promise;
  try {
    await scope.revokeActor(operator, reader.actorId);
  } finally {
    answer.resolve();
  }
  await revoked;
  assert.deepEqual(inSnapshot, [false, true, false]);
});

test('an open-world read is listed, admitted and checked again exactly as a read', async (t) => {
  const caller: Caller = { actorId: 'alice', projectId: 'project-a', credentialId: 'key-alice' };
  let active = true;
  const scope = {
    require: async (candidate: Caller) => {
      if (!active || candidate.actorId !== 'alice' || candidate.projectId !== 'project-a')
        throw new MervError('forbidden', 'Project access denied', 403);
      return {} as Actor;
    },
  };
  let snapshots = 0;
  const tools = new ToolRegistry(scope, undefined, async (run) => {
    snapshots++;
    return run();
  });
  t.after(() => tools.close());
  const ran: string[] = [];
  const definition = (name: string, fields: Partial<ToolDefinition>): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    handler: () => {
      ran.push(name);
      return { name };
    },
    ...fields,
  });
  const remoteRead = definition('remote.read', { readOnly: true, openWorld: true });
  const remoteWrite = definition('remote.write', { openWorld: true });
  const localRead = definition('local.read', { readOnly: true });
  for (const tool of [remoteRead, remoteWrite, localRead]) tools.register(tool);
  // Policy belongs to the published registration, not to later edits of the definition.
  remoteRead.openWorld = false;
  localRead.openWorld = true;
  remoteWrite.readOnly = true;

  const annotations = Object.fromEntries(
    (await tools.describe(caller)).map((tool) => [tool.name, tool.annotations]),
  );
  assert.deepEqual(annotations, {
    'local.read': { readOnlyHint: true, openWorldHint: false },
    'remote.read': { readOnlyHint: true, openWorldHint: true },
    'remote.write': { readOnlyHint: false, openWorldHint: true },
  });

  await tools.call('local.read', caller, {});
  assert.equal(snapshots, 1);
  await tools.call('remote.read', caller, {});
  await tools.call('remote.write', caller, {});
  assert.equal(snapshots, 1, 'only the local read runs in a snapshot');

  // A session is offered and admits an open-world read as the read it is, and nothing more.
  const offered: Record<string, boolean | undefined> = {};
  const prepared: Record<string, boolean | undefined> = {};
  tools.registerSessionPolicy({
    allowsTool: async (_caller, name, read) => {
      offered[name] = read;
      return !!read;
    },
    prepare: async (caller, tool, input, read) => {
      prepared[tool] = read;
      if (!read) throw new MervError('tool_forbidden', 'This session only reads', 403);
      return { caller, tool, input };
    },
    validate: async () => {},
    run: async (invocation, dispatch) => dispatch(invocation.caller, invocation.input as Data),
    cancel: async () => {},
  });
  const session: Caller = { ...caller, session: { id: 'session_1' } };
  assert.deepEqual(
    (await tools.describe(session)).map((tool) => tool.name),
    ['local.read', 'remote.read'],
  );
  assert.deepEqual(offered, { 'local.read': true, 'remote.read': true, 'remote.write': false });
  assert.deepEqual(await tools.call('remote.read', session, {}), { name: 'remote.read' });
  await assert.rejects(tools.call('remote.write', session, {}), { code: 'tool_forbidden' });
  assert.deepEqual(prepared, { 'remote.read': true, 'remote.write': false });

  // A conversation may use it, and its grant is checked again after the remote answer.
  let granted = true;
  tools.registerConversationPolicy({
    allowsTool: async () => granted,
    validate: async () => {
      if (!granted) throw new MervError('forbidden', 'Grant revoked', 403);
    },
  });
  const conversation: Caller = {
    actorId: 'alice',
    projectId: 'project-a',
    conversation: { id: 'conversation_1', epoch: 1, commandId: 'command_1', runtimeId: 'r' },
  };
  assert.deepEqual(await tools.call('remote.read', conversation, {}), { name: 'remote.read' });
  tools.register(
    definition('remote.revoking', {
      readOnly: true,
      openWorld: true,
      handler: () => {
        granted = false;
        return { answered: true };
      },
    }),
  );
  await assert.rejects(tools.call('remote.revoking', conversation, {}), { code: 'tool_forbidden' });
  granted = true;
  tools.register(
    definition('remote.revoked', {
      readOnly: true,
      openWorld: true,
      handler: () => {
        active = false;
        return { answered: true };
      },
    }),
  );
  await assert.rejects(tools.call('remote.revoked', caller, {}), { code: 'forbidden' });
  assert.equal(snapshots, 1);
  assert.deepEqual(ran, [
    'local.read',
    'remote.read',
    'remote.write',
    'remote.read',
    'remote.read',
  ]);
});
