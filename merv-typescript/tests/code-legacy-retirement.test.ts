import assert from 'node:assert/strict';
import test from 'node:test';
import type { Migration, State } from '@merv/contracts';
import { postgresGuard } from '../packages/code/src/postgres-guard.js';
import { migratePublications } from '../packages/code-research/src/publications-schema.js';
import { postgresMigrations as commands } from '../packages/code-research/src/commands.postgres.js';
import { openState } from './fixtures/state.js';

/** The retired components as production created them, so the upgrade starts where it does. */
const proposals = `
CREATE TABLE code_proposals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL, proposal_json TEXT NOT NULL
);
${postgresGuard('code_proposals', 'no_update', 'UPDATE', 'Code proposals are immutable')}
${postgresGuard('code_proposals', 'no_delete', 'DELETE', 'Code proposals are retained')}`;
const transport = `CREATE TABLE code_github_workspaces (session_id TEXT PRIMARY KEY);
CREATE TABLE code_github_pushes (id TEXT PRIMARY KEY);`;

const approval = (source?: string) => ({
  ...(source ? { source } : {}),
  integrationBase: 'a'.repeat(40),
  certificateHash: null,
  acceptanceHash: 'f'.repeat(64),
});

test('retiring proposals and the GitHub transport drops their records and keeps every other publication', async () => {
  const state = await openState();
  try {
    await state.migrate('code_proposals', [{ version: 1, sql: proposals }]);
    await state.migrate('code_github_transport', [{ version: 1, sql: transport }]);
    await state.migrate('code_commands', [{ version: 1, sql: commands[1] }]);
    // The publications as they stood before this release.
    await migratePublications({
      migrate: (component: string, migrations: Migration[]) =>
        state.migrate(component, migrations.slice(0, 2)),
    } as unknown as State);
    await state.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO code_proposals VALUES('codeprop_legacy','project','instance','{}')",
      );
      for (const [id, record] of [
        ['codeprop_legacy', { proposalId: 'codeprop_legacy' }],
        ['codeprop_unit', { proposalId: 'codeprop_unit', approval: approval('unit') }],
        ['codeprop_consolidation', { proposalId: 'codeprop_consolidation', approval: approval() }],
      ] as const) {
        await tx.run(
          'INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json) VALUES(?,?,?,?)',
          id,
          'project',
          JSON.stringify(record),
          'null',
        );
        await tx.run(
          'INSERT INTO code_publication_requests VALUES(?,?,?,?,?)',
          'project',
          'actor',
          `merge-${id}`,
          'hash',
          JSON.stringify({ proposalId: id }),
        );
      }
    });

    await state.migrate('code_commands', [
      { version: 1, sql: commands[1] },
      { version: 2, sql: commands[2] },
    ]);
    await migratePublications(state);

    const left = await state.read(async (sql) => ({
      tables: await sql.all<{ name: string | null }>(
        "SELECT to_regclass('code_proposals')::text AS name UNION ALL SELECT to_regclass('code_github_workspaces')::text UNION ALL SELECT to_regclass('code_github_pushes')::text",
      ),
      components: await sql.all<{ component: string }>(
        "SELECT component FROM component_migrations WHERE component IN ('code_proposals','code_github_transport')",
      ),
      publications: await sql.all<{ proposal_id: string }>(
        'SELECT proposal_id FROM code_publications ORDER BY proposal_id',
      ),
      requests: await sql.all<{ request_id: string }>(
        'SELECT request_id FROM code_publication_requests ORDER BY request_id',
      ),
    }));
    assert.deepEqual(
      left.tables.map((row) => row.name),
      [null, null, null],
    );
    assert.deepEqual(left.components, []);
    assert.deepEqual(
      left.publications.map((row) => row.proposal_id),
      ['codeprop_consolidation', 'codeprop_unit'],
    );
    assert.deepEqual(
      left.requests.map((row) => row.request_id),
      ['merge-codeprop_consolidation', 'merge-codeprop_unit'],
    );
    // The retention guards are back on once the retired rows are gone.
    await assert.rejects(
      state.transaction((tx) => tx.run('DELETE FROM code_publications')),
      /Database constraint rejected the operation/,
    );
    await assert.rejects(
      state.transaction((tx) => tx.run('DELETE FROM code_publication_requests')),
      /Database constraint rejected the operation/,
    );
  } finally {
    await state.close();
  }
});
