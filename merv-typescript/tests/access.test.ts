import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context, FiberState, ValidationError, type Plugin } from 'cordis';
import { MervError, type Caller } from '@merv/contracts';
import { SqliteState, statePlugin } from '@merv/state';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { ExactToolPolicy } from '../packages/scope/src/tool-policy.js';
import type { ToolGrant } from '@merv/contracts';

async function setup(t: TestContext) {
  const state = new SqliteState(':memory:');
  t.after(async () => await state.close());
  const scope = await createService(new ProjectScope(state));
  const first = await scope.bootstrap({
    projectName: 'First project',
    actorName: 'First operator',
  });
  const second = await scope.bootstrap({
    projectName: 'Second project',
    actorName: 'Second operator',
  });
  const operator = { projectId: first.project.id, actorId: first.actor.id };
  const other = { projectId: second.project.id, actorId: second.actor.id };
  const readerActor = (await scope.issueActor(operator, { name: 'First reader', role: 'reader' }))
    .actor;
  const reader = { projectId: first.project.id, actorId: readerActor.id };
  const otherReaderActor = (
    await scope.issueActor(other, { name: 'Second reader', role: 'reader' })
  ).actor;
  const otherReader = { projectId: second.project.id, actorId: otherReaderActor.id };
  return { state, scope, operator, reader, other, otherReader };
}
const grant = (caller: Caller, tools = ['search'], mountId = 'research'): ToolGrant => ({
  ...caller,
  mountId,
  tools,
});

test('default policy grants no authority to readers or operators and does not infer read-only access', async (t) => {
  const { scope, operator, reader, other, otherReader } = await setup(t);
  const policy = new ExactToolPolicy(scope);
  for (const caller of [operator, reader, other, otherReader])
    for (const tool of ['search', 'read', 'list', 'write']) {
      assert.equal(await policy.allows(caller, 'research', tool), false);
      await assert.rejects(async () => await policy.require(caller, 'research', tool), {
        code: 'tool_forbidden',
        status: 403,
      });
    }
});

test('grants match exact projects, actors, mounts and raw names without changing local role permissions', async (t) => {
  const { scope, operator, reader, other, otherReader } = await setup(t);
  const policy = new ExactToolPolicy(scope, [
    grant(reader, ['search', 'paper.write']),
    grant(other, ['search']),
  ]);
  assert.equal(await policy.allows(reader, 'research', 'search'), true);
  await assert.doesNotReject(async () => await policy.require(reader, 'research', 'paper.write'));
  assert.equal(await policy.allows(other, 'research', 'search'), true);
  for (const caller of [operator, otherReader])
    assert.equal(await policy.allows(caller, 'research', 'search'), false);
  assert.equal(await policy.allows(reader, 'Research', 'search'), false);
  assert.equal(await policy.allows(reader, 'research', 'Search'), false);
  assert.equal(await policy.allows(reader, 'research', 'paper.read'), false);
  assert.equal(await policy.allows(reader, 'research', '_research.search'), false);
  await assert.rejects(async () => await scope.require(reader, 'write'), { code: 'forbidden' });
  await assert.rejects(
    async () => await scope.issueActor(reader, { name: 'Escalated', role: 'operator' }),
    {
      code: 'forbidden',
    },
  );
  const crossed = { ...reader, projectId: other.projectId };
  policy.replace([grant(crossed)]);
  assert.equal(await policy.allows(crossed, 'research', 'search'), false);
  await assert.rejects(async () => await policy.require(crossed, 'research', 'search'), {
    code: 'forbidden',
  });
});

test('replacement and actor revocation take effect on every later check without a restart', async (t) => {
  const { scope, operator, reader } = await setup(t);
  const policy = new ExactToolPolicy(scope, [grant(reader)]);
  assert.equal(await policy.allows(reader, 'research', 'search'), true);
  policy.replace([grant(reader, ['paper.get'])]);
  assert.equal(await policy.allows(reader, 'research', 'search'), false);
  await assert.rejects(async () => await policy.require(reader, 'research', 'search'), {
    code: 'tool_forbidden',
  });
  assert.equal(await policy.allows(reader, 'research', 'paper.get'), true);
  await scope.revokeActor(operator, reader.actorId);
  assert.equal(await policy.allows(reader, 'research', 'paper.get'), false);
  await assert.rejects(async () => await policy.require(reader, 'research', 'paper.get'), {
    code: 'forbidden',
  });
  policy.replace([]);
  assert.equal(await policy.allows(operator, 'research', 'paper.get'), false);
});

test('invalid replacement never partially publishes and mutable grant inputs cannot change authority', async (t) => {
  const { scope, operator, reader } = await setup(t);
  const source = [grant(reader)];
  const policy = new ExactToolPolicy(scope, source);
  source[0].tools.push('mutated');
  source[0].actorId = operator.actorId;
  source.push(grant(operator));
  assert.equal(await policy.allows(reader, 'research', 'search'), true);
  assert.equal(await policy.allows(reader, 'research', 'mutated'), false);
  assert.equal(await policy.allows(operator, 'research', 'search'), false);
  const malformed: unknown[] = [
    null,
    {},
    [{ ...grant(operator), extra: true }],
    [{ ...grant(operator), actorId: '' }],
    [{ ...grant(operator), projectId: '*' }],
    [{ ...grant(operator), mountId: 'bad__mount' }],
    [{ ...grant(operator), mountId: 'Uppercase' }],
    [{ ...grant(operator), tools: ['*'] }],
    [{ ...grant(operator), tools: ['paper.*'] }],
    [{ ...grant(operator), tools: [12] }],
    [grant(operator), { ...grant(operator), tools: [''] }],
  ];
  for (const invalid of malformed) {
    assert.throws(() => policy.replace(invalid as ToolGrant[]), { code: 'invalid_access_grants' });
    assert.equal(await policy.allows(reader, 'research', 'search'), true);
    assert.equal(await policy.allows(operator, 'research', 'search'), false);
  }
  policy.replace([grant(reader, []), grant(reader, ['paper.get']), grant(reader, ['search'])]);
  assert.equal(await policy.allows(reader, 'research', 'search'), true);
  assert.equal(await policy.allows(reader, 'research', 'paper.get'), true);
});

test('allows does not hide infrastructure failures as an ordinary missing grant', async () => {
  const failure = new MervError('state_closed', 'State is closed', 503);
  const policy = new ExactToolPolicy({
    async require() {
      throw failure;
    },
  });
  await assert.rejects(
    async () => await policy.allows({ actorId: 'actor', projectId: 'project' }, 'remote', 'read'),
    failure,
  );
});

test('Scope owns tool policy, defaults and suspension with only State as its dependency', async () => {
  const ctx = new Context();
  try {
    const scope = ctx.plugin(scopePlugin);
    assert.equal(ctx.get('scope'), undefined);
    await ctx.plugin(statePlugin, { path: ':memory:' });
    await scope;
    assert.equal(scope.state, FiberState.ACTIVE);
    assert.deepEqual(scope.config, { grants: [] });
    assert.equal(ctx.get('tools'), undefined);
    assert.equal(ctx.get('api'), undefined);
    assert.equal(ctx.get('access'), undefined);
    const owner = await ctx.scope.bootstrap({ projectName: 'Standalone', actorName: 'Operator' });
    const caller = { projectId: owner.project.id, actorId: owner.actor.id };
    assert.equal(await ctx.scope.toolPolicy.allows(caller, 'research', 'search'), false);
    ctx.scope.toolPolicy.replace([grant(caller)]);
    assert.equal(await ctx.scope.toolPolicy.allows(caller, 'research', 'search'), true);
    await scope.dispose();
    assert.equal(ctx.get('scope'), undefined);
    const restored = await ctx.plugin(scopePlugin);
    assert.equal(await ctx.scope.toolPolicy.allows(caller, 'research', 'search'), false);
    await restored.dispose();
    await ctx.plugin(scopePlugin, { grants: [grant(caller)] });
    assert.equal(await ctx.scope.toolPolicy.allows(caller, 'research', 'search'), true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('strict Cordis Config rejects malformed grants before publishing the service', async () => {
  for (const config of [
    null,
    [],
    { extra: true },
    { grants: null },
    { grants: [{ projectId: 'project', actorId: 'actor', mountId: 'remote', tools: ['*'] }] },
  ]) {
    const ctx = new Context();
    try {
      await ctx.plugin(statePlugin, { path: ':memory:' });
      const scope = ctx.plugin(scopePlugin as Plugin, config);
      await assert.rejects(scope.await(), ValidationError);
      assert.equal(ctx.get('scope'), undefined);
      assert.deepEqual(scope.getEffects(), []);
    } finally {
      await ctx.fiber.dispose();
    }
  }
});
