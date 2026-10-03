import test from 'node:test';
import assert from 'node:assert/strict';
import { openState } from './fixtures/state.js';
import { CodeCommandService } from '../packages/code-work/src/commands.js';
import { CodeService } from '../packages/code-work/src/service.js';

test('completed legacy checkpoints replay exactly without reopening the retired transport', async () => {
  const state = await openState();
  const session = {
    id: 'session_review',
    projectId: 'project_review',
    runnerId: 'runner_review',
    hostRef: 'launch_review',
  };
  const caller = { projectId: session.projectId, actorId: 'actor_review' };
  const service = new CodeCommandService(state, {} as any, { get: async () => session } as any);
  await service.initialize();
  const a = 'a'.repeat(40);
  const command = {
    id: 'codecmd_review',
    projectId: session.projectId,
    sessionId: session.id,
    actorId: caller.actorId,
    instanceId: 'wf_review',
    expectedRevision: 0,
    runnerId: session.runnerId,
    hostRef: session.hostRef,
    expectedHead: a,
    message: 'original commit',
    createdAt: new Date().toISOString(),
    workspace: {
      repositoryId: 'github:123',
      workspaceId: 'workspace_review',
      mode: 'persistent',
      branch: 'merv/work/review',
      baseOid: a,
      headOid: a,
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    },
  };
  const receipt = {
    commandId: command.id,
    repositoryId: 'github:123',
    workspaceId: 'workspace_review',
    baseOid: a,
    parentOid: a,
    headOid: 'b'.repeat(40),
    treeOid: 'c'.repeat(40),
    stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
  };
  await state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status,receipt_json) VALUES(?,?,?,?,?,?,?,'succeeded',?)",
      command.id,
      session.projectId,
      session.id,
      caller.actorId,
      'original-request',
      'hash',
      JSON.stringify(command),
      JSON.stringify(receipt),
    ),
  );
  const input = {
    sessionId: session.id,
    runnerId: session.runnerId,
    hostRef: session.hostRef,
    commandId: command.id,
    receipt,
  };
  assert.equal((await service.completeCommand(caller, input)).status, 'succeeded');
  Object.assign(service, {
    storage: state,
    writerStore: { row: async () => ({ generation: 0 }), requireAdmitted: async () => {} },
  });
  const replay = (value: unknown) =>
    CodeService.prototype.completeCommand.call(service as unknown as CodeService, caller, value);
  assert.equal((await replay(input)).status, 'succeeded');
  await assert.rejects(replay({ ...input, hostRef: 'another_launch' }), {
    code: 'session_forbidden',
  });
  await assert.rejects(replay({ ...input, receipt: { ...receipt, headOid: 'd'.repeat(40) } }), {
    code: 'code_result_conflict',
  });
  const pending = { ...command, id: 'codecmd_pending' };
  await state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status) VALUES(?,?,?,?,?,?,?,'dispatched')",
      pending.id,
      session.projectId,
      session.id,
      caller.actorId,
      'pending-request',
      'hash',
      JSON.stringify(pending),
    ),
  );
  await assert.rejects(
    replay({ ...input, commandId: pending.id, receipt: { ...receipt, commandId: pending.id } }),
    { code: 'code_upload_required' },
  );
  await state.close();
});
