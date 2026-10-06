import assert from 'node:assert/strict';
import test from 'node:test';
import { createService, canonical, now } from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import { CodeMirrorService, enqueueMirror } from '@merv/code/store/mirror';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';
import { codeStoreFixture, gitSource } from './fixtures/code-store.js';

test('retention refuses impossible transport before persisting an obligation', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const code = await createService(new CodeService(state, scope, {}));
  t.after(async () => {
    await code.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({
    projectName: 'Retention safety',
    actorName: 'Owner',
  });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const commit = 'a'.repeat(40);
  for (const input of [
    { key: 'missing-workspace', unitId: 'absent', commit, mirror: true },
    {
      key: 'external-mirror',
      unitId: 'absent',
      commit,
      storage: 'external' as const,
      mirror: true,
    },
    {
      key: 'external-ref',
      unitId: 'absent',
      commit,
      storage: 'external' as const,
      ref: 'refs/merv/explicit',
    },
  ])
    await assert.rejects(
      state.transaction((tx) =>
        code.units.retainStoredCommit(tx, { ...input, projectId: caller.projectId }),
      ),
      {
        code:
          input.storage === 'external'
            ? 'code_retention_transport_invalid'
            : 'code_workspace_required',
      },
    );
  assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM code_retained_commits')), []);
  assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM code_operations')), []);
});

test('retention freezes its ref in the immutable intent and rejects tampered recovery', async (t) => {
  const source = gitSource(t);
  const commit = source.commit({ 'file.txt': 'retained\n' });
  const f = await codeStoreFixture(t, {}, commit);
  await f.deliver(source.bundle(commit));
  const ref = 'refs/merv/explicit/snapshot',
    altered = 'refs/merv/explicit/altered';
  const input = { key: 'snapshot', unitId: 'workspace', commit, ref };
  await f.state.transaction(async (tx) => {
    await f.core.units.declareWorkspace(f.admin, { unitId: input.unitId }, tx);
    await f.core.units.retainStoredCommit(tx, { ...input, projectId: f.admin.projectId });
    const row = await tx.get<{ id: string; payload_json: string; progress_json: string }>(
      "SELECT id,payload_json,progress_json FROM code_operations WHERE kind='retain-ref'",
    );
    assert.equal(JSON.parse(row!.payload_json).ref, ref);
    await tx.run(
      'UPDATE code_operations SET progress_json=? WHERE id=?',
      canonical({ ...JSON.parse(row!.progress_json), receiptRef: altered }),
      row!.id,
    );
  });
  await assert.rejects(
    f.state.transaction((tx) =>
      f.core.units.retainStoredCommit(tx, { ...input, projectId: f.admin.projectId }),
    ),
    { code: 'code_retention_conflict' },
  );
  await f.code.maintainStore();
  const operation = await f.state.read((sql) =>
    sql.get<{ status: string; progress_json: string }>(
      "SELECT status,progress_json FROM code_operations WHERE kind='retain-ref'",
    ),
  );
  assert.equal(operation!.status, 'prepared');
  assert.equal(JSON.parse(operation!.progress_json).waiting.code, 'code_retention_intent_changed');
  assert.ok(
    !f.refs().some((value) => value.startsWith(`${altered} `) || value.startsWith(`${ref} `)),
  );
});

test('mirror replay preserves its destination while allowing work-tip coalescing', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const code = await createService(new CodeService(state, scope, {}));
  t.after(async () => {
    await code.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({
    projectName: 'Mirror destinations',
    actorName: 'Owner',
  });
  const projectId = boot.project.id,
    tip = 'a'.repeat(40),
    ref = 'refs/merv/explicit/original';
  await state.transaction((tx) =>
    enqueueMirror(tx, projectId, 'mirror-work', 'workspace', tip, ref),
  );
  await state.transaction((tx) =>
    enqueueMirror(tx, projectId, 'mirror-work', 'workspace', 'b'.repeat(40), ref),
  );
  await assert.rejects(
    state.transaction((tx) =>
      enqueueMirror(tx, projectId, 'mirror-work', 'workspace', tip, 'refs/merv/explicit/changed'),
    ),
    { code: 'code_mirror_ref_conflict' },
  );
  await state.transaction((tx) =>
    tx.run(
      "UPDATE code_operations SET status='completed',result_json='{}',completed_at=? WHERE kind='mirror-work'",
      now(),
    ),
  );
  await assert.rejects(
    state.transaction((tx) =>
      enqueueMirror(tx, projectId, 'mirror-work', 'workspace', tip, 'refs/merv/explicit/changed'),
    ),
    { code: 'code_mirror_ref_conflict' },
  );
  const rows = await state.read((sql) =>
    sql.all<{ payload_json: string }>('SELECT payload_json FROM code_operations'),
  );
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload_json).ref, ref);
});

test('a work head advancing during a mirror push requeues the same explicit destination', async (t) => {
  const source = gitSource(t);
  const first = source.commit({ 'file.txt': 'first\n' });
  const second = source.commit({ 'file.txt': 'second\n' });
  const f = await codeStoreFixture(t, {}, first);
  await f.deliver(source.bundle(second));
  const ref = 'refs/merv/explicit/work';
  await f.state.transaction(async (tx) => {
    await f.core.units.declareWorkspace(f.admin, { unitId: 'writer' }, tx);
    await tx.run('UPDATE code_workspaces SET head_oid=? WHERE unit_id=?', first, 'writer');
    await enqueueMirror(tx, f.admin.projectId, 'mirror-work', 'writer', first, ref);
  });
  const pushed: { ref: string; oid: string }[] = [];
  const remote = new Map<string, string>();
  const mirror = new CodeMirrorService(
    f.state,
    f.scope,
    f.core.repositories!,
    {
      target: async () => ({ repository: 'fixture/remote' }),
      lsRemote: async (_projectId, name) => remote.get(name) ?? null,
      push: async (_projectId, update) => {
        pushed.push({ ref: update.ref, oid: update.oid });
        remote.set(update.ref, update.oid);
        if (pushed.length === 1)
          await f.state.transaction((tx) =>
            tx.run('UPDATE code_workspaces SET head_oid=? WHERE unit_id=?', second, 'writer'),
          );
        return 'ok';
      },
    },
    { mirrorSeconds: 0 },
  );
  t.after(() => mirror.close());
  await mirror.run();
  await mirror.run();
  assert.deepEqual(pushed, [
    { ref: 'refs/heads/merv/explicit/work', oid: first },
    { ref: 'refs/heads/merv/explicit/work', oid: second },
  ]);
});
