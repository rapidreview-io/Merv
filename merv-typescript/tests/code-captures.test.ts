import type {
  Caller,
  CodeCommitCommand,
  CodeCommitReceipt,
  SessionWorkspace,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { admitUpload } from './fixtures/admitted-upload.js';
import { createApp } from './fixtures/app.js';

const oid = (digit: string) => digit.repeat(40);
const attachment: SessionWorkspace = {
  repositoryId: 'capture_repository',
  workspaceId: 'capture_workspace',
  mode: 'persistent',
  branch: 'codex/merv/capture',
  baseOid: oid('a'),
  headOid: oid('a'),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};
const receipt = (command: CodeCommitCommand, head = 'b'): CodeCommitReceipt => ({
  commandId: command.id,
  repositoryId: command.workspace.repositoryId,
  workspaceId: command.workspace.workspaceId,
  baseOid: command.workspace.baseOid,
  parentOid: command.expectedHead,
  headOid: oid(head),
  treeOid: oid('c'),
  stats: { commitCount: 1, filesChanged: 1, insertions: 2, deletions: 0 },
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-captures-'));
  let app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const definition: WorkflowDefinition = {
    name: 'capture-reader-test',
    version: 1,
    initial: 'work',
    states: ['work', 'done'],
    terminal: ['done'],
    edges: [{ action: 'finish', from: 'work', to: 'done' }],
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['work'],
        transitions: ['finish'],
        tool: 'fixture.finish',
        instruction: 'Finish',
        check: async ({ caller, tx }) => {
          await app.ctx.scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'work',
        check: async () => {},
        build: async () => ({
          role: 'producer',
          label: 'Capture work',
          brief: 'Record code.',
          references: [],
          handoff: { instruction: 'Finish', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: [
            { name: 'code.commit', alternatives: [{}] },
            { name: 'code.operation', alternatives: [{}] },
          ],
          workspace: {
            mode: 'persistent',
            namespace: 'capture',
            base: 'reference:code',
            perBase: false,
            retain: true,
            advancesCentral: false,
            driver: 'code.v2',
          },
        },
        references: () => ({ code: oid('a') }),
        lease: {
          role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
          acquire: async () => ({}),
          check: async () => {},
          release: async () => {},
        },
      },
    ],
  };
  let handle = await app.ctx.workflows.register(definition, policy);
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Capture history',
    actorName: 'Source',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'operator' | 'reader') => {
    const value = await app.ctx.scope.credentials.issueActor(source, { name: role, role });
    return {
      actorId: value.actor.id,
      projectId: value.actor.projectId,
      credentialId: value.credential.id,
    };
  };
  const reader = await issue('reader'),
    admin = await issue('operator');
  // The runner offered the work advertises the driver its workspace names.
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'capture-runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
  let sequence = 0;
  async function offer(attach = true) {
    const instance = await handle.start(source, {
      workflow: definition.name,
      requestId: `instance-${++sequence}`,
    });
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await app.ctx.sessions.offer(source, {
      instanceId: instance.id,
      expectedRevision: 0,
      runnerId: 'capture-runner',
      requestId: `offer-${sequence}`,
      secret,
    });
    const control = {
      sessionId: session.id,
      runnerId: session.runnerId,
      hostRef: `launch-${sequence}`,
    };
    if (attach) await app.ctx.sessions.attach(source, { ...control, workspace: attachment });
    return { session, control, caller: await app.ctx.sessions.authenticate(secret) };
  }
  return {
    get app() {
      return app;
    },
    source,
    reader,
    admin,
    offer,
    async queue(
      worker: Awaited<ReturnType<typeof offer>>,
      requestId = 'commit',
      expectedHead = oid('a'),
    ) {
      // Seed historical evidence directly. The current runtime cannot queue or execute it.
      const command: CodeCommitCommand = {
        id: `codecmd_${randomBytes(12).toString('hex')}`,
        projectId: source.projectId,
        sessionId: worker.session.id,
        actorId: worker.caller.actorId,
        instanceId: worker.session.instanceId,
        expectedRevision: 0,
        runnerId: worker.control.runnerId,
        hostRef: worker.control.hostRef,
        workspace: attachment,
        expectedHead,
        message: 'Retain exact source evidence',
        createdAt: new Date().toISOString(),
      };
      await app.ctx.state.transaction((tx) =>
        tx.run(
          "INSERT INTO code_commands(id,project_id,session_id,actor_id,request_id,input_hash,command_json,status) VALUES(?,?,?,?,?,'historical',?,'queued')",
          command.id,
          command.projectId,
          command.sessionId,
          command.actorId,
          requestId,
          JSON.stringify(command),
        ),
      );
      return command;
    },
    async complete(input: {
      commandId: string;
      receipt?: CodeCommitReceipt;
      error?: string;
      cancelled?: boolean;
    }) {
      await app.ctx.state.transaction(async (tx) => {
        if (!input.cancelled)
          await tx.run("UPDATE code_commands SET status='dispatched' WHERE id=?", input.commandId);
        const status = input.cancelled ? 'cancelled' : input.receipt ? 'succeeded' : 'failed';
        await tx.run(
          'UPDATE code_commands SET status=?,receipt_json=?,error=? WHERE id=?',
          status,
          input.receipt ? JSON.stringify(input.receipt) : null,
          input.error ?? null,
          input.commandId,
        );
        await app.ctx.state.appendEvent(tx, {
          projectId: source.projectId,
          actorId: source.actorId,
          type: `code.command_${status}`,
          subjectId: input.commandId,
          data: {},
        });
      });
    },
    snapshot: async () =>
      await app.ctx.state.read(async (sql) => ({
        sessions: await sql.all('SELECT * FROM worker_sessions ORDER BY id'),
        workspaces: await sql.all('SELECT * FROM session_workspaces ORDER BY session_id'),
        commands: await sql.all('SELECT * FROM code_commands ORDER BY id'),
        events: await app.ctx.state.eventHead(),
      })),
    async restart() {
      await app.stop();
      app = await createApp({ directory, api: false });
      handle = await app.ctx.workflows.register(definition, policy);
    },
  };
}

test('Exact command captures retain historical parent/head/tree/provenance after subsequent commits, source death and restart', async (t) => {
  const f = await fixture(t),
    worker = await f.offer(),
    command = await f.queue(worker);
  const ref = { kind: 'code-commit' as const, commandId: command.id };
  assert.equal((await f.app.ctx.codeWork.capture(f.reader, ref)).status, 'pending');
  assert.equal((await f.app.ctx.codeWork.capture(f.reader, ref)).status, 'pending');
  const source = { ...f.source };
  await admitUpload(f.app.ctx.state, command, receipt(command));
  const completing = f.complete({
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  source.actorId = 'missing';
  await completing;
  const expected = await f.app.ctx.codeWork.capture(f.reader, ref);
  assert.equal(expected.status, 'ready');
  assert.deepEqual(expected.workspace, {
    ...attachment,
    headOid: oid('b'),
    treeOid: oid('c'),
    stats: receipt(command).stats,
  });
  assert.equal(expected.parentOid, command.expectedHead);
  assert.deepEqual(expected.provenance, {
    projectId: f.source.projectId,
    sessionId: worker.session.id,
    actorId: worker.caller.actorId,
    // Who delegated, without the credential they held.
    source: {
      kind: worker.session.source.kind,
      actorId: worker.session.source.actorId,
      projectId: worker.session.source.projectId,
    },
    instanceId: worker.session.instanceId,
    revision: 0,
    workflow: {
      name: worker.session.execution.workflow,
      version: worker.session.execution.version,
      state: worker.session.execution.state,
      policyHash: worker.session.execution.policyHash,
      registrationId: worker.session.execution.registrationId,
    },
    runnerId: worker.control.runnerId,
    hostRef: worker.control.hostRef,
    readOnly: false,
  });
  const event = (await f.app.ctx.state.events(f.source.projectId)).find(
    (event) => event.type === 'code.command_succeeded' && event.subjectId === command.id,
  )!;
  assert.equal(expected.eventId, event.id);
  assert.equal(expected.observedAt, event.createdAt);
  const second = await f.queue(worker, 'second', oid('b'));
  await admitUpload(f.app.ctx.state, second, receipt(second, 'd'));
  await f.complete({
    ...worker.control,
    commandId: second.id,
    receipt: receipt(second, 'd'),
  });
  const final = {
    ...attachment,
    headOid: oid('d'),
    treeOid: oid('e'),
    stats: { commitCount: 2, filesChanged: 2, insertions: 4, deletions: 0 },
  };
  await f.app.ctx.sessions.release(f.source, {
    sessionId: worker.session.id,
    runnerId: worker.control.runnerId,
  });
  await f.app.ctx.sessions.workspaceResult(f.source, { ...worker.control, workspace: final });
  assert.deepEqual(
    await f.app.ctx.codeWork.capture(f.reader, ref),
    expected,
    'A later command/final result cannot replace this immutable commit',
  );
  await f.app.ctx.scope.credentials.revokeActor(f.admin, f.source.actorId);
  await f.app.ctx.domainEvents.drain();
  await assert.rejects(async () => await f.app.ctx.codeWork.capture(f.source, ref), {
    code: 'forbidden',
  });
  assert.deepEqual(
    await f.app.ctx.codeWork.capture(f.reader, ref),
    expected,
    'Historical reads use the reader authority, not the dead source',
  );
  await f.restart();
  const before = await f.snapshot();
  for (const method of ['get', 'list', 'session'] as const)
    f.app.ctx.sessions[method] = (() => {
      throw new Error('Historical read must not reconcile a session');
    }) as never;
  f.app.ctx.workflows.assignment = async () => {
    throw new Error('Historical read must not render context');
  };
  f.app.ctx.artifacts.read = async () => {
    throw new Error('Capture metadata must not read artifact bytes');
  };
  const detached = await f.app.ctx.codeWork.capture(f.reader, ref);
  detached.workspace!.headOid = oid('f');
  detached.workspace!.stats.filesChanged = 99;
  detached.provenance.source.actorId = 'changed';
  detached.ref.kind = 'session-final';
  assert.deepEqual(await f.app.ctx.codeWork.capture(f.reader, ref), expected);
  assert.deepEqual(await f.snapshot(), before);
});

test('Failed, cancelled and undelivered command observations never claim a successful capture or advance command state', async (t) => {
  const f = await fixture(t);
  const failedWorker = await f.offer(),
    failed = await f.queue(failedWorker);
  const failedRef = { kind: 'code-commit' as const, commandId: failed.id };
  await f.complete({
    ...failedWorker.control,
    commandId: failed.id,
    error: 'workspace_changed',
  });
  const failedCapture = await f.app.ctx.codeWork.capture(f.reader, failedRef);
  assert.equal(failedCapture.status, 'failed');
  assert.equal(failedCapture.workspace, null);
  assert.equal(failedCapture.error, 'workspace_changed');
  const cancelledWorker = await f.offer(),
    cancelled = await f.queue(cancelledWorker);
  const cancelledRef = { kind: 'code-commit' as const, commandId: cancelled.id };
  await f.app.ctx.sessions.release(f.source, {
    sessionId: cancelledWorker.session.id,
    runnerId: cancelledWorker.control.runnerId,
  });
  const pending = await f.snapshot();
  assert.equal(
    (await f.app.ctx.codeWork.capture(f.reader, cancelledRef)).status,
    'pending',
    'Observation does not cancel a queued command by itself',
  );
  assert.deepEqual(await f.snapshot(), pending);
  await f.complete({ commandId: cancelled.id, cancelled: true, error: 'session_closed' });
  const cancelledCapture = await f.app.ctx.codeWork.capture(f.reader, cancelledRef);
  assert.equal(cancelledCapture.status, 'failed');
  assert.equal(cancelledCapture.workspace, null);
  assert.equal(cancelledCapture.error, 'session_closed');
  const before = await f.snapshot();
  assert.deepEqual(await f.app.ctx.codeWork.capture(f.reader, failedRef), failedCapture);
  assert.deepEqual(await f.app.ctx.codeWork.capture(f.reader, cancelledRef), cancelledCapture);
  assert.deepEqual(await f.snapshot(), before);
});

test('A final capture of a session halted before any host attached is failed, not pending forever', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer(false);
  const ref = { kind: 'session-final' as const, sessionId: session.id };
  const unattached = await f.app.ctx.codeWork.capture(f.reader, ref);
  assert.equal(unattached.status, 'pending');
  assert.equal(
    Object.hasOwn(unattached, 'attachedBaseOid'),
    false,
    'A session no runner attached worked from no commit',
  );
  await f.app.ctx.sessions.dispatch.halt(f.source, { sessionId: session.id });
  assert.equal((await f.app.ctx.codeWork.capture(f.reader, ref)).status, 'failed');
});

test('Capture lookup is tenant scoped, rechecks readers, and rejects mismatched command/session provenance', async (t) => {
  const f = await fixture(t),
    worker = await f.offer(),
    command = await f.queue(worker);
  await admitUpload(f.app.ctx.state, command, receipt(command));
  await f.complete({
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  const ref = { kind: 'code-commit' as const, commandId: command.id };
  const foreign = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Foreign',
    actorName: 'Foreign operator',
  });
  const caller = {
    actorId: foreign.actor.id,
    projectId: foreign.project.id,
    credentialId: foreign.credential.id,
  };
  const before = await f.snapshot();
  await assert.rejects(async () => await f.app.ctx.codeWork.capture(caller, ref), {
    code: 'code_capture_not_found',
  });
  for (const target of [ref, { kind: 'session-final' as const, sessionId: worker.session.id }]) {
    await t.test(target.kind, async () => {
      const source = { ...caller };
      const pending = f.app.ctx.codeWork.capture(source, target);
      Object.assign(source, f.reader);
      await assert.rejects(pending, {
        code: target.kind === 'code-commit' ? 'code_capture_not_found' : 'session_not_found',
      });
    });
  }
  await assert.rejects(
    async () =>
      await f.app.ctx.codeWork.capture(f.reader, {
        ...ref,
        actorId: worker.caller.actorId,
      } as never),
    { code: 'invalid_code_input' },
  );
  const observe = f.app.ctx.sessions.workspaceObservation.bind(f.app.ctx.sessions);
  f.app.ctx.sessions.workspaceObservation = async (...args) => {
    const observation = await observe(...args);
    observation.provenance.actorId = f.source.actorId;
    return observation;
  };
  await assert.rejects(async () => await f.app.ctx.codeWork.capture(f.reader, ref), {
    code: 'code_capture_provenance',
  });
  f.app.ctx.sessions.workspaceObservation = observe;
  assert.equal(
    (await f.app.ctx.codeWork.capture(f.reader, ref)).provenance.actorId,
    worker.caller.actorId,
  );
  assert.deepEqual(await f.snapshot(), before);
  await f.app.ctx.scope.credentials.revokeCredential(f.admin, f.reader.credentialId);
  await assert.rejects(async () => await f.app.ctx.codeWork.capture(f.reader, ref), {
    code: 'forbidden',
  });
  f.app.ctx.codeWork.close();
  await assert.rejects(async () => await f.app.ctx.codeWork.capture(f.admin, ref), {
    code: 'code_unavailable',
  });
});
