import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeCommandRecord, CodeCommitCommand, CodeCommitReceipt } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { RunnerClient } from '../packages/runner/src/client.js';

const bearer = `mk_${'k'.repeat(43)}`;
const workspace = {
  repositoryId: 'repository_fixture',
  workspaceId: 'workspace_fixture',
  mode: 'persistent' as const,
  branch: 'codex/work',
  baseOid: '1'.repeat(40),
  headOid: '1'.repeat(40),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};
// This client consumes only the authenticated lease identity and its pinned attachment.
const session = {
  id: 'session_fixture',
  projectId: 'project_fixture',
  actorId: 'worker_fixture',
  instanceId: 'instance_fixture',
  expectedRevision: 3,
  runnerId: 'runner_fixture',
  hostRef: 'launch_fixture',
  status: 'active',
  workspace: { attachment: workspace, result: null },
} as Session;
const command: CodeCommitCommand = {
  id: 'command_fixture',
  projectId: session.projectId,
  sessionId: session.id,
  actorId: session.actorId,
  instanceId: session.instanceId,
  expectedRevision: session.expectedRevision,
  runnerId: session.runnerId,
  hostRef: session.hostRef!,
  workspace,
  expectedHead: workspace.headOid,
  message: 'Create a reviewed code snapshot',
  createdAt: '2026-09-15T00:00:00.000Z',
};
const receipt: CodeCommitReceipt = {
  commandId: command.id,
  repositoryId: workspace.repositoryId,
  workspaceId: workspace.workspaceId,
  baseOid: workspace.baseOid,
  parentOid: command.expectedHead,
  headOid: '2'.repeat(40),
  treeOid: '3'.repeat(40),
  stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
};
const succeeded: CodeCommandRecord = { command, status: 'succeeded', receipt, error: null };
const failed: CodeCommandRecord = {
  command,
  status: 'failed',
  receipt: null,
  error: 'workspace_head_conflict',
};
const invalid = { code: 'invalid_control_response', status: 0 };
const client = (value: unknown) =>
  new RunnerClient('https://merv.example', session.projectId, bearer, async () =>
    Response.json(value),
  );

test('Code command replies bind project, lease, worker, revision, runner, host and the complete workspace attachment', async () => {
  const source = structuredClone(session);
  const pending = client({ command }).nextCodeCommand(source, command.hostRef);
  source.id = 'session_other';
  source.workspace!.attachment.stats.insertions = 1;
  assert.deepEqual(await pending, command);
  assert.equal(await client({ command: null }).nextCodeCommand(session, command.hostRef), null);
  for (const patch of [
    { projectId: 'project_other' },
    { sessionId: 'session_other' },
    { actorId: 'worker_other' },
    { instanceId: 'instance_other' },
    { expectedRevision: command.expectedRevision + 1 },
    { runnerId: 'runner_other' },
    { hostRef: 'launch_other' },
    { workspace: { ...workspace, repositoryId: 'repository_other' } },
    { workspace: { ...workspace, workspaceId: 'workspace_other' } },
    { workspace: { ...workspace, baseOid: '4'.repeat(40) } },
    { workspace: { ...workspace, headOid: '4'.repeat(40) } },
    { workspace: { ...workspace, branch: 'codex/other' } },
    { workspace: { ...workspace, mode: 'ephemeral', branch: null } },
    { workspace: { ...workspace, stats: { ...workspace.stats, filesChanged: 1 } } },
  ])
    await assert.rejects(
      async () =>
        client({ command: { ...command, ...patch } }).nextCodeCommand(session, command.hostRef),
      invalid,
      JSON.stringify(patch),
    );
  await assert.rejects(
    async () =>
      client({ command }).nextCodeCommand({ ...session, workspace: undefined }, command.hostRef),
    invalid,
  );
  // Subsequent commits may start from a newer HEAD; the local manager verifies it by CAS.
  const subsequent = { ...command, expectedHead: '5'.repeat(40) };
  assert.deepEqual(
    await client({ command: subsequent }).nextCodeCommand(session, command.hostRef),
    subsequent,
  );
});

test('malformed Code commands never reach the continuation that performs a local Git operation', async () => {
  const malformed = [
    null,
    {},
    [],
    { command: [] },
    { command: 'text' },
    { command: { ...command, executable: '/bin/sh' } },
    { command: { ...command, args: ['-c', 'unexpected'] } },
    { command: { ...command, path: '/tmp/other-checkout' } },
    { command: { ...command, env: { PATH: '/tmp' } } },
    { command: { ...command, status: 'cancelled' } },
    { command: { ...command, id: '../outside' } },
    { command: { ...command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 } },
    { command: { ...command, expectedHead: 'not-an-oid' } },
    { command: { ...command, expectedHead: '4'.repeat(64) } },
    { command: { ...command, message: '\0bad' } },
    { command: { ...command, message: 'x'.repeat(2001) } },
    { command: { ...command, createdAt: 'not-a-date' } },
    { command: { ...command, workspace: { ...workspace, path: '/tmp/escape' } } },
  ];
  let operations = 0;
  for (const body of malformed)
    await assert.rejects(async () => {
      const admitted = await client(body).nextCodeCommand(session, command.hostRef);
      if (admitted) operations++;
    }, invalid);
  assert.equal(operations, 0);
});

test('Code completion must acknowledge the exact command and successful receipt before local acknowledgement', async () => {
  const input = structuredClone(command),
    outcome = { receipt: structuredClone(receipt) };
  const pending = client({ operation: succeeded }).completeCodeCommand(input, outcome);
  input.id = 'command_other';
  outcome.receipt.stats.insertions = 2;
  assert.deepEqual(await pending, succeeded);
  const wrongCommands = [
    { ...command, id: 'command_other' },
    { ...command, projectId: 'project_other' },
    { ...command, sessionId: 'session_other' },
    { ...command, actorId: 'worker_other' },
    { ...command, instanceId: 'instance_other' },
    { ...command, expectedRevision: 4 },
    { ...command, hostRef: 'launch_other' },
    { ...command, runnerId: 'runner_other' },
    { ...command, message: 'A different operation' },
    { ...command, expectedHead: '4'.repeat(40) },
    { ...command, workspace: { ...workspace, repositoryId: 'repository_other' } },
  ];
  const wrongReceipts = [
    { ...receipt, commandId: 'command_other' },
    { ...receipt, repositoryId: 'repository_other' },
    { ...receipt, workspaceId: 'workspace_other' },
    { ...receipt, baseOid: '4'.repeat(40) },
    { ...receipt, parentOid: '4'.repeat(40) },
    { ...receipt, headOid: '4'.repeat(40) },
    { ...receipt, treeOid: '4'.repeat(40) },
    { ...receipt, stats: { ...receipt.stats, insertions: 2 } },
  ];
  let acknowledgements = 0;
  for (const operation of [
    ...wrongCommands.map((command) => ({ ...succeeded, command })),
    ...wrongReceipts.map((receipt) => ({ ...succeeded, receipt })),
    { ...succeeded, error: 'unexpected_error' },
    { ...succeeded, receipt: null },
    { ...succeeded, extra: true },
    { ...succeeded, status: 'failed', receipt: null, error: 'workspace_head_conflict' },
    { ...succeeded, status: 'cancelled', receipt: null, error: 'cancelled' },
    { ...succeeded, status: 'queued', receipt: null },
    { ...succeeded, status: 'dispatched', receipt: null },
  ])
    await assert.rejects(async () => {
      await client({ operation }).completeCodeCommand(command, { receipt });
      acknowledgements++;
    }, invalid);
  assert.equal(acknowledgements, 0);
});

test('Code failure acknowledgement must match the local terminal error, never a success, cancellation or pending operation', async () => {
  const outcome = { error: failed.error! };
  const input = { ...outcome };
  const pending = client({ operation: failed }).completeCodeCommand(command, input);
  input.error = 'changed_error';
  assert.deepEqual(await pending, failed);
  for (const operation of [
    succeeded,
    { ...failed, error: 'different_error' },
    { ...failed, error: null },
    { ...failed, error: 'unbounded raw error text' },
    { ...failed, receipt },
    { ...failed, status: 'cancelled' },
    { ...failed, status: 'queued', error: null },
    { ...failed, status: 'dispatched', error: null },
  ])
    await assert.rejects(
      async () => client({ operation }).completeCodeCommand(command, outcome),
      invalid,
    );
  for (const body of [null, [], {}, { operation: null }, { operation: 'acknowledged' }])
    await assert.rejects(async () => client(body).completeCodeCommand(command, outcome), invalid);
});

test('transport grants cannot match a push target changed while the request is pending', async () => {
  const grant = {
    repositoryId: 'github:101',
    repository: 'fixture/private',
    revision: 1,
    baseBranch: 'main',
    baseOid: receipt.baseOid,
    target: { branch: 'codex/push', headOid: receipt.headOid, treeOid: receipt.treeOid },
    token: 'synthetic-token',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  for (const changedReply of [false, true]) {
    const input = {
      sessionId: session.id,
      runnerId: session.runnerId,
      hostRef: command.hostRef,
      operation: 'checkpoint' as const,
      receipt: structuredClone(receipt),
    };
    const reply = structuredClone(grant);
    if (changedReply) reply.target.headOid = '4'.repeat(40);
    const pending = client(reply).transportGrant(input);
    input.receipt.headOid = '4'.repeat(40);
    if (changedReply) await assert.rejects(pending, invalid);
    else assert.deepEqual(await pending, grant);
  }
});

test('Code controls send only the bound control fields and keep the source bearer out of their bodies', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const connection = new RunnerClient(
    'https://merv.example',
    session.projectId,
    bearer,
    async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json(String(url).endsWith('/next') ? { command } : { operation: succeeded });
    },
  );
  await connection.nextCodeCommand(session, command.hostRef);
  await connection.completeCodeCommand(command, { receipt });
  assert.deepEqual(
    requests.map((value) => value.url),
    ['https://merv.example/code/commands/next', 'https://merv.example/code/commands/complete'],
  );
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    sessionId: session.id,
    runnerId: session.runnerId,
    hostRef: command.hostRef,
  });
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    sessionId: session.id,
    runnerId: session.runnerId,
    hostRef: command.hostRef,
    commandId: command.id,
    receipt,
  });
  for (const { init } of requests) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${bearer}`);
    assert.equal(headers.get('x-merv-project-id'), session.projectId);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(String(init.body).includes(bearer), false);
  }
});
