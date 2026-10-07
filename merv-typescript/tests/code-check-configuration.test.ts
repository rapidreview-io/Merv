import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, createService, digest } from '@merv/contracts';
import { postgresMigrations } from '@merv/code-work/commands.postgres';
import { CodeService } from '@merv/code/service';
import { CodeStore } from '@merv/code/store/operations';
import {
  configureWorkRepository,
  initializeCheckConfiguration,
  projectCheck,
} from '@merv/code-work/check-configuration';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';
import { boundProject, codeConfig } from './fixtures/code-binding.js';
import { openRepositories } from './fixtures/code-store.js';

test('research configuration retains one exact journal, accepts maximum IDs, and rolls admission back on check failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'merv-check-config-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Check configuration',
    actorName: 'Admin',
  });
  const caller = await scope.caller({ kind: 'actor', actor: await scope.authenticate(boot.token) });
  const core = await createService(new CodeService(state, scope, codeConfig(join(root, 'core'))));
  await boundProject(state, caller.projectId, 'a'.repeat(40));
  await initializeCheckConfiguration(state);
  const repositories = await openRepositories(root);
  const store = await createService(
    new CodeStore(
      state,
      scope,
      { root, reservedFreeBytes: 1 },
      {
        changed: async () => {},
        workspaces: async () => [],
        fenced: async () => {},
        advanced: async () => {},
        quarantined: async () => {},
      },
      repositories,
    ),
  );
  t.after(async () => {
    await store.close();
    await repositories.close(0);
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
    configureWorkRepository(state, scope, store, caller, {
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
      "SELECT request_id FROM code_work_receipts WHERE project_id=? AND kind='configure' ORDER BY request_id",
      caller.projectId,
    ),
  );
  assert.deepEqual(
    journals.map((row) => row.request_id),
    ['a'.repeat(200), 'admission:x', 'x'],
  );
  assert.deepEqual(await state.read((sql) => projectCheck(sql, caller.projectId)), check);
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
        "SELECT id FROM code_work_receipts WHERE project_id=? AND request_id='rollback'",
        caller.projectId,
      ),
    ),
    undefined,
  );
});

test('a configuration answered before receipts moved to Code Work replays by its old request id', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({ projectName: 'Receipts', actorName: 'Admin' });
  const caller = await scope.caller({ kind: 'actor', actor: await scope.authenticate(boot.token) });
  const root = mkdtempSync(join(tmpdir(), 'merv-check-receipts-'));
  const core = await createService(new CodeService(state, scope, codeConfig(root)));
  t.after(async () => {
    await core.close();
    await state.close();
    rmSync(root, { recursive: true, force: true });
  });
  await boundProject(state, caller.projectId, 'a'.repeat(40));
  // A database as the release before this one left it: Code Work's commands at v2, and the
  // answered request in Code's operation journal.
  await state.migrate('code_commands', [
    { version: 1, sql: postgresMigrations[1] },
    { version: 2, sql: postgresMigrations[2] },
  ]);
  const body = { denyGlobs: [], secretExemptGlobs: [], check: null };
  const kept = { format: 1, denyGlobs: ['kept/**'], secretExemptGlobs: [], check: null };
  await state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES ('cop_old',?,?,'old','configure',?,?,'completed',?,'t','t')",
      caller.projectId,
      `actor:${caller.actorId}`,
      digest(body),
      canonical(body),
      canonical(kept),
    ),
  );
  await initializeCheckConfiguration(state);
  const configure = (requestId: string, denyGlobs: string[] = []) =>
    configureWorkRepository(state, scope, undefined as never, caller, {
      requestId,
      denyGlobs,
      secretExemptGlobs: [],
      check: null,
    });
  // The same request answers what it answered, without touching the store; other input is refused.
  assert.deepEqual(await configure('old'), kept);
  await assert.rejects(configure('old', ['other/**']), { code: 'request_conflict' });
  assert.deepEqual(
    await state.read((sql) =>
      sql.all(
        'SELECT id,kind,request_id FROM code_work_receipts WHERE project_id=? AND principal_scope=?',
        caller.projectId,
        `actor:${caller.actorId}`,
      ),
    ),
    [{ id: 'cop_old', kind: 'configure', request_id: 'old' }],
  );
});
