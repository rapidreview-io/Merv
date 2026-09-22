import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEvent } from '@merv/contracts';
import type { CodeService } from '@merv/code-research/service';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext, finalizeGraceSeconds = 900) {
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
    'code',
    'code-research',
  ]);
  config.plugins = config.plugins.filter(({ id }) => ids.has(id));
  for (const plugin of config.plugins)
    if (plugin.id === 'code') plugin.config = { finalizeGraceSeconds };
    else if (plugin.id === 'code-research') plugin.config = {};
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { ctx } = app;
  const principal = await ctx.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await ctx.scope.createProject(principal, {
    name: 'Observed Code',
    requestId: 'project',
  });
  const caller = await ctx.scope.caller(principal, project.id);
  await ctx.workflows.register(
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
  const workflow = await ctx.workflows.start(caller, { workflow: 'observed', requestId: 'work' });
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
  await ctx.state.transaction((tx) => ctx.codeResearch.declareUnit(caller, workflow.id, tx));
  return {
    app,
    ctx,
    caller,
    unitId: workflow.id,
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
  await f.app.setEnabled('code-research', false);
  assert.equal(f.ctx.code, core);
  await f.bind('c', 'b', true);
  assert.equal((await f.blockers())[0]?.key, 'main', 'an absent adapter does not receive changes');
  await f.app.setEnabled('code-research', true);
  assert.deepEqual(await f.blockers(), []);
  await f.bind('d', 'c');
  assert.equal((await f.blockers())[0]?.key, 'main');
});

test('direct core writer changes and research blockers commit or roll back together', async (t) => {
  const f = await fixture(t);
  await f.ctx.state.transaction(async (tx) => {
    await f.ctx.codeResearch.pinBase(f.caller, { unitId: f.unitId, leaseId: 'writer' }, tx);
    await f.ctx.code.writers.reserveWriter(f.caller, { unitId: f.unitId, leaseId: 'writer' }, tx);
    for (const type of ['session.workspace_attached', 'session.closed'])
      await (f.ctx.codeResearch as CodeService).sessionChanged(
        { type, projectId: f.caller.projectId, subjectId: 'writer' } as StoredEvent,
        tx,
      );
    await tx.run(
      'UPDATE code_units SET writer_changed_at=? WHERE unit_id=?',
      '2000-01-01T00:00:00.000Z',
      f.unitId,
    );
  });
  await f.ctx.code.writers.expire();
  assert.equal((await f.blockers())[0]?.code, 'code_recovery_required');
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
  assert.equal((await f.blockers())[0]?.code, 'code_recovery_required');
  await f.app.setEnabled('code-research', false);
  await fence();
  assert.equal((await f.blockers())[0]?.code, 'code_recovery_required');
  await f.app.setEnabled('code-research', true);
  assert.deepEqual(await f.blockers(), []);
});

test('removing an observer during its awaited mutation rejects and rolls back the binding', async (t) => {
  const f = await fixture(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const unobserve = f.ctx.code.changes.observe(async (change) => {
    if (change.kind === 'binding') {
      enter();
      await resumed;
    }
  });
  const pending = f.bind('b', 'a');
  await entered;
  unobserve();
  resume();
  await assert.rejects(pending, { code: 'code_projection_changed' });
  assert.equal((await f.ctx.code.units.status(f.caller)).project?.main.oid, 'a'.repeat(40));
  assert.deepEqual(await f.blockers(), []);
});

test('research observers ignore generic Code records with no research workflow owner', async (t) => {
  const f = await fixture(t);
  const unitId = 'external-tool-unit';
  await f.ctx.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_units(project_id,unit_id,workflow,version,declared_at,generation,writer_state,writer_changed_at) VALUES(?,?,?,?,?,1,'closing',?)",
      f.caller.projectId,
      unitId,
      'external-tool',
      1,
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    ),
  );
  await f.ctx.code.writers.expire();
  const status = () =>
    f.ctx.state.transaction((tx) => f.ctx.code.writers.writerStatus(f.caller, unitId, tx));
  assert.equal((await status()).state, 'recovery_required');
  await f.ctx.state.transaction((tx) =>
    f.ctx.code.writers.fence(f.caller, { unitId, requestId: 'external-fence' }, tx),
  );
  assert.equal((await status()).state, 'closed');
  await f.app.setEnabled('code-research', false);
  await f.app.setEnabled('code-research', true);
  assert.equal((await status()).state, 'closed');
  assert.deepEqual(await f.blockers(), []);
});

test('writer recovery composes with base blockers and fencing preserves the base refusal', async (t) => {
  const f = await fixture(t, 3600);
  await f.bind('b', 'a');
  await f.ctx.state.transaction((tx) =>
    tx.run(
      "UPDATE code_units SET generation=1,writer_state='closing',writer_changed_at=? WHERE unit_id=?",
      new Date(Date.now() - 1800_000).toISOString(),
      f.unitId,
    ),
  );
  await f.ctx.code.writers.expire();
  assert.deepEqual(
    (await f.blockers()).map((item) => item.key),
    ['main'],
    'core respects the configured grace',
  );
  await f.ctx.state.transaction((tx) =>
    tx.run(
      'UPDATE code_units SET writer_changed_at=? WHERE unit_id=?',
      '2000-01-01T00:00:00.000Z',
      f.unitId,
    ),
  );
  await f.ctx.code.writers.expire();
  assert.deepEqual((await f.blockers()).map((item) => item.key).sort(), ['main', 'writer']);
  await f.ctx.state.transaction((tx) =>
    f.ctx.code.writers.fence(f.caller, { unitId: f.unitId, requestId: 'preserve-base' }, tx),
  );
  assert.deepEqual(
    (await f.blockers()).map((item) => item.key),
    ['main'],
  );
  await f.app.setEnabled('code-research', false);
  await f.app.setEnabled('code-research', true);
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
    const ended = await f.ctx.workflows.transition(
      f.caller,
      {
        instanceId: f.unitId,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'finish',
      },
      tx,
    );
    await f.ctx.codeResearch.acceptUnit(
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
    f.ctx.code.writers.fence(f.caller, { unitId: f.unitId, requestId: 'preserve-publication' }, tx),
  );
  assert.equal((await f.blockers())[0]?.key, 'publication');
});
