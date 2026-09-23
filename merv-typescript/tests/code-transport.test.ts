import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { check, createService, type Caller, type CodeCommitReceipt } from '@merv/contracts';
import type { Sessions, Session } from '@merv/sessions/types';
import type { CodeCommands } from '../packages/code-research/src/types.js';
import { CodeTransportService } from '../packages/code-research/src/transport.js';
// Loaded at top level so its cleanup hook belongs to the file, not to the first githubFixture test.
import './fixtures/state.js';
import { githubFixture, headOid, baseOid, treeOid } from './github-fixture.js';

async function setup(t: TestContext) {
  const f = await githubFixture(t);
  await f.enable();
  const control = {
    sessionId: 'session_fixture',
    runnerId: 'runner_fixture',
    hostRef: 'launch_fixture',
  };
  const session = {
    id: control.sessionId,
    projectId: f.project.id,
    runnerId: control.runnerId,
    hostRef: null,
    status: 'offered',
    execution: { policy: { readOnly: false, workspace: { mode: 'persistent', base: 'central' } } },
  } as unknown as Session;
  const sessions = {
    get: async (caller: Caller, id: string) => {
      await f.scope.require(caller, 'read');
      check(
        caller.actorId === f.caller.actorId && id === session.id,
        'session_forbidden',
        'Controller mismatch',
        403,
      );
      return session;
    },
  } as unknown as Sessions;
  const command = { id: 'codecmd_fixture', sessionId: control.sessionId, expectedHead: baseOid };
  const commands = {
    operation: async () => ({ command, status: 'dispatched', receipt: null }),
  } as unknown as CodeCommands;
  const service = await createService(
    new CodeTransportService(f.state, sessions, commands, f.github),
  );
  const receipt: CodeCommitReceipt = {
    commandId: command.id,
    repositoryId: 'github:101',
    workspaceId: 'workspace_fixture',
    baseOid,
    parentOid: baseOid,
    headOid,
    treeOid,
    stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
  };
  const fetchInput = { ...control, operation: 'fetch' as const };
  const pushInput = { ...control, operation: 'checkpoint' as const, receipt };
  const attach = () => {
    session.hostRef = control.hostRef;
    session.status = 'active';
    session.workspace = {
      attachment: {
        ...receipt,
        mode: 'persistent',
        branch: 'fixture',
      },
      result: null,
    };
  };
  return { ...f, service, session, fetchInput, pushInput, attach };
}

test('transport fences source/launch, pins repository authority and verifies remote objects before receipt completion', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.service.grant({ ...f.caller, session: { id: 'worker' } }, f.fetchInput), {
    code: 'session_forbidden',
  });
  await assert.rejects(f.service.grant(f.reviewer, f.fetchInput), { code: 'session_forbidden' });
  const caller = structuredClone(f.caller);
  const granting = f.service.grant(caller, f.fetchInput);
  caller.actorId = 'missing';
  const grant = await granting;
  assert.equal(grant.repositoryId, 'github:101');
  assert.equal(grant.target, null);
  f.attach();
  await assert.rejects(f.service.grant(f.caller, { ...f.pushInput, hostRef: 'different' }), {
    code: 'session_forbidden',
  });
  const push = await f.service.grant(f.caller, f.pushInput);
  assert.equal(push.target?.branch, 'merv/checkpoints/codecmd_fixture');
  const complete = { ...f.pushInput, commandId: f.pushInput.receipt.commandId };
  await assert.rejects(
    f.state.transaction((tx) => f.service.requireCheckpoint(complete, tx)),
    { code: 'github_push_required' },
  );
  f.branches.set(push.target!.branch, 'e'.repeat(40));
  await assert.rejects(f.service.verify(f.caller, f.pushInput), { code: 'github_push_mismatch' });
  f.branches.set(push.target!.branch, headOid);
  const verifier = structuredClone(f.caller);
  const verifying = f.service.verify(verifier, f.pushInput);
  verifier.actorId = 'missing';
  assert.deepEqual(await verifying, { verified: true });
  await f.state.transaction((tx) => f.service.requireCheckpoint(complete, tx));
  await assert.rejects(
    f.service.grant(f.caller, {
      ...f.pushInput,
      receipt: { ...f.pushInput.receipt, headOid: 'e'.repeat(40) },
    }),
    { code: 'github_conflict' },
  );
  const records = await f.state.read(async (sql) => [
    await sql.all('SELECT * FROM code_github_workspaces'),
    await sql.all('SELECT * FROM code_github_pushes'),
  ]);
  assert.equal(JSON.stringify(records).includes(push.token), false);
});

test('revocation during token mint revokes the undelivered token and relinking never retargets a workspace', async (t) => {
  const f = await setup(t);
  f.control.before = async (path) => {
    if (!path.includes('/access_tokens')) return;
    f.control.before = undefined;
    await f.github.disconnect(f.caller, { expectedRevision: 3 });
  };
  await assert.rejects(f.service.grant(f.caller, f.fetchInput), {
    code: 'github_automation_disabled',
  });
  assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.path === '/installation/token'));
});

test('read-only sessions cannot mint a write token; read-only automation cannot push', async (t) => {
  const f = await setup(t);
  await f.service.grant(f.caller, f.fetchInput);
  f.attach();
  f.session.execution.policy.readOnly = true;
  await assert.rejects(f.service.grant(f.caller, f.pushInput), { code: 'code_read_only' });
  assert.equal(
    f.calls.filter(
      (c) => c.path.includes('/access_tokens') && c.body.permissions.contents === 'write',
    ).length,
    0,
  );
});

test('the legacy transport route never lends a GitHub token to code.v2 work', async (t) => {
  const f = await setup(t);
  const policy = f.session.execution.policy.workspace!;
  assert.notEqual(policy.mode, 'none');
  Object.assign(policy, { driver: 'code.v2' });
  const before = f.calls.length;
  await assert.rejects(f.service.grant(f.caller, f.fetchInput), {
    code: 'code_transport_forbidden',
  });
  f.attach();
  await assert.rejects(f.service.grant(f.caller, f.pushInput), {
    code: 'code_transport_forbidden',
  });
  assert.equal(f.calls.length, before);
});
