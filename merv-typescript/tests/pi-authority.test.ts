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

test('only registered native read tools are discoverable and callable', async () => {
  const fixture = registry();
  const dispose = fixture.tools.registerConversationPolicy(fixture.provider);
  assert.throws(() => fixture.tools.registerConversationPolicy(fixture.provider), {
    code: 'conversation_provider_conflict',
  });
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
  assert.deepEqual(
    (await fixture.tools.describe(caller)).map((entry) => entry.name),
    ['read'],
  );
  assert.deepEqual(
    (await fixture.tools.list(caller)).map((entry) => entry.name),
    ['read'],
  );
  assert.equal(await fixture.tools.call('read', caller, { value: 'ok' }), 'result');
  await assert.rejects(fixture.tools.call('mutate', caller, {}), { code: 'tool_forbidden' });
  await assert.rejects(fixture.tools.call('_bridge.remote', caller, {}), {
    code: 'tool_forbidden',
  });
  assert.equal(fixture.calls(), 1);
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
    await assert.rejects(scope.require(agent, 'write'), { code: 'conversation_forbidden' });
    await assert.rejects(scope.require({ ...agent, credentialId: user.credentialId }, 'read'), {
      code: 'forbidden',
    });
    await assert.rejects(scope.require({ ...agent, session: { id: 'session_1' } }, 'read'), {
      code: 'forbidden',
    });
    await assert.rejects(scope.delegationSource(agent), { code: 'nested_session' });
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
