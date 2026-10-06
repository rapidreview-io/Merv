import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createService } from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';
import { boundProject } from './fixtures/code-binding.js';

test('standalone Code stores writer inputs and retained commits without research tables', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const code = await createService(new CodeService(state, scope, {}));
  t.after(async () => {
    await code.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({
    projectName: 'Technical code',
    actorName: 'Owner',
  });
  const caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const commit = 'a'.repeat(40);
  const retainer = { projectId: caller.projectId, actorId: caller.actorId };
  await state.transaction(async (tx) => {
    await code.units.declareWorkspace(caller, { unitId: 'writer' }, tx);
    await code.units.pinWorkspace(caller, { unitId: 'writer', reference: commit }, tx);
    await code.units.retainStoredCommit(tx, {
      ...retainer,
      key: 'external-baseline',
      unitId: 'writer',
      commit,
      storage: 'external',
    });
  });
  const tables = await state.read((sql) =>
    sql.all<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'",
    ),
  );
  for (const table of [
    'code_units',
    'code_review_acceptances',
    'code_bases',
    'code_publications',
    'code_proposals',
    'wf_instances',
    'reviews',
  ])
    assert.ok(
      !tables.some(({ name }) => name === table),
      `${table} must not be initialized by Code`,
    );
  const retained = await state.read((sql) =>
    sql.get<{ commit_oid: string; storage: string }>(
      'SELECT commit_oid,storage FROM code_retained_commits WHERE project_id=? AND retention_key=?',
      caller.projectId,
      'external-baseline',
    ),
  );
  assert.deepEqual(retained, { commit_oid: commit, storage: 'external' });
  await assert.rejects(
    state.transaction((tx) =>
      code.units.retainStoredCommit(tx, {
        ...retainer,
        key: 'external-baseline',
        unitId: 'writer',
        commit: 'b'.repeat(40),
        storage: 'external',
      }),
    ),
    { code: 'code_retention_conflict' },
  );
  await boundProject(state, caller.projectId, commit);
  await state.transaction((tx) =>
    code.units.setMainStored(tx, {
      projectId: caller.projectId,
      expectedOid: commit,
      oid: 'b'.repeat(40),
      actorId: caller.actorId,
    }),
  );
  const main = await state.read((sql) =>
    sql.get<{ main_json: string }>(
      'SELECT main_json FROM code_projects WHERE project_id=?',
      caller.projectId,
    ),
  );
  await assert.rejects(
    state.transaction((tx) =>
      code.units.setMainStored(tx, {
        projectId: caller.projectId,
        expectedOid: commit,
        oid: 'c'.repeat(40),
        actorId: caller.actorId,
      }),
    ),
    { code: 'code_main_changed' },
  );
  assert.deepEqual(
    await state.read((sql) =>
      sql.get('SELECT main_json FROM code_projects WHERE project_id=?', caller.projectId),
    ),
    main,
  );
  await code.close();
  await assert.rejects(
    state.transaction((tx) =>
      code.units.retainStoredCommit(tx, {
        ...retainer,
        key: 'after-close',
        unitId: 'writer',
        commit: 'c'.repeat(40),
        storage: 'external',
      }),
    ),
    { code: 'code_unavailable' },
  );
  assert.equal(
    await state.read((sql) =>
      sql.get(
        'SELECT retention_key FROM code_retained_commits WHERE project_id=? AND retention_key=?',
        caller.projectId,
        'after-close',
      ),
    ),
    undefined,
  );
});
