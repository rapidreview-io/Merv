import type {
  Caller,
  SessionWorkspace,
  WorkflowExecutionReferences,
  WorkflowWorkspacePolicy,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from './fixtures/app.js';

const oid = (digit: string) => digit.repeat(40);
const workspace = (patch: Partial<SessionWorkspace> = {}): SessionWorkspace => ({
  repositoryId: 'synthetic-repository',
  workspaceId: 'synthetic-workspace',
  mode: 'persistent',
  branch: 'refs/heads/merv/test',
  baseOid: oid('a'),
  headOid: oid('a'),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  ...patch,
});
const persistent: WorkflowWorkspacePolicy = {
  mode: 'persistent',
  namespace: 'test',
  base: 'reference:code',
  perBase: false,
  retain: true,
  advancesCentral: false,
  driver: 'probe.v1',
};
async function fixture(
  t: TestContext,
  options: {
    policy?: WorkflowWorkspacePolicy;
    readOnly?: boolean;
    reference?: string | string[];
    http?: boolean;
    /** Another fixture's application: this one then adds only its own project and workflow. */
    app?: Awaited<ReturnType<typeof createApp>>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-session-workspace-'));
  const owned = !options.app;
  let app = options.app ?? (await createApp({ directory, api: options.http ?? false, port: 0 }));
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Git metadata',
    actorName: 'Controller owner',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const name = `workspace-${randomUUID()}`;
  let builds = 0,
    poisoned = false;
  const register = async () =>
    await app.ctx.workflows.register(
      {
        name,
        version: 1,
        initial: 'working',
        states: ['working', 'done'],
        terminal: ['done'],
        edges: [{ from: 'working', action: 'finish', to: 'done' }],
      },
      {
        actions: [
          {
            name: 'finish',
            states: ['working'],
            tool: 'finish',
            instruction: 'Finish',
            transitions: ['finish'],
            check: async () => {},
          },
        ],
        assignments: [
          {
            state: 'working',
            check: async ({ caller, tx }) => {
              await app.ctx.scope.require(caller, 'read', tx);
            },
            build: async () => {
              builds++;
              if (poisoned) throw new Error('Workspace reports must never rebuild context');
              return {
                role: options.readOnly ? 'reviewer' : 'producer',
                label: 'Git work',
                brief: 'Inspect the exact checkout.',
                references: [],
                handoff: { instruction: 'Finish', tools: [] },
                execution: { readOnly: options.readOnly ?? false, tools: [] },
                context: null,
              };
            },
            execution: {
              readOnly: options.readOnly ?? false,
              tools: [],
              workspace: options.policy ?? persistent,
            },
            references: (): WorkflowExecutionReferences =>
              options.reference === '' ? {} : { code: options.reference ?? oid('a') },
            lease: {
              role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
                options.readOnly ? 'reviewer' : 'producer',
              acquire: async () => ({}),
              check: async () => {},
              release: async () => {},
            },
          },
        ],
      },
    );
  let program = await register();
  const instance = await program.start(source, { workflow: name, requestId: 'start' });
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const input = {
    instanceId: instance.id,
    expectedRevision: 0,
    runnerId: 'runner',
    requestId: 'offer',
    secret,
  };
  // The runner offered the work advertises the driver its workspace names.
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['probe.v1'],
  });
  const session = await app.ctx.sessions.offer(source, input);
  const control = { sessionId: session.id, runnerId: 'runner', hostRef: 'launch-synthetic' };
  // A release names its session and runner only; the host belongs to attachment and capture.
  const { hostRef: _hostRef, ...release } = control;
  t.after(async () => {
    if (owned) await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const events = async (type: string) =>
    (await app.ctx.state.events(boot.project.id)).filter((event) => event.type === type);
  return {
    get app() {
      return app;
    },
    source,
    boot,
    session,
    control,
    release,
    secret,
    events,
    get builds() {
      return builds;
    },
    poison() {
      poisoned = true;
    },
    async restart() {
      assert.ok(owned, 'Only a fixture that owns its application restarts it');
      await app.stop();
      app = await createApp({ directory, api: options.http ?? false, port: 0 });
      program = await register();
    },
    async finish() {
      return await program.transition(source, {
        instanceId: instance.id,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'finish',
      });
    },
    async http(suffix: string, body: unknown, token = boot.token) {
      const response = await fetch(`${app.ctx.api.url}/sessions/${session.id}${suffix}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    },
  };
}

test('Git attachment and final capture are immutable, replayable and independent of closed lease rows', async (t) => {
  const f = await fixture(t);
  const attachment = workspace();
  const attached = await f.app.ctx.sessions.attach(f.source, {
    ...f.control,
    workspace: attachment,
  });
  assert.equal(attached.status, 'offered');
  assert.equal(attached.activatedAt, null);
  assert.equal((await f.events('session.workspace_attached')).length, 1);
  attachment.stats.filesChanged = 999;
  attached.workspace!.attachment.repositoryId = 'changed-return';
  assert.deepEqual(
    (await f.app.ctx.sessions.attach(f.source, { ...f.control, workspace: workspace() })).workspace,
    { attachment: workspace(), result: null },
  );
  assert.equal((await f.events('session.workspace_attached')).length, 1);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.attach(f.source, {
        ...f.control,
        workspace: workspace({ headOid: oid('b') }),
      }),
    { code: 'workspace_attachment_conflict' },
  );
  await f.app.ctx.sessions.release(f.source, f.release);
  const oldRow = await f.app.ctx.state.read(
    async (sql) =>
      (await sql.get<{ session_json: string }>(
        'SELECT session_json FROM worker_sessions WHERE id=?',
        f.session.id,
      ))!.session_json,
  );
  f.poison();
  const beforeBuilds = f.builds;
  const result = workspace({
    headOid: oid('b'),
    stats: { commitCount: 1, filesChanged: 2, insertions: 3, deletions: 4 },
  });
  const caller = { ...f.source };
  const capture = { ...f.control, workspace: structuredClone(result) };
  const pendingCapture = f.app.ctx.sessions.workspaceResult(caller, capture);
  caller.actorId = 'missing';
  Object.assign(capture, { sessionId: 'missing', runnerId: 'other', hostRef: '' });
  capture.workspace.headOid = oid('c');
  const closed = await pendingCapture;
  assert.equal(closed.status, 'released');
  assert.equal(closed.activatedAt, null);
  assert.deepEqual(closed.workspace, { attachment: workspace(), result });
  assert.equal(f.builds, beforeBuilds);
  assert.equal((await f.events('session.workspace_result')).length, 1);
  const recorded = (await f.events('session.workspace_result'))[0].data;
  assert.equal(recorded.expectedRevision, f.session.expectedRevision);
  assert.equal(recorded.policyHash, f.session.execution.policyHash);
  assert.equal(recorded.workflow, f.session.execution.workflow);
  assert.equal(recorded.state, 'working');
  assert.deepEqual(
    await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: result }),
    closed,
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, {
        ...f.control,
        workspace: { ...result, headOid: oid('c') },
      }),
    { code: 'workspace_result_conflict' },
  );
  assert.equal((await f.events('session.workspace_result')).length, 1);
  assert.equal(
    await f.app.ctx.state.read(
      async (sql) =>
        (await sql.get<{ session_json: string }>(
          'SELECT session_json FROM worker_sessions WHERE id=?',
          f.session.id,
        ))!.session_json,
    ),
    oldRow,
  );
  assert.deepEqual(
    (await f.app.ctx.sessions.dispatch.projectStatus(f.source)).sessions[0].workspace,
    closed.workspace,
  );
  assert.equal(
    (await f.app.ctx.sessions.dispatch.projectStatus(f.source)).sessions[0].workspaceMode,
    'persistent',
  );
  assert.deepEqual((await f.app.ctx.sessions.list(f.source))[0].workspace, closed.workspace);
  await f.restart();
  assert.deepEqual(
    (await f.app.ctx.sessions.get(f.source, f.session.id)).workspace,
    closed.workspace,
  );
  assert.deepEqual(
    (await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: result }))
      .workspace,
    closed.workspace,
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE session_workspaces SET result_json=? WHERE session_id=?',
            JSON.stringify(workspace()),
            f.session.id,
          ),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('DELETE FROM session_workspaces WHERE session_id=?', f.session.id),
      ),
    { code: 'state_constraint' },
  );
});

test('Git reporting fences source, runner, host, attachment identity and revoked credentials', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() }),
    { code: 'host_conflict' },
  );
  await f.app.ctx.sessions.attach(f.source, { ...f.control, workspace: workspace() });
  const other = await f.app.ctx.scope.credentials.issueActor(f.source, {
    name: 'Other operator',
    role: 'operator',
  });
  const outsider: Caller = {
    actorId: other.actor.id,
    projectId: f.source.projectId,
    credentialId: other.credential.id,
  };
  for (const operation of [
    async () =>
      await f.app.ctx.sessions.workspaceResult(outsider, { ...f.control, workspace: workspace() }),
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, {
        ...f.control,
        runnerId: 'other',
        workspace: workspace(),
      }),
  ])
    await assert.rejects(operation, { code: 'session_forbidden' });
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, {
        ...f.control,
        hostRef: 'other',
        workspace: workspace(),
      }),
    { code: 'host_conflict' },
  );
  const changed: Partial<SessionWorkspace>[] = [
    { repositoryId: 'other' },
    { workspaceId: 'other' },
    { baseOid: oid('b') },
    { mode: 'ephemeral' },
    { branch: 'refs/heads/other' },
  ];
  for (const patch of changed)
    await assert.rejects(
      async () =>
        await f.app.ctx.sessions.workspaceResult(f.source, {
          ...f.control,
          workspace: workspace(patch),
        }),
      { code: 'workspace_identity_conflict' },
    );
  assert.equal((await f.events('session.workspace_result')).length, 0);
  await f.app.ctx.scope.credentials.revokeCredential(outsider, f.source.credentialId!);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() }),
    { code: 'forbidden' },
  );
});
