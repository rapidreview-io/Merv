import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context, FiberState, ValidationError, type Plugin } from 'cordis';
import { MervError, type Caller } from '@merv/contracts';
import { SqliteState, statePlugin } from '@merv/state';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { ExactAccessPolicy, accessPlugin } from '../packages/access/src/index.js';
import type { ToolGrant } from '../packages/access/src/types.js';

function setup(t: TestContext) {
  const state = new SqliteState(':memory:');
  t.after(() => state.close());
  const scope = new ProjectScope(state);
  const first = scope.bootstrap({ projectName: 'First project', actorName: 'First operator' });
  const second = scope.bootstrap({ projectName: 'Second project', actorName: 'Second operator' });
  const operator = { projectId: first.project.id, actorId: first.actor.id };
  const other = { projectId: second.project.id, actorId: second.actor.id };
  const readerActor = scope.issueActor(operator, { name: 'First reader', role: 'reader' }).actor;
  const reader = { projectId: first.project.id, actorId: readerActor.id };
  const otherReaderActor = scope.issueActor(other, { name: 'Second reader', role: 'reader' }).actor;
  const otherReader = { projectId: second.project.id, actorId: otherReaderActor.id };
  return { state, scope, operator, reader, other, otherReader };
}
const grant = (caller: Caller, tools = ['search'], mountId = 'research'): ToolGrant => ({
  ...caller,
  mountId,
  tools,
});

test('default policy grants no authority to readers or operators and does not infer read-only access', (t) => {
  const { scope, operator, reader, other, otherReader } = setup(t);
  const policy = new ExactAccessPolicy(scope);
  for (const caller of [operator, reader, other, otherReader])
    for (const tool of ['search', 'read', 'list', 'write']) {
      assert.equal(policy.allows(caller, 'research', tool), false);
      assert.throws(() => policy.require(caller, 'research', tool), {
        code: 'tool_forbidden',
        status: 403,
      });
    }
});

test('grants match exact projects, actors, mounts and raw names without changing local role permissions', (t) => {
  const { scope, operator, reader, other, otherReader } = setup(t);
  const policy = new ExactAccessPolicy(scope, [
    grant(reader, ['search', 'paper.write']),
    grant(other, ['search']),
  ]);
  assert.equal(policy.allows(reader, 'research', 'search'), true);
  assert.doesNotThrow(() => policy.require(reader, 'research', 'paper.write'));
  assert.equal(policy.allows(other, 'research', 'search'), true);
  for (const caller of [operator, otherReader])
    assert.equal(policy.allows(caller, 'research', 'search'), false);
  assert.equal(policy.allows(reader, 'Research', 'search'), false);
  assert.equal(policy.allows(reader, 'research', 'Search'), false);
  assert.equal(policy.allows(reader, 'research', 'paper.read'), false);
  assert.equal(policy.allows(reader, 'research', 'mount__research__search'), false);
  assert.throws(() => scope.require(reader, 'write'), { code: 'forbidden' });
  assert.throws(() => scope.issueActor(reader, { name: 'Escalated', role: 'operator' }), {
    code: 'forbidden',
  });
  const crossed = { ...reader, projectId: other.projectId };
  policy.replace([grant(crossed)]);
  assert.equal(policy.allows(crossed, 'research', 'search'), false);
  assert.throws(() => policy.require(crossed, 'research', 'search'), { code: 'forbidden' });
});

test('replacement and actor revocation take effect on every later check without a restart', (t) => {
  const { scope, operator, reader } = setup(t);
  const policy = new ExactAccessPolicy(scope, [grant(reader)]);
  assert.equal(policy.allows(reader, 'research', 'search'), true);
  policy.replace([grant(reader, ['paper.get'])]);
  assert.equal(policy.allows(reader, 'research', 'search'), false);
  assert.throws(() => policy.require(reader, 'research', 'search'), { code: 'tool_forbidden' });
  assert.equal(policy.allows(reader, 'research', 'paper.get'), true);
  scope.revokeActor(operator, reader.actorId);
  assert.equal(policy.allows(reader, 'research', 'paper.get'), false);
  assert.throws(() => policy.require(reader, 'research', 'paper.get'), { code: 'forbidden' });
  policy.replace([]);
  assert.equal(policy.allows(operator, 'research', 'paper.get'), false);
});

test('invalid replacement never partially publishes and mutable grant inputs cannot change authority', (t) => {
  const { scope, operator, reader } = setup(t);
  const source = [grant(reader)];
  const policy = new ExactAccessPolicy(scope, source);
  source[0].tools.push('mutated');
  source[0].actorId = operator.actorId;
  source.push(grant(operator));
  assert.equal(policy.allows(reader, 'research', 'search'), true);
  assert.equal(policy.allows(reader, 'research', 'mutated'), false);
  assert.equal(policy.allows(operator, 'research', 'search'), false);
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
    assert.equal(policy.allows(reader, 'research', 'search'), true);
    assert.equal(policy.allows(operator, 'research', 'search'), false);
  }
  policy.replace([grant(reader, []), grant(reader, ['paper.get']), grant(reader, ['search'])]);
  assert.equal(policy.allows(reader, 'research', 'search'), true);
  assert.equal(policy.allows(reader, 'research', 'paper.get'), true);
});

test('allows does not hide infrastructure failures as an ordinary missing grant', () => {
  const failure = new MervError('state_closed', 'State is closed', 503);
  const policy = new ExactAccessPolicy({
    require() {
      throw failure;
    },
  });
  assert.throws(
    () => policy.allows({ actorId: 'actor', projectId: 'project' }, 'remote', 'read'),
    failure,
  );
});

test('Cordis owns access publication, defaults and suspension with only Scope as its dependency', async () => {
  const ctx = new Context();
  try {
    const access = ctx.plugin(accessPlugin);
    await ctx.plugin(statePlugin, { path: ':memory:' });
    assert.equal(ctx.get('access'), undefined);
    const scope = await ctx.plugin(scopePlugin);
    await access;
    assert.equal(access.state, FiberState.ACTIVE);
    assert.deepEqual(access.config, { grants: [] });
    assert.equal(ctx.get('tools'), undefined);
    assert.equal(ctx.get('api'), undefined);
    const owner = ctx.scope.bootstrap({ projectName: 'Standalone', actorName: 'Operator' });
    const caller = { projectId: owner.project.id, actorId: owner.actor.id };
    assert.equal(ctx.access.allows(caller, 'research', 'search'), false);
    ctx.access.replace([grant(caller)]);
    assert.equal(ctx.access.allows(caller, 'research', 'search'), true);
    await scope.dispose();
    assert.equal(ctx.get('access'), undefined);
    assert.equal(access.state, FiberState.PENDING);
    await ctx.plugin(scopePlugin);
    await access;
    assert.equal(ctx.access.allows(caller, 'research', 'search'), false);
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
      await ctx.plugin(scopePlugin);
      const access = ctx.plugin(accessPlugin as Plugin, config);
      await assert.rejects(access.await(), ValidationError);
      assert.equal(ctx.get('access'), undefined);
      assert.deepEqual(access.getEffects(), []);
    } finally {
      await ctx.fiber.dispose();
    }
  }
});
