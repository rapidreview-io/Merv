import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Caller,
  CodeCommitCommand,
  CodeCommitReceipt,
  SessionWorkspace,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { createApp } from '../src/app.js';

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
            perBase: true,
            retain: true,
            advancesCentral: false,
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
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Capture history',
    actorName: 'Source',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'operator' | 'reader') => {
    const value = await app.ctx.scope.issueActor(source, { name: role, role });
    return {
      actorId: value.actor.id,
      projectId: value.actor.projectId,
      credentialId: value.credential.id,
    };
  };
  const reader = await issue('reader'),
    admin = await issue('operator');
  let sequence = 0;
  async function offer() {
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
    await app.ctx.sessions.attach(source, { ...control, workspace: attachment });
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
      return (
        await app.ctx.code.commit(worker.caller, {
          requestId,
          expectedHead,
          message: 'Retain exact source evidence',
        })
      ).command;
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
  assert.equal((await f.app.ctx.code.capture(f.reader, ref)).status, 'pending');
  await f.app.ctx.code.nextCommand(f.source, worker.control);
  assert.equal((await f.app.ctx.code.capture(f.reader, ref)).status, 'pending');
  await f.app.ctx.code.completeCommand(f.source, {
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  const expected = await f.app.ctx.code.capture(f.reader, ref);
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
  await f.app.ctx.code.nextCommand(f.source, worker.control);
  await f.app.ctx.code.completeCommand(f.source, {
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
    await f.app.ctx.code.capture(f.reader, ref),
    expected,
    'A later command/final result cannot replace this immutable commit',
  );
  await f.app.ctx.scope.revokeActor(f.admin, f.source.actorId);
  await f.app.ctx.domainEvents.drain();
  await assert.rejects(async () => await f.app.ctx.code.capture(f.source, ref), {
    code: 'forbidden',
  });
  assert.deepEqual(
    await f.app.ctx.code.capture(f.reader, ref),
    expected,
    'Historical reads use the reader authority, not the dead source',
  );
  await f.restart();
  const before = await f.snapshot();
  for (const method of ['get', 'list', 'describe'] as const)
    f.app.ctx.sessions[method] = (() => {
      throw new Error('Historical read must not reconcile a session');
    }) as never;
  f.app.ctx.workflows.assignment = async () => {
    throw new Error('Historical read must not render context');
  };
  f.app.ctx.artifacts.read = async () => {
    throw new Error('Capture metadata must not read artifact bytes');
  };
  const detached = await f.app.ctx.code.capture(f.reader, ref);
  detached.workspace!.headOid = oid('f');
  detached.workspace!.stats.filesChanged = 99;
  detached.provenance.source.actorId = 'changed';
  detached.ref.kind = 'session-final';
  assert.deepEqual(await f.app.ctx.code.capture(f.reader, ref), expected);
  assert.deepEqual(await f.snapshot(), before);
});

test('Failed, cancelled and undelivered command observations never claim a successful capture or advance command state', async (t) => {
  const f = await fixture(t);
  const failedWorker = await f.offer(),
    failed = await f.queue(failedWorker);
  const failedRef = { kind: 'code-commit' as const, commandId: failed.id };
  await f.app.ctx.code.nextCommand(f.source, failedWorker.control);
  await f.app.ctx.code.completeCommand(f.source, {
    ...failedWorker.control,
    commandId: failed.id,
    error: 'workspace_changed',
  });
  const failedCapture = await f.app.ctx.code.capture(f.reader, failedRef);
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
    (await f.app.ctx.code.capture(f.reader, cancelledRef)).status,
    'pending',
    'Observation does not cancel a queued command by itself',
  );
  assert.deepEqual(await f.snapshot(), pending);
  assert.equal(await f.app.ctx.code.nextCommand(f.source, cancelledWorker.control), null);
  const cancelledCapture = await f.app.ctx.code.capture(f.reader, cancelledRef);
  assert.equal(cancelledCapture.status, 'failed');
  assert.equal(cancelledCapture.workspace, null);
  assert.equal(cancelledCapture.error, 'session_closed');
  const before = await f.snapshot();
  assert.deepEqual(await f.app.ctx.code.capture(f.reader, failedRef), failedCapture);
  assert.deepEqual(await f.app.ctx.code.capture(f.reader, cancelledRef), cancelledCapture);
  assert.deepEqual(await f.snapshot(), before);
});

test('Capture reads compose with an existing transaction and retain legacy final reports without inventing a tree OID', async (t) => {
  const f = await fixture(t),
    worker = await f.offer(),
    command = await f.queue(worker);
  const ref = { kind: 'code-commit' as const, commandId: command.id };
  await f.app.ctx.code.nextCommand(f.source, worker.control);
  const before = await f.snapshot();
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(async (tx) => {
        await f.app.ctx.code.completeCommand(f.source, {
          ...worker.control,
          commandId: command.id,
          receipt: receipt(command),
        });
        assert.equal((await f.app.ctx.code.capture(f.reader, ref, tx)).status, 'ready');
        throw new Error('rollback observation transaction');
      }),
    /rollback observation transaction/,
  );
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.app.ctx.code.capture(f.reader, ref)).status, 'pending');
  const other = new SqliteState(':memory:');
  try {
    await other.transaction(
      async (tx) =>
        await assert.rejects(async () => await f.app.ctx.code.capture(f.reader, ref, tx), {
          code: 'invalid_transaction',
        }),
    );
  } finally {
    await other.close();
  }
  await f.app.ctx.code.completeCommand(f.source, {
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  await f.app.ctx.sessions.release(f.source, {
    sessionId: worker.session.id,
    runnerId: worker.control.runnerId,
  });
  const legacy = { ...attachment, headOid: oid('b'), stats: receipt(command).stats };
  await f.app.ctx.sessions.workspaceResult(f.source, { ...worker.control, workspace: legacy });
  const result = await f.app.ctx.code.capture(f.reader, {
    kind: 'session-final',
    sessionId: worker.session.id,
  });
  assert.deepEqual(result.workspace, legacy);
  assert.equal(
    Object.hasOwn(result.workspace!, 'treeOid'),
    false,
    'A commit tree must not be guessed onto a legacy final report',
  );
  assert.equal(Object.hasOwn(result, 'parentOid'), false);
});

test('Capture lookup is tenant scoped, rechecks readers, and rejects mismatched command/session provenance', async (t) => {
  const f = await fixture(t),
    worker = await f.offer(),
    command = await f.queue(worker);
  await f.app.ctx.code.nextCommand(f.source, worker.control);
  await f.app.ctx.code.completeCommand(f.source, {
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  const ref = { kind: 'code-commit' as const, commandId: command.id };
  const foreign = await f.app.ctx.scope.bootstrap({
    projectName: 'Foreign',
    actorName: 'Foreign operator',
  });
  const caller = {
    actorId: foreign.actor.id,
    projectId: foreign.project.id,
    credentialId: foreign.credential.id,
  };
  const before = await f.snapshot();
  await assert.rejects(async () => await f.app.ctx.code.capture(caller, ref), {
    code: 'code_capture_not_found',
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.code.capture(f.reader, { ...ref, actorId: worker.caller.actorId } as never),
    { code: 'invalid_code_input' },
  );
  const observe = f.app.ctx.sessions.workspaceObservation.bind(f.app.ctx.sessions);
  f.app.ctx.sessions.workspaceObservation = async (...args) => {
    const observation = await observe(...args);
    observation.provenance.actorId = f.source.actorId;
    return observation;
  };
  await assert.rejects(async () => await f.app.ctx.code.capture(f.reader, ref), {
    code: 'code_capture_provenance',
  });
  f.app.ctx.sessions.workspaceObservation = observe;
  assert.equal(
    (await f.app.ctx.code.capture(f.reader, ref)).provenance.actorId,
    worker.caller.actorId,
  );
  assert.deepEqual(await f.snapshot(), before);
  await f.app.ctx.scope.revokeCredential(f.admin, f.reader.credentialId);
  await assert.rejects(async () => await f.app.ctx.code.capture(f.reader, ref), {
    code: 'forbidden',
  });
  f.app.ctx.code.close();
  await assert.rejects(async () => await f.app.ctx.code.capture(f.admin, ref), {
    code: 'code_unavailable',
  });
});
