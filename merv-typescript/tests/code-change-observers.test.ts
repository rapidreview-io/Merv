import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-observers-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  const ids = new Set([
    'state',
    'scope',
    'workflows',
    'domain-events',
    'blobs',
    'artifacts',
    'sessions',
    'reviews',
    'code',
    'code-work',
  ]);
  config.plugins = config.plugins.filter(({ id }) => ids.has(id));
  for (const plugin of config.plugins) if (plugin.id === 'code-work') plugin.config = {};
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { ctx } = app;
  const principal = await ctx.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  // A project bound to a machine's repository before Code initialized projects itself: Code
  // Work, which initializes new projects, is away while it is created and bound.
  await app.setEnabled('code-work', false);
  const project = await ctx.scope.members.createProject(principal, {
    name: 'Observed Code',
    requestId: 'project',
  });
  const caller = await ctx.scope.caller(principal, project.id);
  const observed = await ctx.workflows.register(
    {
      name: 'observed',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'finish',
          tool: 'observed.finish',
          states: ['working'],
          transitions: ['finish'],
          instruction: 'Finish work.',
          check: () => {},
        },
      ],
    },
  );
  const workflow = await observed.start(caller, { workflow: 'observed', requestId: 'work' });
  const bind = (head: string, expected?: string, stored = false) =>
    ctx.code.units.bindLocal(
      caller,
      {
        repositoryId: 'repository',
        mainOid: head.repeat(40),
        ...(expected ? { expectedMainOid: expected.repeat(40) } : {}),
        requestId: `bind-${head}`,
      },
      stored,
    );
  await bind('a', undefined, true);
  await app.setEnabled('code-work', true);
  await ctx.state.transaction((tx) => ctx.codeWork.declareUnit(caller, workflow.id, tx));
  return {
    app,
    ctx,
    caller,
    unitId: workflow.id,
    observed,
    bind,
    blockers: () => ctx.workflows.blockers(caller, workflow.id),
  };
}

test('direct core binding changes update research and detached adapters reconcile on reload', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.blockers(), []);
  await f.bind('b', 'a');
  assert.equal((await f.blockers())[0]?.key, 'main');
  const core = f.ctx.code;
  await f.app.setEnabled('code-work', false);
  assert.equal(f.ctx.code, core);
  await f.bind('c', 'b', true);
  assert.equal((await f.blockers())[0]?.key, 'main', 'an absent adapter does not receive changes');
  await f.app.setEnabled('code-work', true);
  assert.deepEqual(await f.blockers(), []);
  await f.bind('d', 'c');
  assert.equal((await f.blockers())[0]?.key, 'main');
});

test('Code takes its writer lifecycle from session events itself and catches up after its reload', async (t) => {
  const f = await fixture(t);
  const append = async (type: string) => {
    await f.ctx.state.transaction((tx) =>
      f.ctx.state.appendEvent(tx, {
        projectId: f.caller.projectId,
        actorId: f.caller.actorId,
        subjectId: 'writer',
        type,
        data: {},
      }),
    );
    await f.ctx.domainEvents.drain();
  };
  await f.ctx.state.transaction((tx) =>
    f.ctx.codeWork.pinBase(f.caller, { unitId: f.unitId, leaseId: 'writer', writer: true }, tx),
  );
  const row = () =>
    f.ctx.state.read((sql) => f.ctx.code.writers.row(sql, f.caller.projectId, f.unitId));
  await f.app.setEnabled('code-work', false);
  await append('session.workspace_attached');
  assert.equal((await row())?.writer_state, 'active', 'Code Work is not needed for the attach');

  // What happened while Code was unloaded is caught up on in order, under the same cursor.
  await f.app.setEnabled('code', false);
  await append('session.closed');
  await f.app.setEnabled('code', true);
  await f.ctx.domainEvents.drain();
  // Its session closed with nothing in flight: the generation ended with it.
  assert.deepEqual(
    await f.ctx.state.transaction((tx) => f.ctx.code.writers.writerStatus(f.caller, f.unitId, tx)),
    { generation: 1, state: 'closed', blocked: null },
  );
  // Replayed attachment or close observations cannot reopen it.
  const before = await row();
  await append('session.workspace_attached');
  await append('session.closed');
  const after = await row();
  assert.equal(after?.writer_state, 'closed');
  assert.equal(after?.writer_changed_at, before?.writer_changed_at);
});

test('direct core writer changes and research blockers commit or roll back together', async (t) => {
  const f = await fixture(t);
  await f.ctx.state.transaction(async (tx) => {
    await f.ctx.codeWork.pinBase(
      f.caller,
      { unitId: f.unitId, leaseId: 'writer', writer: true },
      tx,
    );
    await f.ctx.code.writers.sessionChanged(f.caller.projectId, 'writer', 'attached', tx);
    // Its final capture was quarantined: the one writer an operator ends.
    await tx.run(
      "UPDATE code_workspaces SET writer_state='recovery_required',quarantine_operation_id='cop_quarantined' WHERE unit_id=?",
      f.unitId,
    );
    await f.ctx.code.writers.changed(tx, f.caller.projectId, f.unitId);
  });
  await f.ctx.code.writers.expire();
  assert.equal((await f.blockers())[0]?.code, 'code_capture_quarantined');
  // A quarantined capture is an operator's move: the project admin signed in reads it as
  // theirs on the unit's gate, so it reaches Needs you.
  assert.equal((await f.blockers())[0]?.whose, 'operator');
  const gate = (await f.ctx.workflows.overview(f.caller, undefined, { open: true })).workflows.find(
    (item) => item.instanceId === f.unitId,
  );
  assert.deepEqual(gate?.yours?.blocker, { provider: 'code', key: 'capture' });
  const replace = f.ctx.workflows.replaceBlockers.bind(f.ctx.workflows);
  f.ctx.workflows.replaceBlockers = async () => {
    throw new Error('projection rejected');
  };
  const fence = () =>
    f.ctx.state.transaction((tx) =>
      f.ctx.code.writers.fence(f.caller, { unitId: f.unitId, requestId: 'fence' }, tx),
    );
  await assert.rejects(fence(), /projection rejected/);
  f.ctx.workflows.replaceBlockers = replace;
  const status = await f.ctx.state.transaction((tx) =>
    f.ctx.code.writers.writerStatus(f.caller, f.unitId, tx),
  );
  assert.equal(status.state, 'recovery_required');
  assert.equal((await f.blockers())[0]?.code, 'code_capture_quarantined');
  await f.app.setEnabled('code-work', false);
  await fence();
  assert.equal((await f.blockers())[0]?.code, 'code_capture_quarantined');
  await f.app.setEnabled('code-work', true);
  assert.deepEqual(await f.blockers(), []);
});

test('an owner released during its awaited mutation rejects and rolls back the binding', async (t) => {
  const f = await fixture(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const release = f.ctx.code.writers.lend({
    changed: async (_tx, _projectId, unitId) => {
      if (unitId) return;
      enter();
      await resumed;
    },
  });
  const pending = f.bind('b', 'a');
  await entered;
  release();
  resume();
  await assert.rejects(pending, { code: 'code_projection_changed' });
  assert.equal((await f.ctx.codeWork.status(f.caller)).project?.main.oid, 'a'.repeat(40));
  assert.deepEqual(await f.blockers(), []);
});

test('research observers ignore generic Code records with no research workflow owner', async (t) => {
  const f = await fixture(t);
  const unitId = 'external-tool-unit';
  await f.ctx.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_changed_at) VALUES(?,?,?,1,'closing',?)",
      f.caller.projectId,
      unitId,
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    ),
  );
  await f.ctx.code.writers.expire();
  const status = () =>
    f.ctx.state.transaction((tx) => f.ctx.code.writers.writerStatus(f.caller, unitId, tx));
  assert.equal((await status()).state, 'closed');
  await f.app.setEnabled('code-work', false);
  await f.app.setEnabled('code-work', true);
  assert.equal((await status()).state, 'closed');
  assert.deepEqual(await f.blockers(), []);
});

test('a closing writer with nothing in flight ends on the sweep past the grace and the base refusal stays', async (t) => {
  const f = await fixture(t);
  await f.bind('b', 'a');
  const closing = (ago: number) =>
    f.ctx.state.transaction((tx) =>
      tx.run(
        "UPDATE code_workspaces SET generation=1,writer_state='closing',writer_changed_at=? WHERE unit_id=?",
        new Date(Date.now() - ago).toISOString(),
        f.unitId,
      ),
    );
  // Ten minutes is inside the default 900-second grace: a worker that ended its own visit may
  // still hand over its final capture.
  await closing(600_000);
  await f.ctx.code.writers.expire();
  assert.equal(
    (await f.ctx.state.read((sql) => f.ctx.code.writers.row(sql, f.caller.projectId, f.unitId)))
      ?.writer_state,
    'closing',
  );
  await closing(901_000);
  await f.ctx.code.writers.expire();
  assert.equal(
    (await f.ctx.state.read((sql) => f.ctx.code.writers.row(sql, f.caller.projectId, f.unitId)))
      ?.writer_state,
    'closed',
  );
  assert.deepEqual(
    (await f.blockers()).map((item) => item.key),
    ['main'],
  );
  await f.app.setEnabled('code-work', false);
  await f.app.setEnabled('code-work', true);
  assert.deepEqual(
    (await f.blockers()).map((item) => item.key),
    ['main'],
  );
});

test('writer fencing preserves the accepted unit publication warning', async (t) => {
  const f = await fixture(t);
  await f.ctx.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_units SET publishes_at=? WHERE unit_id=?',
      new Date().toISOString(),
      f.unitId,
    );
    const ended = await f.observed.transition(
      f.caller,
      {
        instanceId: f.unitId,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'finish',
      },
      tx,
    );
    await f.ctx.codeWork.acceptUnit(
      f.caller,
      {
        unitId: f.unitId,
        terminalRevision: ended.revision,
        submissionRef: 'submission',
        reviewRef: 'review',
        codeRef: null,
        reviewSessionId: null,
      },
      tx,
    );
  });
  assert.equal((await f.blockers())[0]?.key, 'publication');
  await f.ctx.state.transaction((tx) =>
    tx.run(
      "UPDATE code_workspaces SET generation=1,writer_state='recovery_required',quarantine_operation_id='cop_quarantined' WHERE unit_id=?",
      f.unitId,
    ),
  );
  await f.ctx.state.transaction((tx) =>
    f.ctx.code.writers.fence(f.caller, { unitId: f.unitId, requestId: 'preserve-publication' }, tx),
  );
  assert.equal((await f.blockers())[0]?.key, 'publication');
});
