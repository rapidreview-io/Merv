import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { test } from 'node:test';

test('assembled Main boots and restarts fenced with pending events and unchanged dispatch decisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-maintenance-boot-'));
  let app = await createApp({ directory, api: true, port: 0 });
  try {
    const credentials = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Fenced',
      actorName: 'Operator',
    });
    const state = app.ctx.state;
    const caller = { projectId: credentials.project.id, actorId: credentials.actor.id };
    const handle = await app.ctx.workflows.register({
      name: 'maintenance-probe',
      version: 1,
      initial: 'work',
      states: ['work', 'done'],
      terminal: ['done'],
      edges: [{ from: 'work', action: 'finish', to: 'done' }],
    });
    const instance = await handle.start(caller, {
      workflow: 'maintenance-probe',
      requestId: 'probe',
    });
    await app.ctx.sessions.dispatch.setDispatch(caller, { enabled: false });
    // A real held target is deliberately not yet reported. Ordinary startup repairs this;
    // maintenance must preserve even that pending decision without manufacturing a blocker.
    await state.transaction((tx) =>
      tx.run(
        `INSERT INTO session_dispatch_holds(project_id,instance_id,revision,attempts,last_code,last_message,first_at,last_at,held_at)
       VALUES(?,?,?,4,'original_retry','Preserve this decision',?,?,?)`,
        caller.projectId,
        instance.id,
        instance.revision,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ),
    );

    await state.transaction((tx) =>
      state.appendEvent(tx, {
        projectId: credentials.project.id,
        actorId: credentials.actor.id,
        type: 'probe.queued',
        subjectId: 'pending',
        data: {},
      }),
    );
    const consumers = await state.read((sql) =>
      sql.all('SELECT * FROM event_consumers ORDER BY id'),
    );
    const head = await state.eventHead();
    const dispatchTables = await state.read((sql) =>
      sql.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE '%dispatch%' ORDER BY table_name",
      ),
    );
    const snapshots = async () =>
      await Promise.all(
        dispatchTables.map(({ table_name }) =>
          app.ctx.state.read((sql) => sql.all(`SELECT * FROM ${table_name}`)),
        ),
      );
    const dispatch = await snapshots();
    const health = await fetch(`${app.ctx.api.url}/health`);
    assert.equal((await health.json()).maintenance, true);
    await app.stop();
    app = await createApp({ directory, api: true, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await app.ctx.domainEvents.drain();
    assert.equal(await app.ctx.state.eventHead(), head);
    assert.deepEqual(await snapshots(), dispatch);
    assert.deepEqual(
      await app.ctx.state.read((sql) => sql.all('SELECT * FROM event_consumers ORDER BY id')),
      consumers,
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
