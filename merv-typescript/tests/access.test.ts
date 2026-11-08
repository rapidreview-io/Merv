import type { ToolGrant } from '@merv/contracts';
import { createService, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ExactToolPolicy } from '../packages/scope/src/tool-policy.js';
import { openState } from './fixtures/state.js';

async function setup(t: TestContext) {
  const state = await openState(':memory:');
  t.after(async () => await state.close());
  const scope = await createService(new ProjectScope(state));
  const first = await scope.credentials.bootstrap({
    projectName: 'First project',
    actorName: 'First operator',
  });
  const second = await scope.credentials.bootstrap({
    projectName: 'Second project',
    actorName: 'Second operator',
  });
  const operator = { projectId: first.project.id, actorId: first.actor.id };
  const other = { projectId: second.project.id, actorId: second.actor.id };
  const readerActor = (
    await scope.credentials.issueActor(operator, { name: 'First reader', role: 'reader' })
  ).actor;
  const reader = { projectId: first.project.id, actorId: readerActor.id };
  const otherReaderActor = (
    await scope.credentials.issueActor(other, { name: 'Second reader', role: 'reader' })
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
      assert.equal((await policy.granted(caller))('research', tool), false);
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
  assert.equal((await policy.granted(reader))('research', 'search'), true);
  await assert.doesNotReject(async () => await policy.require(reader, 'research', 'paper.write'));
  assert.equal((await policy.granted(other))('research', 'search'), true);
  for (const caller of [operator, otherReader])
    assert.equal((await policy.granted(caller))('research', 'search'), false);
  assert.equal((await policy.granted(reader))('Research', 'search'), false);
  assert.equal((await policy.granted(reader))('research', 'Search'), false);
  assert.equal((await policy.granted(reader))('research', 'paper.read'), false);
  assert.equal((await policy.granted(reader))('research', '_research.search'), false);
  await assert.rejects(async () => await scope.require(reader, 'write'), { code: 'forbidden' });
  await assert.rejects(
    async () => await scope.credentials.issueActor(reader, { name: 'Escalated', role: 'operator' }),
    {
      code: 'forbidden',
    },
  );
  const crossed = { ...reader, projectId: other.projectId };
  policy.replace([grant(crossed)]);
  assert.equal((await policy.granted(crossed))('research', 'search'), false);
  await assert.rejects(async () => await policy.require(crossed, 'research', 'search'), {
    code: 'forbidden',
  });
});

test('replacement and actor revocation take effect on every later check without a restart', async (t) => {
  const { scope, operator, reader } = await setup(t);
  const policy = new ExactToolPolicy(scope, [grant(reader)]);
  assert.equal((await policy.granted(reader))('research', 'search'), true);
  policy.replace([grant(reader, ['paper.get'])]);
  assert.equal((await policy.granted(reader))('research', 'search'), false);
  await assert.rejects(async () => await policy.require(reader, 'research', 'search'), {
    code: 'tool_forbidden',
  });
  assert.equal((await policy.granted(reader))('research', 'paper.get'), true);
  await scope.credentials.revokeActor(operator, reader.actorId);
  assert.equal((await policy.granted(reader))('research', 'paper.get'), false);
  await assert.rejects(async () => await policy.require(reader, 'research', 'paper.get'), {
    code: 'forbidden',
  });
  policy.replace([]);
  assert.equal((await policy.granted(operator))('research', 'paper.get'), false);
});
