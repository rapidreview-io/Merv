import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import { CodeStore } from '@merv/code/store/operations';
import {
  configureResearchRepository,
  initializeResearchCheckConfiguration,
  researchCheck,
} from '@merv/code-work/check-configuration';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';
import { boundProject } from './fixtures/code-binding.js';

test('research configuration retains one exact journal, accepts maximum IDs, and rolls admission back on check failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'merv-check-config-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Check configuration', actorName: 'Admin' });
  const caller = await scope.caller({ kind: 'actor', actor: await scope.authenticate(boot.token) });
  const core = await createService(new CodeService(state, scope, {}));
  await boundProject(state, caller.projectId, 'a'.repeat(40));
  await initializeResearchCheckConfiguration(state);
  const store = await createService(
    new CodeStore(
      state,
      scope,
      { root, reservedFreeBytes: 1 },
      {
        imported: async () => {},
        workspaces: async () => [],
        frozen: async () => [],
        fenced: async () => {},
        advanced: async () => {},
        quarantined: async () => {},
      },
    ),
  );
  t.after(async () => {
    await store.close();
    await core.close();
    await state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const check = {
    command: 'npm test',
    timeoutSeconds: 30,
    image: { provider: 'test', offerId: 'offer', snapshotId: null },
  };
  const configure = (requestId: string, denyGlobs: string[] = []) =>
    configureResearchRepository(state, scope, store, caller, {
      requestId,
      denyGlobs,
      secretExemptGlobs: [],
      check,
    });
  const first = await configure('x');
  assert.deepEqual(await configure('x'), first);
  await assert.rejects(configure('x', ['private/**']), { code: 'request_conflict' });
  await configure('admission:x');
  await configure('a'.repeat(200));
  const journals = await state.read((sql) =>
    sql.all<{ request_id: string }>(
      "SELECT request_id FROM code_operations WHERE project_id=? AND kind='configure' ORDER BY request_id",
      caller.projectId,
    ),
  );
  assert.deepEqual(
    journals.map((row) => row.request_id),
    ['a'.repeat(200), 'admission:x', 'x'],
  );
  assert.deepEqual(await state.read((sql) => researchCheck(sql, caller.projectId)), check);
  await state.transaction((tx) =>
    tx.run(
      `CREATE FUNCTION reject_research_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected check write failure'; END $$; CREATE TRIGGER reject_research_check BEFORE UPDATE ON code_research_check_configuration FOR EACH ROW EXECUTE FUNCTION reject_research_check();`,
    ),
  );
  await assert.rejects(configure('rollback', ['private/**']));
  const limits = await state.read((sql) =>
    sql.get<{ limits_json: string }>(
      'SELECT limits_json FROM code_projects WHERE project_id=?',
      caller.projectId,
    ),
  );
  assert.deepEqual(JSON.parse(limits!.limits_json), {
    format: 1,
    denyGlobs: [],
    secretExemptGlobs: [],
  });
  assert.equal(
    await state.read((sql) =>
      sql.get(
        "SELECT id FROM code_operations WHERE project_id=? AND request_id='rollback'",
        caller.projectId,
      ),
    ),
    undefined,
  );
});
