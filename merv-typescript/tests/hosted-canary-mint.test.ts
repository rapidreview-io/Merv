import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProjectScope } from '@merv/scope';
import { openState, schemaFor, postgresUrl } from './fixtures/state.js';

const vm = fileURLToPath(new URL('../deploy/hosted-release-vm.py', import.meta.url));
const mint = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("vm",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.MINT))',
      vm,
    ],
    { encoding: 'utf8' },
  ),
) as string;
// Execute the production mint body against real Scope/Postgres in disposable t_* test schemas.
function runMint(projectId: string, schema: string, program = mint) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      program.replace(
        "import { deploymentSchema } from '/app/deploy/schema.mjs';",
        'const deploymentSchema=()=>process.env.MERV_TS_DB_SCHEMA;',
      ),
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        MERV_DB_URL: postgresUrl,
        MERV_TS_DB_SCHEMA: schema,
        MERV_CANARY_PROJECT: projectId,
        MERV_CANARY_NAME: 'Hosted release canary',
      },
    },
  );
}

test('mint refuses member-only operators without creating credentials or changing membership', async () => {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = new ProjectScope(state);
  await scope.initialize();
  const human = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://fixture.example',
    subject: 'operator',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const project = await scope.members.createProject(human, {
    name: 'Member project',
    requestId: 'fixture',
  });
  const before = await state.eventHead();
  const snapshot = () =>
    state.read(async (sql) => ({
      actors: await sql.all('SELECT * FROM actors ORDER BY id'),
      credentials: await sql.all('SELECT * FROM actor_credentials ORDER BY id'),
      memberships: await sql.all('SELECT * FROM project_memberships ORDER BY id'),
    }));
  const original = await snapshot();
  const oldSelection = mint.replace(
    ' AND NOT EXISTS(SELECT 1 FROM member_actors m WHERE m.actor_id=a.id)',
    '',
  );
  const reproduced = runMint(project.id, schema, oldSelection);
  assert.notEqual(reproduced.status, 0);
  assert.match(reproduced.stderr, /Member actors require verified human authority/);
  const result = runMint(project.id, schema);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no active independent nonmember operator/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await snapshot(), original);
  assert.equal(await state.eventHead(), before);
});

test('mint uses an existing independent operator and rotates only its existing machine reader tokens', async () => {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = new ProjectScope(state);
  await scope.initialize();
  const boot = await scope.credentials.bootstrap({
    projectName: 'Machine project',
    actorName: 'Service operator',
  });
  const first = runMint(boot.project.id, schema);
  assert.equal(first.status, 0, first.stderr);
  const one = JSON.parse(first.stdout);
  assert.equal((await scope.authenticate(one.token)).role, 'reader');
  const second = runMint(boot.project.id, schema);
  assert.equal(second.status, 0, second.stderr);
  const two = JSON.parse(second.stdout);
  assert.equal(two.actorId, one.actorId);
  assert.notEqual(two.credentialId, one.credentialId);
  await assert.rejects(scope.authenticate(one.token));
  assert.equal((await scope.authenticate(two.token)).role, 'reader');
});
