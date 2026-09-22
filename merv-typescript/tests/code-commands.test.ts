import { migratePendingMerges, pinMerge } from '../packages/code/src/pending-merge.js';
import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Caller,
  type CodeCommitCommand,
  type CodeCommitInput,
  type CodeCommitReceipt,
  type SessionWorkspace,
  type WorkflowPolicy,
} from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeCommandService } from '../packages/code-research/src/commands.js';

const oid = (digit: string) => digit.repeat(40);
const input = (requestId = 'commit'): CodeCommitInput => ({
  requestId,
  expectedHead: oid('a'),
  message: 'Capture an independently reviewable implementation',
});
const workspace: SessionWorkspace = {
  repositoryId: 'repository',
  workspaceId: 'workspace',
  mode: 'persistent',
  branch: 'codex/merv/work',
  baseOid: oid('a'),
  headOid: oid('a'),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};
const receipt = (command: CodeCommitCommand): CodeCommitReceipt => ({
  commandId: command.id,
  repositoryId: command.workspace.repositoryId,
  workspaceId: command.workspace.workspaceId,
  baseOid: command.workspace.baseOid,
  parentOid: command.expectedHead,
  headOid: oid('b'),
  treeOid: oid('c'),
  stats: { commitCount: 1, filesChanged: 2, insertions: 3, deletions: 4 },
});

async function fixture(
  t: TestContext,
  options: {
    readOnly?: boolean;
    scratch?: boolean;
    grant?: boolean;
    fixedMessage?: string;
    merge?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-commands-'));
  let clock = Date.now(),
    builds = 0,
    poisoned = false;
  let state: SqliteState,
    scope: ProjectScope,
    workflows: WorkflowsService,
    events: DurableEvents,
    sessions: LeasedSessions,
    code: CodeCommandService;
  const definition = {
    name: 'code-commands-test',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const policy = (): WorkflowPolicy => ({
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'read', tx);
        },
        build: async () => {
          builds++;
          if (poisoned) throw new Error('Commands must not rebuild context');
          return {
            role: 'producer',
            label: 'Code work',
            brief: 'Implement and checkpoint.',
            references: [],
            handoff: { instruction: 'Finish.', tools: [] },
            execution: { readOnly: options.readOnly ?? false, tools: [] },
            context: null,
          };
        },
        execution: {
          readOnly: options.readOnly ?? false,
          tools: [
            ...(options.grant === false
              ? []
              : [
                  {
                    name: 'code.commit',
                    alternatives: [
                      options.fixedMessage
                        ? { message: { kind: 'literal' as const, value: options.fixedMessage } }
                        : {},
                    ],
                  },
                ]),
            { name: 'code.operation', alternatives: [{}] },
            ...(options.merge ? [{ name: 'code.merge', alternatives: [{}] }] : []),
          ],
          workspace: options.scratch
            ? { mode: 'none' }
            : {
                mode: 'persistent',
                namespace: 'commands',
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
  });
  let handle: Awaited<ReturnType<WorkflowsService['register']>>;
  const open = async () => {
    state = new SqliteState(join(directory, 'state.sqlite'));
    scope = await createService(new ProjectScope(state, () => clock));
    workflows = await createService(new WorkflowsService(state, scope));
    events = await createService(new DurableEvents(state));
    handle = await workflows.register(definition, policy());
    sessions = await createService(
      new LeasedSessions(state, scope, workflows, events, {
        clock: () => clock,
        sweepIntervalMs: 60_000,
      }),
    );
    code = await createService(new CodeCommandService(state, scope, sessions));
  };
  const close = async () => {
    code.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
  };
  await open();
  const boot = await scope!.bootstrap({ projectName: 'Code', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const offer = async () => {
    const instance = await handle.start(source, {
      workflow: definition.name,
      requestId: randomBytes(10).toString('hex'),
    });
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId: instance.id,
      expectedRevision: 0,
      runnerId: 'runner',
      requestId: randomBytes(10).toString('hex'),
      secret,
    });
    const control = { sessionId: session.id, runnerId: 'runner', hostRef: 'launch' };
    const attach = async () =>
      await sessions.attach(source, {
        ...control,
        ...(options.scratch
          ? {}
          : {
              workspace: {
                ...workspace,
                ...(options.merge
                  ? {
                      pendingMerge: {
                        plan: 'd'.repeat(64),
                        firstParent: oid('a'),
                        secondParent: oid('f'),
                        checkpoint: oid('a'),
                        firstMerge: null,
                      },
                    }
                  : {}),
              },
            }),
      });
    return {
      session,
      control,
      secret,
      attach,
      activate: async () => await sessions.authenticate(secret),
    };
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    get sessions() {
      return sessions;
    },
    get code() {
      return code;
    },
    source,
    offer,
    async ready() {
      const lease = await offer();
      await lease.attach();
      return { ...lease, caller: await lease.activate() };
    },
    events: async (type?: string) =>
      (await state.events(source.projectId)).filter((event) =>
        type ? event.type === `code.command_${type}` : event.type.startsWith('code.command_'),
      ),
    get builds() {
      return builds;
    },
    poison() {
      poisoned = true;
    },
    advance(ms: number) {
      clock += ms;
    },
    async restart() {
      await close();
      await open();
    },
  };
}

test('requests and dispatch are durable, detached, single outstanding and replay current progress', async (t) => {
  const f = await fixture(t),
    worker = await f.ready();
  f.poison();
  const beforeBuilds = f.builds;
  const request = input();
  const caller = structuredClone(worker.caller);
  const pending = f.code.commit(caller, request);
  caller.actorId = 'missing';
  caller.session!.id = 'missing';
  const queued = await pending;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.command.actorId, worker.caller.actorId);
  assert.equal(queued.command.sessionId, worker.session.id);
  assert.deepEqual(queued.command.workspace, workspace);
  request.message = 'mutated input';
  queued.command.message = 'mutated result';
  assert.equal((await f.code.commit(worker.caller, input())).command.message, input().message);
  await assert.rejects(
    async () => await f.code.commit(worker.caller, { ...input(), message: 'different' }),
    {
      code: 'code_request_conflict',
    },
  );
  await assert.rejects(async () => await f.code.commit(worker.caller, input('another')), {
    code: 'code_command_pending',
  });
  const dispatched = (await f.code.nextCommand(f.source, worker.control))!;
  assert.equal(dispatched.message, input().message);
  assert.deepEqual(await f.code.nextCommand(f.source, worker.control), dispatched);
  assert.equal((await f.code.commit(worker.caller, input())).status, 'dispatched');
  const result = await f.code.completeCommand(f.source, {
    ...worker.control,
    commandId: dispatched.id,
    receipt: receipt(dispatched),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal((await f.code.commit(worker.caller, input())).status, 'succeeded');
  assert.equal(await f.code.nextCommand(f.source, worker.control), null);
  assert.equal(
    (await f.code.commit(worker.caller, { ...input('next'), expectedHead: oid('b') })).status,
    'queued',
  );
  assert.deepEqual(
    (await f.events()).map((event) => event.type),
    [
      'code.command_queued',
      'code.command_dispatched',
      'code.command_succeeded',
      'code.command_queued',
    ],
  );
  assert.ok(
    (await f.events()).every(
      (event) =>
        event.actorId === worker.caller.actorId &&
        (event.data.source as any).sessionId === worker.session.id,
    ),
  );
  assert.equal(f.builds, beforeBuilds);
});

test('commit enforces active attached writable fixed authority, including direct service bindings', async (t) => {
  for (const [options, code] of [
    [{ readOnly: true }, 'code_read_only'],
    [{ scratch: true }, 'code_workspace_required'],
    [{ grant: false }, 'execution_tool_forbidden'],
    [{ fixedMessage: 'The approved message' }, 'execution_arguments_forbidden'],
  ] as const) {
    await t.test(code, async (t) => {
      const f = await fixture(t, options),
        worker = await f.ready();
      await assert.rejects(async () => await f.code.commit(worker.caller, input()), { code });
      assert.equal((await f.code.list(f.source)).length, 0);
    });
  }
  await t.test('ordinary source, unattached, expired and captured workers', async (t) => {
    const f = await fixture(t);
    await assert.rejects(async () => await f.code.commit(f.source, input()), {
      code: 'session_required',
    });
    const lease = await f.offer();
    const caller = await lease.activate();
    await assert.rejects(async () => await f.code.commit(caller, input()), {
      code: 'code_workspace_required',
    });
    await lease.attach();
    await f.sessions.workspaceResult(f.source, { ...lease.control, workspace });
    await assert.rejects(async () => await f.code.commit(caller, input()), {
      code: 'code_workspace_closed',
    });
    const active = await f.ready();
    await assert.rejects(
      async () => await f.code.commit(active.caller, { ...input(), expectedHead: 'a'.repeat(64) }),
      { code: 'code_object_format' },
    );
    f.advance(4 * 60 * 60 * 1000 + 1);
    await assert.rejects(async () => await f.code.commit(active.caller, input()), {
      code: 'session_closed',
    });
    assert.equal((await f.code.list(f.source)).length, 0);
  });
  await t.test('a real invocation retains exact arguments', async (t) => {
    const f = await fixture(t, { fixedMessage: input().message }),
      worker = await f.ready();
    const invocation = await f.sessions.prepare(worker.caller, 'code.commit', { ...input() });
    const record = await f.sessions.run(
      invocation,
      async (caller) => await f.code.commit(caller, input()),
    );
    assert.equal(record.status, 'queued');
    await assert.rejects(async () => await f.code.commit(invocation.caller, input()), {
      code: 'session_invocation',
    });
  });
});

test('project readers can inspect while worker reads and runner control preserve exact ownership', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    otherWorker = await f.ready();
  const queued = await f.code.commit(worker.caller, input());
  const actor = await f.scope.issueActor(f.source, { name: 'Reader', role: 'reader' });
  const reader: Caller = {
    actorId: actor.actor.id,
    projectId: f.source.projectId,
    credentialId: actor.credential.id,
  };
  for (const method of ['list', 'operation', 'nextCommand', 'completeCommand'] as const) {
    await t.test(method, async () => {
      const reads = method === 'list' || method === 'operation';
      const caller = structuredClone(reads ? otherWorker.caller : reader);
      const pending =
        method === 'list'
          ? f.code.list(caller)
          : method === 'operation'
            ? f.code.operation(caller, queued.command.id)
            : method === 'nextCommand'
              ? f.code.nextCommand(caller, worker.control)
              : f.code.completeCommand(caller, {
                  ...worker.control,
                  commandId: queued.command.id,
                  error: 'git_failed',
                });
      Object.assign(caller, reads ? worker.caller : f.source);
      if (method === 'list') assert.deepEqual(await pending, []);
      else
        await assert.rejects(pending, {
          code: reads ? 'code_command_not_found' : 'session_forbidden',
        });
    });
  }
  assert.equal((await f.code.operation(reader, queued.command.id)).status, 'queued');
  assert.equal((await f.code.list(reader)).length, 1);
  assert.equal((await f.code.list(otherWorker.caller)).length, 0);
  await assert.rejects(async () => await f.code.operation(otherWorker.caller, queued.command.id), {
    code: 'code_command_not_found',
  });
  await assert.rejects(async () => await f.code.nextCommand(reader, worker.control), {
    code: 'session_forbidden',
  });
  await assert.rejects(async () => await f.code.nextCommand(worker.caller, worker.control), {
    code: 'session_forbidden',
  });
  for (const control of [
    { ...worker.control, runnerId: 'other' },
    { ...worker.control, hostRef: 'other' },
  ])
    await assert.rejects(async () => await f.code.nextCommand(f.source, control), {
      code: 'session_forbidden',
    });
  const foreign = await f.scope.bootstrap({ projectName: 'Foreign', actorName: 'Foreign owner' });
  const foreignCaller: Caller = {
    actorId: foreign.actor.id,
    projectId: foreign.project.id,
    credentialId: foreign.credential.id,
  };
  assert.equal((await f.code.list(foreignCaller)).length, 0);
  await assert.rejects(async () => await f.code.operation(foreignCaller, queued.command.id), {
    code: 'code_command_not_found',
  });
  await f.scope.revokeActor(f.source, reader.actorId);
  await assert.rejects(async () => await f.code.list(reader), { code: 'forbidden' });
  await f.sessions.release(f.source, worker.control);
  await assert.rejects(async () => await f.code.operation(worker.caller, queued.command.id));
  assert.equal((await f.code.operation(f.source, queued.command.id)).status, 'queued');
});

test('receipts bind all command identity, require a claim, and are immutable at service and SQLite boundaries', async (t) => {
  const f = await fixture(t),
    worker = await f.ready();
  const queued = await f.code.commit(worker.caller, input());
  const completion = {
    ...worker.control,
    commandId: queued.command.id,
    receipt: receipt(queued.command),
  };
  await assert.rejects(async () => await f.code.completeCommand(f.source, completion), {
    code: 'code_not_dispatched',
  });
  const other = await f.ready();
  await assert.rejects(
    async () => await f.code.completeCommand(f.source, { ...completion, ...other.control }),
    {
      code: 'code_command_not_found',
    },
  );
  await f.code.nextCommand(f.source, worker.control);
  for (const patch of [
    { commandId: 'other' },
    { repositoryId: 'other' },
    { workspaceId: 'other' },
    { baseOid: oid('d') },
    { parentOid: oid('d') },
  ])
    await assert.rejects(
      async () =>
        await f.code.completeCommand(f.source, {
          ...completion,
          receipt: { ...completion.receipt, ...patch },
        }),
      { code: 'code_receipt_conflict' },
    );
  const succeeded = await f.code.completeCommand(f.source, completion);
  assert.deepEqual(await f.code.completeCommand(f.source, completion), succeeded);
  await assert.rejects(
    async () =>
      await f.code.completeCommand(f.source, {
        ...completion,
        receipt: { ...completion.receipt, headOid: oid('d') },
      }),
    { code: 'code_result_conflict' },
  );
  await assert.rejects(
    async () =>
      await f.code.completeCommand(f.source, {
        ...worker.control,
        commandId: queued.command.id,
        error: 'git_failed',
      }),
    { code: 'code_result_conflict' },
  );
  succeeded.receipt!.stats.filesChanged = 999;
  assert.equal(
    (await f.code.operation(f.source, queued.command.id)).receipt!.stats.filesChanged,
    2,
  );
  assert.equal((await f.events('succeeded')).length, 1);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE code_commands SET command_json=? WHERE id=?',
            '{}',
            queued.command.id,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "UPDATE code_commands SET status='failed',receipt_json=NULL,error='replacement' WHERE id=?",
            queued.command.id,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM code_commands WHERE id=?', queued.command.id),
      ),
    /retained/,
  );
});

test('closed queued work is cancelled; an already dispatched fact may arrive late without reviving its worker', async (t) => {
  const f = await fixture(t),
    cancelled = await f.ready(),
    late = await f.ready();
  const queued = await f.code.commit(cancelled.caller, input());
  const dispatched = await f.code.commit(late.caller, input());
  await f.code.nextCommand(f.source, late.control);
  f.poison();
  const beforeBuilds = f.builds;
  f.advance(4 * 60 * 60 * 1000 + 1);
  assert.equal(await f.code.nextCommand(f.source, cancelled.control), null);
  assert.equal(await f.code.nextCommand(f.source, cancelled.control), null);
  assert.equal((await f.code.operation(f.source, queued.command.id)).status, 'cancelled');
  assert.equal((await f.events('cancelled')).length, 1);
  await assert.rejects(
    async () =>
      await f.code.completeCommand(f.source, {
        ...cancelled.control,
        commandId: queued.command.id,
        error: 'git_failed',
      }),
    { code: 'code_result_conflict' },
  );
  assert.deepEqual(await f.code.nextCommand(f.source, late.control), dispatched.command);
  assert.equal((await f.events('dispatched')).length, 1);
  const result = await f.code.completeCommand(f.source, {
    ...late.control,
    commandId: dispatched.command.id,
    receipt: receipt(dispatched.command),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal((await f.sessions.get(f.source, late.session.id)).status, 'expired');
  await assert.rejects(async () => await f.sessions.authenticate(late.secret));
  assert.equal(f.builds, beforeBuilds);
});

test('restart preserves queued and dispatched operations, exact claims, failures and request receipts', async (t) => {
  const f = await fixture(t),
    queuedWorker = await f.ready(),
    dispatchedWorker = await f.ready();
  const queued = await f.code.commit(queuedWorker.caller, input());
  const dispatched = await f.code.commit(dispatchedWorker.caller, input());
  await f.code.nextCommand(f.source, dispatchedWorker.control);
  const old = f.code;
  await f.restart();
  await assert.rejects(async () => await old.list(f.source), { code: 'code_unavailable' });
  assert.equal(
    (await f.code.commit(await f.sessions.authenticate(queuedWorker.secret), input())).command.id,
    queued.command.id,
  );
  assert.deepEqual(await f.code.nextCommand(f.source, queuedWorker.control), queued.command);
  assert.deepEqual(
    await f.code.nextCommand(f.source, dispatchedWorker.control),
    dispatched.command,
  );
  const failure = {
    ...dispatchedWorker.control,
    commandId: dispatched.command.id,
    error: 'git_head_changed',
  };
  assert.equal((await f.code.completeCommand(f.source, failure)).status, 'failed');
  await f.restart();
  assert.equal((await f.code.completeCommand(f.source, failure)).error, 'git_head_changed');
  assert.equal((await f.events('queued')).length, 2);
  assert.equal((await f.events('dispatched')).length, 2);
  assert.equal((await f.events('failed')).length, 1);
});

test('strict input validation never runs accessors, proxy traps or serialization callbacks', async (t) => {
  const f = await fixture(t),
    worker = await f.ready();
  let touched = 0;
  const getter = Object.defineProperty({ ...input() }, 'message', {
    enumerable: true,
    get() {
      touched++;
      return 'secret';
    },
  });
  const proxy = new Proxy(input(), {
    ownKeys() {
      touched++;
      return [];
    },
    get() {
      touched++;
      return undefined;
    },
  });
  const cycle: any = { ...input() };
  cycle.extra = cycle;
  for (const invalid of [
    getter,
    proxy,
    cycle,
    {
      ...input(),
      toJSON() {
        touched++;
        return input();
      },
    },
    { ...input(), actorId: 'injected' },
    Object.assign(Object.create({}), input()),
  ]) {
    await assert.rejects(async () => await f.code.commit(worker.caller, invalid), {
      code: 'invalid_code_input',
    });
  }
  assert.equal(touched, 0);
  assert.equal((await f.code.list(f.source)).length, 0);
  const queued = await f.code.commit(worker.caller, input());
  await f.code.nextCommand(f.source, worker.control);
  const result = receipt(queued.command);
  Object.defineProperty(result.stats, 'insertions', {
    enumerable: true,
    get() {
      touched++;
      return 0;
    },
  });
  await assert.rejects(
    async () =>
      await f.code.completeCommand(f.source, {
        ...worker.control,
        commandId: queued.command.id,
        receipt: result,
      }),
    { code: 'invalid_code_input' },
  );
  await assert.rejects(
    async () =>
      await f.code.completeCommand(f.source, {
        ...worker.control,
        commandId: queued.command.id,
        receipt: receipt(queued.command),
        error: 'mixed',
      } as any),
    { code: 'invalid_code_input' },
  );
  await assert.rejects(
    async () =>
      await f.code.nextCommand(
        f.source,
        Object.defineProperty({}, 'sessionId', {
          get() {
            touched++;
            return worker.session.id;
          },
        }) as any,
      ),
    { code: 'invalid_code_input' },
  );
  assert.equal(touched, 0);
  assert.equal((await f.code.operation(f.source, queued.command.id)).status, 'dispatched');
});

test('events and operation writes roll back together, including an existing caller transaction', async (t) => {
  const f = await fixture(t),
    worker = await f.ready();
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    if (event.type === 'code.command_queued') throw new Error('event failure');
    return await append(tx, event);
  };
  await assert.rejects(async () => await f.code.commit(worker.caller, input()), /event failure/);
  f.state.appendEvent = append;
  assert.equal((await f.code.list(f.source)).length, 0);
  await assert.rejects(
    async () =>
      await f.state.transaction(async () => {
        await f.code.commit(worker.caller, input());
        throw new Error('outer rollback');
      }),
    /outer rollback/,
  );
  assert.equal((await f.code.list(f.source)).length, 0);
  const raced = await Promise.allSettled([
    Promise.resolve().then(async () => await f.code.commit(worker.caller, input())),
    Promise.resolve().then(
      async () =>
        await f.code.commit(worker.caller, {
          ...input(),
          message: 'a different concurrent request',
        }),
    ),
    Promise.resolve().then(async () => await f.code.commit(worker.caller, input('competing-id'))),
  ]);
  assert.deepEqual(
    raced.map((result) => result.status),
    ['fulfilled', 'rejected', 'rejected'],
  );
  assert.equal((raced[1] as PromiseRejectedResult).reason.code, 'code_request_conflict');
  assert.equal((raced[2] as PromiseRejectedResult).reason.code, 'code_command_pending');
  assert.equal((await f.code.list(f.source)).length, 1);
  assert.equal((await f.events('queued')).length, 1);
});

test('merge commands require their service grant and frozen plan, replay by input, and stop after the first completed merge', async (t) => {
  const f = await fixture(t, { merge: true });
  const worker = await f.ready();
  await migratePendingMerges(f.state);
  await f.state.transaction((tx) =>
    pinMerge(tx, f.source.projectId, worker.session.instanceId, 'd'.repeat(64), oid('a'), oid('f')),
  );
  const request = { ...input('merge'), operation: 'complete' as const };
  const first = await f.code.merge(worker.caller, request);
  assert.equal(first.command.merge, 'complete');
  assert.deepEqual(await f.code.merge(worker.caller, request), first);
  await assert.rejects(f.code.merge(worker.caller, { ...request, operation: 'start' }), {
    code: 'code_request_conflict',
  });
  const command = (await f.code.nextCommand(f.source, worker.control))!;
  const completed = await f.code.completeCommand(f.source, {
    ...worker.control,
    commandId: command.id,
    receipt: receipt(command),
  });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_pending_merges SET first_merge=? WHERE unit_id=?',
      oid('b'),
      worker.session.instanceId,
    ),
  );
  assert.deepEqual(await f.code.merge(worker.caller, request), completed);
  await assert.rejects(f.code.merge(worker.caller, { ...request, requestId: 'second-merge' }), {
    code: 'code_merge_completed',
  });
  const ordinary = await f.code.commit(worker.caller, {
    ...input('correction'),
    expectedHead: oid('b'),
  });
  assert.equal(ordinary.command.merge, undefined);
  const other = await fixture(t);
  const ordinaryWorker = await other.ready();
  await assert.rejects(other.code.merge(ordinaryWorker.caller, request), {
    code: 'execution_tool_forbidden',
  });
});
