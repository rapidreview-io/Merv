import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical } from '@merv/contracts';
import { initializeCodeStorage } from '../packages/code/src/storage-schema.js';
import {
  githubConnectionMigrations,
  retireGitHubConnections,
} from '../packages/code/src/github-retirement.js';
import {
  publicationMigrations,
  migratePublications,
} from '../packages/code-work/src/publications-schema.js';
import { openState } from './fixtures/state.js';

test('GitHub retirement erases connection secrets, stops queued activity and preserves admitted transfers', async () => {
  const state = await openState();
  await initializeCodeStorage(state);
  await state.migrate('code_github', githubConnectionMigrations.slice(0, 2));
  await state.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO code_github(project_id,credentials,automation) VALUES('p','old-encrypted-secret','write')",
    );
    await tx.run(
      "INSERT INTO code_github_flows VALUES('f','p','owner',0,'browser','2099','ready','old-oauth-secret')",
    );
    for (const [id, kind, phase, source] of [
      ['mirror', 'mirror-work', 'queued', 'mirror'],
      ['unreceived', 'import', 'receiving', 'github'],
      ['admitted', 'import', 'objects_durable', 'github'],
      ['bundle', 'import', 'receiving', 'bundle'],
    ])
      await tx.run(
        "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,phase) VALUES(?,'p','owner',?,?,'hash',?,'prepared','then',?)",
        id,
        id,
        kind,
        canonical({ source }),
        phase,
      );
  });
  await retireGitHubConnections(state);
  const snapshot = () =>
    state.read(async (sql) => ({
      tables: await sql.get(
        "SELECT to_regclass('code_github') AS connection,to_regclass('code_github_flows') AS flow",
      ),
      operations: await sql.all<{ id: string; status: string; error: string | null }>(
        'SELECT id,status,error FROM code_operations ORDER BY id',
      ),
    }));
  const result = await snapshot();
  assert.deepEqual(result.tables, { connection: null, flow: null });
  assert.deepEqual(result.operations, [
    { id: 'admitted', status: 'prepared', error: null },
    { id: 'bundle', status: 'prepared', error: null },
    { id: 'mirror', status: 'failed', error: 'github_integration_retired' },
    { id: 'unreceived', status: 'failed', error: 'github_integration_retired' },
  ]);
  await retireGitHubConnections(state);
  assert.deepEqual(
    await snapshot(),
    result,
    'replay neither requeues nor deletes historical operations',
  );
});

test('pending external publication gets one local successor without rewriting reviewed facts or external intent', async () => {
  const state = await openState();
  await state.migrate('code_publications', publicationMigrations.slice(0, 3));
  const record = canonical({
    destination: 'github',
    proposalId: 'codeprop_old',
    instanceId: 'unit',
    headOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
    baseOid: 'c'.repeat(40),
    approval: {
      acceptanceHash: 'accepted',
      certificateHash: 'certificate',
      integrationBase: 'c'.repeat(40),
    },
  });
  const review = canonical({ id: 'review', actorId: 'independent', verdict: 'pass' });
  const external = canonical({
    number: 9,
    url: 'https://github.com/example/repo/pull/9',
    state: 'open',
  });
  const intent = canonical({ requestId: 'merge-intent', actorId: 'owner' });
  await state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json,review_json,pull_json,merge_json) VALUES(?,?,?,?,?,?,?)',
      'codeprop_old',
      'p',
      record,
      '{"repository":{"id":1,"fullName":"example/repo"},"revision":1,"baseBranch":"main"}',
      review,
      external,
      intent,
    );
    await tx.run(
      'INSERT INTO code_review_acceptances VALUES(?,?,?,?,?)',
      'p',
      'unit',
      'review',
      '{"retained":"unchanged"}',
      'then',
    );
  });
  await migratePublications(state);
  const rows = () =>
    state.read((sql) => sql.all<any>('SELECT * FROM code_publications ORDER BY proposal_id'));
  const result = await rows();
  assert.equal(result.length, 2);
  const old = result.find((r) => r.proposal_id === 'codeprop_old')!;
  const local = result.find((r) => r.proposal_id === old.successor)!;
  assert.equal(old.record_json, record);
  assert.equal(old.review_json, review);
  assert.equal(old.pull_json, external);
  assert.equal(old.merge_json, intent);
  assert.equal(old.settled, 1);
  assert.equal(old.error, 'github_integration_retired');
  assert.equal(local.settled, 0);
  assert.equal(local.review_json, review);
  assert.equal(JSON.parse(local.record_json).destination, 'local');
  assert.equal(JSON.parse(local.record_json).headOid, 'a'.repeat(40));
  assert.deepEqual(JSON.parse(local.record_json).approval, JSON.parse(record).approval);
  await migratePublications(state);
  assert.deepEqual(await rows(), result, 'replay creates no additional successor');
  assert.deepEqual(
    await state.read((sql) => sql.all('SELECT acceptance_json FROM code_review_acceptances')),
    [{ acceptance_json: '{"retained":"unchanged"}' }],
  );
  await assert.rejects(state.transaction((tx) => tx.run('DELETE FROM code_publications')));
  await assert.rejects(
    state.transaction((tx) =>
      tx.run("UPDATE code_publications SET record_json='{}' WHERE proposal_id='codeprop_old'"),
    ),
  );
});
