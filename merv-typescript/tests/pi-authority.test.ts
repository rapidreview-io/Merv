import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  createService,
  type Actor,
  type Caller,
  type ConversationAuthority,
  type ConversationToolPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '../packages/api/src/registry.js';

const conversation = {
  id: 'conversation_1',
  epoch: 1,
  commandId: 'command_1',
  runtimeId: 'runtime_1',
};
const caller: Caller = { actorId: 'actor_1', projectId: 'project_1', conversation };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    hold: async () => {
      enter();
      await waiting;
    },
  };
}

function registry(readScope?: <T>(fn: () => Promise<T>) => Promise<T>) {
  let permitted = true;
  let current = true;
  let calls = 0;
  const scope = {
    require: async (candidate: Caller) => {
      if (
        !current ||
        candidate.actorId !== caller.actorId ||
        candidate.projectId !== caller.projectId
      )
        throw Object.assign(new Error('Source revoked'), { code: 'forbidden' });
      return {} as Actor;
    },
  };
  const tools = new ToolRegistry(scope, undefined, readScope);
  const provider: ConversationToolPolicy = {
    allowsTool: async () => permitted,
    validate: async () => {
      if (!permitted) throw Object.assign(new Error('Grant revoked'), { code: 'forbidden' });
    },
  };
  tools.register({
    name: 'read',
    description: 'Read',
    readOnly: true,
    inputSchema: z.object({ value: z.string() }).strict(),
    handler: () => {
      calls++;
      return 'result';
    },
  });
  tools.register({
    name: 'mutate',
    description: 'Mutation',
    inputSchema: z.object({}).strict(),
    handler: () => {
      calls++;
      return 'mutated';
    },
  });
  return {
    tools,
    provider,
    scope,
    revokeGrant: () => {
      permitted = false;
    },
    revokeSource: () => {
      current = false;
    },
    calls: () => calls,
  };
}

test('conversation discovery and invocation fail closed without a provider', async () => {
  const fixture = registry();
  await assert.rejects(fixture.tools.describe(caller), { code: 'conversation_unavailable' });
  await assert.rejects(fixture.tools.list(caller), { code: 'conversation_unavailable' });
  await assert.rejects(fixture.tools.call('read', caller, { value: 'ok' }), {
    code: 'conversation_unavailable',
  });
  assert.equal(fixture.calls(), 0);
});

test('mixed session and conversation authority is refused before session admission', async () => {
  const fixture = registry();
  fixture.tools.registerConversationPolicy(fixture.provider);
  const mixed: Caller = { ...caller, session: { id: 'session_1' } };
  await assert.rejects(fixture.tools.describe(mixed), { code: 'forbidden' });
  await assert.rejects(fixture.tools.call('read', mixed, { value: 'ok' }), { code: 'forbidden' });
  assert.equal(fixture.calls(), 0);
});

test('a conversation sees every conversable native tool and never a mounted, never, propose or secret one runs', async () => {
  const fixture = registry();
  const dispose = fixture.tools.registerConversationPolicy(fixture.provider);
  assert.throws(() => fixture.tools.registerConversationPolicy(fixture.provider), {
    code: 'conversation_provider_conflict',
  });
  let ran = 0;
  const probe = (name: string, conversation?: unknown, result: unknown = name) =>
    fixture.tools.register({
      name,
      description: name,
      inputSchema: z.object({ mode: z.string().optional() }).strict(),
      conversation: conversation as 'never',
      handler: () => {
        ran++;
        return result;
      },
    });
  probe('never', 'never');
  probe('propose', 'propose');
  probe('secret', (input: { mode?: string }) => (input.mode === 'download' ? 'secret' : undefined));
  probe('leaky', undefined, { nested: [{ token: 'bearer' }] });
  const catalog = fixture.tools.createCatalog('bridge');
  await catalog.replace([
    {
      kind: 'mcp',
      name: 'remote',
      description: 'Remote read hint',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: () => {
        throw new Error('Remote handler must not run');
      },
    },
  ]);
  const offered = ['leaky', 'mutate', 'propose', 'read', 'secret'];
  assert.deepEqual(
    (await fixture.tools.describe(caller)).map((entry) => entry.name),
    offered,
  );
  assert.deepEqual(
    (await fixture.tools.list(caller)).map((entry) => entry.name),
    offered,
  );
  assert.equal(await fixture.tools.call('read', caller, { value: 'ok' }), 'result');
  assert.equal(await fixture.tools.call('mutate', caller, {}), 'mutated');
  assert.equal(await fixture.tools.call('secret', caller, { mode: 'inline' }), 'secret');
  for (const [name, input] of [
    ['never', {}],
    ['propose', {}],
    ['secret', { mode: 'download' }],
    ['_bridge.remote', {}],
  ] as const)
    await assert.rejects(fixture.tools.call(name, caller, input), { code: 'tool_forbidden' });
  await assert.rejects(fixture.tools.call('leaky', caller, {}), { code: 'tool_result_secret' });
  assert.equal(fixture.calls(), 2);
  assert.equal(ran, 2);
  fixture.revokeGrant();
  assert.deepEqual(await fixture.tools.describe(caller), []);
  await assert.rejects(fixture.tools.call('read', caller, { value: 'ok' }), {
    code: 'tool_forbidden',
  });
  dispose();
  await assert.rejects(fixture.tools.call('read', caller, { value: 'ok' }), {
    code: 'conversation_unavailable',
  });
});

for (const phase of ['discovery', 'validation'] as const) {
  test(`provider replacement fences pending ${phase} even with the same provider object`, async (t) => {
    const fixture = registry();
    const held = gate();
    t.after(held.release);
    let original = true;
    const provider: ConversationToolPolicy = {
      allowsTool: async () => {
        if (phase === 'discovery' && original) {
          original = false;
          await held.hold();
        }
        return true;
      },
      validate: async () => {
        if (phase === 'validation' && original) {
          original = false;
          await held.hold();
        }
      },
    };
    const dispose = fixture.tools.registerConversationPolicy(provider);
    const pending =
      phase === 'discovery'
        ? fixture.tools.describe(caller)
        : fixture.tools.call('read', caller, { value: 'ok' });
    const rejected = assert.rejects(pending, { code: 'conversation_unavailable' });
    await held.entered;
    dispose();
    fixture.tools.registerConversationPolicy(provider);
    held.release();
    await rejected;
    assert.equal(fixture.calls(), 0);
  });
}

test('revocation during parsing or after the read snapshot cannot release a result', async () => {
  const fixture = registry(async (run) => {
    const result = await run();
    fixture.revokeSource();
    return result;
  });
  fixture.tools.registerConversationPolicy(fixture.provider);
  const parsed = gate();
  fixture.tools.register({
    name: 'slow',
    description: 'Slow schema',
    readOnly: true,
    inputSchema: z.object({
      value: z.string().refine(async () => {
        await parsed.hold();
        return true;
      }),
    }),
    handler: () => {
      throw new Error('Handler must not run');
    },
  });
  const pending = fixture.tools.call('slow', caller, { value: 'ok' });
  const rejected = assert.rejects(pending, { code: 'tool_forbidden' });
  await parsed.entered;
  fixture.revokeGrant();
  parsed.release();
  await rejected;
  const next = registry(async (run) => {
    const result = await run();
    next.revokeSource();
    return result;
  });
  next.tools.registerConversationPolicy(next.provider);
  await assert.rejects(next.tools.call('read', caller, { value: 'ok' }), { code: 'forbidden' });
  assert.equal(next.calls(), 1);
  assert.equal(fixture.calls(), 0);
});

test('source and grant revocation are checked again immediately before dispatch', async () => {
  const fixture = registry();
  let validation = 0;
  fixture.tools.registerConversationPolicy({
    allowsTool: fixture.provider.allowsTool,
    validate: async () => {
      validation++;
      if (validation === 1) fixture.revokeSource();
    },
  });
  await assert.rejects(fixture.tools.call('read', caller, { value: 'ok' }), { code: 'forbidden' });
  assert.equal(fixture.calls(), 0);
});

test('a read result is withheld when its policy registration changes after the snapshot', async () => {
  let dispose!: () => void;
  let provider!: ConversationToolPolicy;
  const fixture = registry(async (run) => {
    const result = await run();
    dispose();
    fixture.tools.registerConversationPolicy(provider);
    return result;
  });
  provider = fixture.provider;
  dispose = fixture.tools.registerConversationPolicy(provider);
  await assert.rejects(fixture.tools.call('read', caller, { value: 'ok' }), {
    code: 'conversation_unavailable',
  });
  assert.equal(fixture.calls(), 1);
});

const database = process.env.MERV_TEST_POSTGRES_URL;
test(
  'Scope binds original delegation, refuses mixed or nested authority and fences revocation',
  { skip: !database && 'Requires MERV_TEST_POSTGRES_URL' },
  async (t) => {
    const { openState } = await import('./fixtures/state.js');
    const state = await openState();
    t.after(() => state.close());
    const scope = await createService(new ProjectScope(state));
    const boot = await scope.bootstrap({ projectName: 'Pi authority', actorName: 'Owner' });
    const original: Caller = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const issued = await scope.issueActor(original, { name: 'Pi user', role: 'reader' });
    const user: Caller = {
      actorId: issued.actor.id,
      projectId: issued.actor.projectId,
      credentialId: issued.credential.id,
    };
    const source = await scope.delegationSource(user);
    const agent: Caller = { actorId: user.actorId, projectId: user.projectId, conversation };
    await assert.rejects(scope.require(agent, 'read'), { code: 'conversation_unavailable' });
    const authority: ConversationAuthority = { require: async () => source };
    const dispose = scope.registerConversationAuthority(authority);
    assert.throws(() => scope.registerConversationAuthority(authority), {
      code: 'conversation_authority_registered',
    });
    assert.equal((await scope.require(agent, 'read')).id, user.actorId);
    // The conversation holds exactly its person's permissions: a reader's agent cannot write.
    await assert.rejects(scope.require(agent, 'write'), { code: 'forbidden' });
    await assert.rejects(scope.require({ ...agent, credentialId: user.credentialId }, 'read'), {
      code: 'forbidden',
    });
    await assert.rejects(scope.require({ ...agent, session: { id: 'session_1' } }, 'read'), {
      code: 'forbidden',
    });
    assert.deepEqual(await scope.delegationSource(agent), source);
    const worker = await state.transaction((tx) =>
      scope.createSessionActor(
        source,
        { sessionId: 'session_1', name: 'Worker', role: 'reader' },
        tx,
      ),
    );
    await assert.rejects(scope.require({ ...agent, actorId: worker.id }, 'read'), {
      code: 'conversation_forbidden',
    });
    dispose();
    const wrong = scope.registerConversationAuthority({
      require: async () => ({ ...source, actorId: worker.id }),
    });
    await assert.rejects(scope.require(agent, 'read'), { code: 'conversation_forbidden' });
    wrong();
    scope.registerConversationAuthority(authority);
    await scope.revokeCredential(original, issued.credential.id);
    await assert.rejects(scope.require(agent, 'read'), { code: 'forbidden' });
  },
);

test(
  'Scope fences authority removal and replacement during an in-flight transaction',
  { skip: !database && 'Requires MERV_TEST_POSTGRES_URL' },
  async (t) => {
    const { openState } = await import('./fixtures/state.js');
    const state = await openState();
    t.after(() => state.close());
    const scope = await createService(new ProjectScope(state));
    const boot = await scope.bootstrap({ projectName: 'Pi generation', actorName: 'Owner' });
    const original = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const source = await scope.delegationSource(original);
    const held = gate();
    t.after(held.release);
    let first = true;
    const authority: ConversationAuthority = {
      require: async () => {
        if (first) {
          first = false;
          await held.hold();
        }
        return source;
      },
    };
    const dispose = scope.registerConversationAuthority(authority);
    const pending = state.transaction(async (tx) => {
      await scope.require(
        { actorId: original.actorId, projectId: original.projectId, conversation },
        'read',
        tx,
      );
      await state.appendEvent(tx, {
        actorId: original.actorId,
        projectId: original.projectId,
        type: 'pi.authorized',
        subjectId: 'test',
        data: {},
      });
    });
    const rejected = assert.rejects(pending, { code: 'conversation_unavailable' });
    await held.entered;
    dispose();
    scope.registerConversationAuthority(authority);
    held.release();
    await rejected;
    assert.equal(
      (await state.events(original.projectId)).filter((event) => event.type === 'pi.authorized')
        .length,
      0,
    );
  },
);

test(
  'a conversation administers exactly as its source does, and names the source credential in self-checks',
  { skip: !database && 'Requires MERV_TEST_POSTGRES_URL' },
  async (t) => {
    const { openState } = await import('./fixtures/state.js');
    const state = await openState();
    t.after(() => state.close());
    const scope = await createService(new ProjectScope(state));
    const alice = await scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject: 'alice',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const project = await scope.createProject(alice, { name: 'Sources', requestId: 'sources' });
    const human = await scope.caller(alice, project.id);
    const { token } = await scope.createKey(alice, { projectId: project.id });
    const key = await scope.caller(
      { kind: 'key', key: await scope.authenticateKey(token) },
      project.id,
    );
    const robot = await scope.issueActor(human, { name: 'Robot', role: 'operator' });
    const actor: Caller = {
      actorId: robot.actor.id,
      projectId: project.id,
      credentialId: robot.credential.id,
    };
    let source = await scope.delegationSource(human);
    scope.registerConversationAuthority({ require: async () => structuredClone(source) });
    const agent = async (direct: Caller): Promise<Caller> => {
      source = await scope.delegationSource(direct);
      return { actorId: direct.actorId, projectId: direct.projectId, conversation };
    };
    // A signed-in person's agent administers, and the event names the conversation.
    const made = await scope.issueActor(await agent(human), { name: 'Made', role: 'reader' });
    const created = (await state.events(project.id)).find(
      (event) => event.type === 'actor.created' && event.subjectId === made.actor.id,
    );
    assert.deepEqual(created?.data.source, {
      kind: 'conversation',
      conversationId: conversation.id,
      commandId: conversation.commandId,
    });
    // A key refuses administration directly, and so does the agent of a key's conversation.
    await assert.rejects(scope.issueActor(key, { name: 'No', role: 'reader' }), {
      code: 'forbidden',
    });
    await assert.rejects(scope.issueActor(await agent(key), { name: 'No', role: 'reader' }), {
      code: 'forbidden',
    });
    await assert.rejects(scope.actorCredentials(await agent(key), made.actor.id), {
      code: 'forbidden',
    });
    assert.equal((await scope.actorCredentials(await agent(human), made.actor.id)).length, 1);
    // An actor credential's agent cannot revoke or rotate the credential its source rests on.
    const spare = await scope.issueActorCredential(actor, { actorId: robot.actor.id });
    await assert.rejects(scope.revokeCredential(await agent(actor), robot.credential.id), {
      code: 'self_revoke',
    });
    await assert.rejects(
      scope.rotateCredential(await agent(actor), { credentialId: robot.credential.id }),
      { code: 'self_rotation' },
    );
    await scope.revokeCredential(await agent(actor), spare.credential.id);
    await assert.rejects(scope.revokeActor(await agent(actor), robot.actor.id), {
      code: 'self_revoke',
    });
  },
);
