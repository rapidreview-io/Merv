import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import {
  migratePendingMerges,
  pendingMerge,
  pinMerge,
} from '../packages/code/src/pending-merge.js';
import { backends, optional } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';
import { boundProject } from './fixtures/code-binding.js';

for (const backend of backends)
  test(
    `${backend}: pending-merge migration preserve populated owner databases and enforce write-once facts`,
    optional(backend),
    async (t) => {
      const f = await resolutionFixture(t, backend);
      const task = await f.tasks.create(f.admin, {
        title: 'Existing task',
        goal: 'Keep the existing work readable.',
        checks: ['Existing evidence is retained.'],
        requestId: 'existing',
      });
      const beforeTask = await f.tasks.get(f.admin, task.id);
      const migrate = f.state.migrate.bind(f.state);
      f.state.migrate = async (component, migrations) => {
        if (component !== 'code_pending_merges') await migrate(component, migrations);
      };
      const code = await createService(
        new CodeService(f.state, f.scope, f.sessions, f.artifacts, f.workflows),
      );
      f.beforeClose.push(() => code.close());
      f.state.migrate = migrate;
      await boundProject(f.state, f.admin.projectId, 'a'.repeat(40));
      await f.state.transaction((tx) => code.declareUnit(f.admin, task.id, tx));
      const beforeUnit = await code.unit(f.admin, task.id);
      await migratePendingMerges(f.state);
      assert.deepEqual(await f.tasks.get(f.admin, task.id), beforeTask);
      assert.deepEqual(await code.unit(f.admin, task.id), beforeUnit);
      await f.state.transaction(async (tx) => {
        await pinMerge(
          tx,
          f.admin.projectId,
          task.id,
          'd'.repeat(64),
          'a'.repeat(40),
          'b'.repeat(40),
        );
        await tx.run(
          'UPDATE code_pending_merges SET head_oid=?,first_merge=? WHERE unit_id=?',
          'c'.repeat(40),
          'c'.repeat(40),
          task.id,
        );
      });
      for (const set of [
        "plan_key='changed'",
        "left_oid='changed'",
        "right_oid='changed'",
        'first_merge=NULL',
      ])
        await assert.rejects(
          f.state.transaction((tx) =>
            tx.run(`UPDATE code_pending_merges SET ${set} WHERE unit_id=?`, task.id),
          ),
        );
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run('DELETE FROM code_pending_merges WHERE unit_id=?', task.id),
        ),
      );
      const checkpoint = await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, task.id));
      await migratePendingMerges(f.state);
      assert.deepEqual(
        await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, task.id)),
        checkpoint,
      );
    },
  );

test('the driver retains merge metadata and start receipts in its existing workspace and transfer rows', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { CodeWorkspaceDriver } = await import('../packages/code/src/driver/index.js');
  const directory = mkdtempSync(join(tmpdir(), 'merge-ledger-migration-'));
  const path = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = { directory, path, terminal: () => false };
  const transport = {
    call: async () => ({}),
    putPart: async () => ({}),
    readPart: async () => new Uint8Array(),
  };
  const initial = new CodeWorkspaceDriver(host, transport);
  initial.dispose();
  const db = new DatabaseSync(path);
  db.exec(
    "INSERT INTO code_v2_repositories VALUES ('project','repository','sha1','cache','ready');",
  );
  const before = db.prepare('SELECT * FROM code_v2_repositories').all();
  const reopened = new CodeWorkspaceDriver(host, transport);
  assert.deepEqual(db.prepare('SELECT * FROM code_v2_repositories').all(), before);
  db.prepare(
    `INSERT INTO code_v2_workspaces(launch_id, session_id, runner_id, project_ref, unit_id, path, policy_json, read_only, base_oid, head_oid, repository_id, status, pending_merge)
    VALUES ('launch', 'session', 'runner', 'project', 'unit', 'path', '{}', 0, 'base', 'head', 'repository', 'ready', ?)`,
  ).run(JSON.stringify({ plan: 'plan' }));
  db.prepare(
    `INSERT INTO code_v2_transfers(request_id, launch_id, kind, expected_head, merge_tree) VALUES ('command', 'launch', 'checkpoint', 'head', ?)`,
  ).run('a'.repeat(40));
  assert.equal(
    db.prepare('SELECT pending_merge FROM code_v2_workspaces').get()!.pending_merge,
    JSON.stringify({ plan: 'plan' }),
  );
  assert.equal(
    db.prepare('SELECT merge_tree FROM code_v2_transfers').get()!.merge_tree,
    'a'.repeat(40),
  );
  assert.throws(() => db.exec("UPDATE code_v2_transfers SET merge_tree='changed'"), /immutable/);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'code_v2_merge_%'",
      )
      .get()!.n,
    0,
  );
  reopened.dispose();
  db.close();
});
