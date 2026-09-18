import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Caller,
  SessionWorkspace,
  WorkflowWorkspacePolicy,
  WorkflowExecutionReferences,
} from '@merv/contracts';
import { createApp } from '../src/app.js';

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
  perBase: true,
  retain: true,
  advancesCentral: false,
};
async function fixture(
  t: TestContext,
  options: {
    policy?: WorkflowWorkspacePolicy;
    readOnly?: boolean;
    reference?: string | string[];
    http?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-session-workspace-'));
  let app = await createApp({ directory, api: options.http ?? false, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
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
  const session = await app.ctx.sessions.offer(source, input);
  const control = { sessionId: session.id, runnerId: 'runner', hostRef: 'launch-synthetic' };
  t.after(async () => {
    await app.stop();
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
    secret,
    events,
    get builds() {
      return builds;
    },
    poison() {
      poisoned = true;
    },
    async restart() {
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
  await f.app.ctx.sessions.release(f.source, f.control);
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
  const closed = await f.app.ctx.sessions.workspaceResult(f.source, {
    ...f.control,
    workspace: result,
  });
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
    (await f.app.ctx.sessions.projectStatus(f.source)).sessions[0].workspace,
    closed.workspace,
  );
  assert.equal(
    (await f.app.ctx.sessions.projectStatus(f.source)).sessions[0].workspaceMode,
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
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('DELETE FROM session_workspaces WHERE session_id=?', f.session.id),
      ),
    /retained/,
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
  const other = await f.app.ctx.scope.issueActor(f.source, {
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
  await f.app.ctx.scope.revokeCredential(outsider, f.source.credentialId!);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() }),
    { code: 'forbidden' },
  );
});

test('workspace mode and exact reference base are pinned; read-only capture cannot report a different head', async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => await f.app.ctx.sessions.attach(f.source, f.control), {
    code: 'workspace_policy_mismatch',
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.attach(f.source, {
        ...f.control,
        workspace: workspace({ mode: 'ephemeral' }),
      }),
    { code: 'workspace_policy_mismatch' },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.attach(f.source, {
        ...f.control,
        workspace: workspace({ baseOid: oid('b') }),
      }),
    { code: 'workspace_base_conflict' },
  );
  assert.equal((await f.app.ctx.sessions.get(f.source, f.session.id)).hostRef, null);
  for (const reference of ['', 'main', ['a'.repeat(40)]]) {
    const absent = await fixture(t, { reference });
    await assert.rejects(
      async () =>
        await absent.app.ctx.sessions.attach(absent.source, {
          ...absent.control,
          workspace: workspace(),
        }),
      { code: 'workspace_reference_unavailable' },
    );
  }
  const scratch = await fixture(t, { policy: { mode: 'none' } });
  await assert.rejects(
    async () =>
      await scratch.app.ctx.sessions.attach(scratch.source, {
        ...scratch.control,
        workspace: workspace(),
      }),
    { code: 'workspace_policy_mismatch' },
  );
  assert.equal(
    (await scratch.app.ctx.sessions.attach(scratch.source, scratch.control)).workspace,
    undefined,
  );
  const readonly = await fixture(t, {
    readOnly: true,
    policy: { mode: 'ephemeral', namespace: 'review', base: 'central', retain: false },
  });
  const initial = workspace({
    mode: 'ephemeral',
    branch: null,
    baseOid: oid('c'),
    headOid: oid('c'),
  });
  await readonly.app.ctx.sessions.attach(readonly.source, {
    ...readonly.control,
    workspace: initial,
  });
  await readonly.app.ctx.sessions.release(readonly.source, readonly.control);
  await assert.rejects(
    async () =>
      await readonly.app.ctx.sessions.workspaceResult(readonly.source, {
        ...readonly.control,
        workspace: { ...initial, headOid: oid('d') },
      }),
    { code: 'workspace_readonly_conflict' },
  );
  assert.deepEqual(
    (
      await readonly.app.ctx.sessions.workspaceResult(readonly.source, {
        ...readonly.control,
        workspace: initial,
      })
    ).workspace!.result,
    initial,
  );
});

test('workspace reports reject malformed object graphs before invoking getters and roll back audit failures', async (t) => {
  const f = await fixture(t);
  let getters = 0;
  const accessor = {
    ...workspace(),
    stats: Object.defineProperty({ filesChanged: 0, insertions: 0, deletions: 0 }, 'commitCount', {
      enumerable: true,
      get() {
        getters++;
        return 0;
      },
    }),
  };
  const malformed = [
    accessor,
    { ...workspace(), extra: 'unknown' },
    { ...workspace(), stats: { ...workspace().stats, extra: 1 } },
    workspace({ baseOid: 'main' }),
    workspace({ headOid: 'a'.repeat(64) }),
    workspace({ branch: '../escape' }),
    workspace({ repositoryId: '/private/path' }),
    workspace({ stats: { ...workspace().stats, filesChanged: Number.MAX_SAFE_INTEGER + 1 } }),
    Object.assign(Object.create({ inherited: true }), workspace()),
  ];
  for (const value of malformed)
    await assert.rejects(
      async () =>
        await f.app.ctx.sessions.attach(f.source, {
          ...f.control,
          workspace: value as SessionWorkspace,
        }),
      { code: 'invalid_workspace' },
    );
  assert.equal(getters, 0);
  const append = f.app.ctx.state.appendEvent.bind(f.app.ctx.state);
  let rejectedType = 'session.workspace_attached';
  f.app.ctx.state.appendEvent = async (tx, event) => {
    if (event.type === rejectedType) throw new Error('Synthetic audit failure');
    return await append(tx, event);
  };
  await assert.rejects(
    async () => await f.app.ctx.sessions.attach(f.source, { ...f.control, workspace: workspace() }),
    /Synthetic audit failure/,
  );
  assert.equal((await f.app.ctx.sessions.get(f.source, f.session.id)).hostRef, null);
  assert.equal((await f.app.ctx.sessions.get(f.source, f.session.id)).workspace, undefined);
  rejectedType = '';
  await f.app.ctx.sessions.attach(f.source, { ...f.control, workspace: workspace() });
  // A final capture is of a process that ran; an offer nobody activated has none.
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() }),
    { code: 'session_not_started' },
  );
  await f.app.ctx.sessions.release(f.source, f.control);
  rejectedType = 'session.workspace_result';
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() }),
    /Synthetic audit failure/,
  );
  assert.equal((await f.app.ctx.sessions.get(f.source, f.session.id)).workspace!.result, null);
  rejectedType = '';
  await f.app.ctx.sessions.workspaceResult(f.source, { ...f.control, workspace: workspace() });
  assert.equal((await f.events('session.workspace_result')).length, 1);
});

test('HTTP transports strict workspace metadata and permits post-transition capture without activation', async (t) => {
  const f = await fixture(t, { http: true });
  const bad = await f.http('/attach', {
    runnerId: 'runner',
    hostRef: f.control.hostRef,
    workspace: { ...workspace(), path: '/must/not/be/a/server/path' },
  });
  assert.equal(bad.status, 400);
  const attached = await f.http('/attach', {
    runnerId: 'runner',
    hostRef: f.control.hostRef,
    workspace: workspace(),
  });
  assert.equal(attached.status, 200, JSON.stringify(attached));
  await f.finish();
  const closed = await f.app.ctx.sessions.get(f.source, f.session.id);
  assert.equal(closed.status, 'expired');
  f.poison();
  const result = workspace({ headOid: oid('b') });
  const body = { runnerId: 'runner', hostRef: f.control.hostRef, workspace: result };
  const response = await f.http('/workspace-result', body);
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.session.status, 'expired');
  assert.deepEqual(response.body.session.workspace, { attachment: workspace(), result });
  assert.equal(response.body.session.activatedAt, null);
  assert.equal((await f.http('/workspace-result', body)).status, 200);
  assert.equal(
    (await f.http('/workspace-result', { ...body, workspace: workspace({ headOid: oid('c') }) }))
      .status,
    409,
  );
  assert.equal((await f.http('/workspace-result', body, f.secret)).status, 403);
  assert.equal((await f.events('session.workspace_result')).length, 1);
});

test('HTTP summary preserves declared workspace mode before attachment and after preparation failure', async (t) => {
  const policies: WorkflowWorkspacePolicy[] = [
    { mode: 'none' },
    { mode: 'ephemeral', namespace: 'pending', base: 'central', retain: false },
    persistent,
  ];
  for (const policy of policies) {
    const f = await fixture(t, { http: true, policy });
    const summary = async () => {
      const response = await fetch(`${f.app.ctx.api.url}/sessions/status`, {
        headers: { authorization: `Bearer ${f.boot.token}` },
      });
      assert.equal(response.status, 200);
      return (await response.json()).sessions[0];
    };
    const offered = await summary();
    assert.equal(offered.status, 'offered');
    assert.equal(offered.workspaceMode, policy.mode);
    assert.equal(offered.workspace, undefined);
    if (policy.mode !== 'none') {
      await f.app.ctx.sessions.release(f.source, { ...f.control, outcome: 'workspace_failed' });
      const failed = await summary();
      assert.equal(failed.status, 'released');
      assert.equal(failed.outcome, 'workspace_failed');
      assert.equal(failed.workspaceMode, policy.mode);
      assert.equal(failed.workspace, undefined);
    }
  }
});
