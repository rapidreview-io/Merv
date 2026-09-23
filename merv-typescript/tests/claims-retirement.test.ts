import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createService, digest, type Caller, type Sql } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { claimArtifactId, retireClaims } from '@merv/artifacts/claims-retirement';
import { createApp } from '../src/app.js';
import { claimsV1 } from './fixtures/claims-v1.js';
import { openState, postgresUrl, schemaFor, stateConfig } from './fixtures/state.js';

/** One database and blob store, opened directly to seed history or through the plugins to boot. */
function storage(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-claims-retirement-'));
  const schema = schemaFor(directory);
  const blobRoot = join(directory, 'blobs');
  const stops: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    schema,
    blobs: () => new DiskBlobs(blobRoot),
    async open() {
      const state = await openState(directory);
      stops.push(async () => await state.close());
      return state;
    },
    /** The artifacts plugin as a server starts it, on this same database and blob store. */
    async boot() {
      const app = await createApp({
        directory,
        config: {
          plugins: [
            { id: 'state', name: '@merv/state', config: stateConfig(directory) },
            { id: 'scope', name: '@merv/scope' },
            { id: 'blobs', name: '@merv/blobs', config: { root: blobRoot } },
            { id: 'artifacts', name: '@merv/artifacts' },
          ],
        },
      });
      stops.push(async () => await app.stop());
      return app;
    },
  };
}

const table = async (sql: Sql, name: string) =>
  Boolean((await sql.get<{ name: string | null }>('SELECT to_regclass(?) AS name', name))?.name);

interface SeededClaim {
  id: string;
  project_id: string;
  statement: string;
  scope: string;
  status: string;
  confidence: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

test('retired claims become Markdown artifacts and their tables go, events stay', async (t) => {
  const store = storage(t);
  const state = await store.open();
  const scope = await createService(new ProjectScope(state));
  await createService(new ArtifactStore(state, scope, store.blobs()));
  const first = await scope.bootstrap({ projectName: 'Retained science', actorName: 'Owner' });
  const second = await scope.bootstrap({ projectName: 'Private science', actorName: 'Other' });
  const owner: Caller = { projectId: first.project.id, actorId: first.actor.id };
  const other: Caller = { projectId: second.project.id, actorId: second.actor.id };

  // The tables exactly as the retired Claims plugin published them.
  assert.equal(
    digest(claimsV1.sql),
    'da705fe4a1574098d71f9a9674e7b09ce3d66216bf3c06d566d63dd23eb42a95',
  );
  await state.migrate('claims', [claimsV1]);
  const edited: SeededClaim = {
    id: 'claim_edited',
    project_id: owner.projectId,
    statement: 'Retrieval improves accuracy.\n\nOnly on the held-out split.',
    scope: 'Small corpus,\nseed 7',
    status: 'weakened',
    confidence: 'low',
    revision: 1,
    created_by: owner.actorId,
    updated_by: 'actor_editor',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-02T11:00:00.000Z',
  };
  const long: SeededClaim = {
    ...edited,
    id: 'claim_long',
    statement: `A long claim ${'about many things '.repeat(20)}ends here.`,
    scope: '',
    status: 'active',
    confidence: 'medium',
    revision: 0,
    updated_by: owner.actorId,
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
  };
  const foreign: SeededClaim = {
    ...long,
    id: 'claim_foreign',
    project_id: other.projectId,
    statement: 'A private claim of another project.',
    // As the legacy foundation import wrote every claim it carried over.
    created_by: 'system:legacy-import',
    updated_by: 'system:legacy-import',
  };
  assert.ok(long.statement.length > 300);
  await state.transaction(async (tx) => {
    for (const claim of [edited, long, foreign])
      await tx.run(
        'INSERT INTO claims(id,project_id,statement,scope,status,confidence,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        ...Object.values(claim),
      );
    await tx.run(
      'INSERT INTO claim_commands(project_id,actor_id,request_id,input_hash,result_json) VALUES(?,?,?,?,?)',
      owner.projectId,
      owner.actorId,
      'create-edited',
      'a'.repeat(64),
      '{}',
    );
    // What the Claims plugin recorded when the claim was created and later edited.
    await state.appendEvent(tx, {
      projectId: owner.projectId,
      actorId: owner.actorId,
      type: 'claim.created',
      subjectId: edited.id,
      data: {
        before: null,
        statement: 'Retrieval improves accuracy.',
        scope: edited.scope,
        status: 'active',
        confidence: 'medium',
        revision: 0,
      },
    });
    await state.appendEvent(tx, {
      projectId: owner.projectId,
      actorId: 'actor_editor',
      type: 'claim.updated',
      subjectId: edited.id,
      data: {
        before: { status: 'active', confidence: 'medium', revision: 0 },
        statement: edited.statement,
        scope: edited.scope,
        status: edited.status,
        confidence: edited.confidence,
        revision: edited.revision,
      },
    });
  });
  const history = await state.read((sql) =>
    sql.all<{ id: number; type: string; created_at: string }>(
      "SELECT id,type,created_at FROM events WHERE type IN ('claim.created','claim.updated') ORDER BY id",
    ),
  );
  assert.equal(history.length, 2);
  await state.close();

  const app = await store.boot();
  const artifacts = app.ctx.artifacts;
  const read = async (caller: Caller, claim: SeededClaim) =>
    await artifacts.read(caller, claimArtifactId(claim.project_id, claim.id));

  const kept = await read(owner, edited);
  assert.match(kept.artifact.id, /^art_[0-9a-f]{32}$/);
  assert.equal(kept.artifact.id, claimArtifactId(owner.projectId, edited.id));
  assert.notEqual(kept.artifact.id, claimArtifactId(other.projectId, edited.id));
  assert.deepEqual(
    { ...kept.artifact, hash: undefined, size: undefined },
    {
      id: claimArtifactId(owner.projectId, edited.id),
      projectId: owner.projectId,
      createdBy: owner.actorId,
      title: 'Claim: Retrieval improves accuracy. Only on the held-out split.',
      mediaType: 'text/markdown',
      hash: undefined,
      size: undefined,
      createdAt: edited.created_at,
    },
  );
  assert.equal(kept.encoding, 'utf8');
  const lines = kept.content.split('\n');
  for (const line of [
    '> Retrieval improves accuracy.',
    '>',
    '> Only on the held-out split.',
    '- **Status:** weakened',
    '- **Confidence:** low',
    '- **Scope:** Small corpus, seed 7',
    '- **Revision:** 1',
    `- **Created:** ${edited.created_at} by ${owner.actorId}`,
    `- **Last updated:** ${edited.updated_at} by actor_editor`,
    '- **Original claim ID:** `claim_edited`',
    '## History',
    `- ${history[0]!.created_at}: created by ${owner.actorId} (revision 0, active, medium confidence)`,
    `- ${history[1]!.created_at}: updated by actor_editor (revision 1, weakened, low confidence)`,
    '  - Statement: Retrieval improves accuracy. Only on the held-out split.',
  ])
    assert.ok(lines.includes(line), `missing line: ${line}\n${kept.content}`);
  assert.ok(
    lines.indexOf('> Retrieval improves accuracy.') < lines.indexOf('## History'),
    'the statement leads, the history follows',
  );

  const truncated = await read(owner, long);
  assert.equal(truncated.artifact.title.length, 300);
  assert.ok(truncated.artifact.title.startsWith('Claim: A long claim about many things'));
  assert.ok(truncated.artifact.title.endsWith('…'));
  assert.equal(truncated.artifact.createdAt, long.created_at);
  assert.ok(truncated.content.includes(`> ${long.statement}`), 'the file keeps it whole');
  assert.ok(truncated.content.includes('- **Scope:** (none)'));
  assert.ok(!truncated.content.includes('## History'), 'no events, no history');

  // Each claim stays in its own project.
  const private_ = await read(other, foreign);
  assert.equal(private_.artifact.createdBy, 'system:legacy-import');
  assert.ok(private_.content.includes('> A private claim of another project.'));
  assert.ok(
    private_.content.includes('imported from the previous system at the 2026-09-16 cutover'),
    'placeholder authorship is described, not presented as history',
  );
  assert.ok(!private_.content.includes('- **Revision:**'));
  for (const [file, claim] of [
    [private_, foreign],
    [kept, edited],
  ] as const) {
    const record = JSON.parse(file.content.split('```json\n')[1]!.split('\n```')[0]!);
    assert.deepEqual(
      { ...record, revision: Number(record.revision) },
      { ...claim, revision: Number(claim.revision) },
      'the stored row travels with the file',
    );
  }
  await assert.rejects(read(owner, foreign), { code: 'not_found' });
  await assert.rejects(read(other, edited), { code: 'not_found' });
  assert.deepEqual(
    (await artifacts.list(owner)).map((artifact) => artifact.id).sort(),
    [claimArtifactId(owner.projectId, edited.id), claimArtifactId(owner.projectId, long.id)].sort(),
  );

  const after = await app.ctx.state.read(async (sql) => ({
    claims: await table(sql, 'claims'),
    commands: await table(sql, 'claim_commands'),
    migrations: await sql.all("SELECT version FROM component_migrations WHERE component='claims'"),
    events: (
      await sql.all<{ id: number }>(
        "SELECT id FROM events WHERE type IN ('claim.created','claim.updated') ORDER BY id",
      )
    ).map(({ id }) => Number(id)),
    guards: await sql.all(
      "SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=? AND p.proname LIKE 'claim%'",
      store.schema,
    ),
  }));
  assert.deepEqual(after, {
    claims: false,
    commands: false,
    migrations: [],
    events: history.map(({ id }) => Number(id)),
    guards: [],
  });

  // A second start, and a direct second run, find nothing left to convert.
  const listed = await artifacts.list(owner);
  assert.equal(await retireClaims(app.ctx.state, app.ctx.blobs), 0);
  await app.stop();
  const again = await store.boot();
  assert.deepEqual(await again.ctx.artifacts.list(owner), listed);
  assert.equal((await again.ctx.artifacts.read(owner, kept.artifact.id)).content, kept.content);
});

test('a database that never held claims is left as it was', async (t) => {
  const store = storage(t);
  const app = await store.boot();
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'New science',
    actorName: 'Owner',
  });
  const owner: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const note = await app.ctx.artifacts.create(owner, { title: 'Notes', content: 'Plain.' });
  const before = await app.ctx.state.read(async (sql) => ({
    migrations: await sql.all('SELECT component,version,hash FROM component_migrations'),
    events: await sql.all('SELECT id FROM events'),
  }));
  assert.equal(await retireClaims(app.ctx.state, app.ctx.blobs), 0);
  await app.stop();
  const again = await store.boot();
  assert.deepEqual(
    (await again.ctx.artifacts.list(owner)).map((artifact) => artifact.id),
    [note.id],
  );
  assert.deepEqual(
    await again.ctx.state.read(async (sql) => ({
      migrations: await sql.all('SELECT component,version,hash FROM component_migrations'),
      events: await sql.all('SELECT id FROM events'),
    })),
    before,
  );
});

test('a server that reads while another is dropping the claims tables leaves the work to it', async (t) => {
  const store = storage(t);
  const state = await store.open();
  await state.migrate('claims', [claimsV1]);
  await state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO claims(id,project_id,statement,scope,status,confidence,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      'claim_raced',
      'proj_raced',
      'Raced.',
      '',
      'active',
      'medium',
      0,
      'actor_raced',
      'actor_raced',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
    );
  });
  // The other server's retirement, held open after its DROP.
  const other = new Pool({ connectionString: postgresUrl, max: 1 });
  const watcher = new Pool({ connectionString: postgresUrl, max: 1 });
  t.after(async () => {
    await other.end();
    await watcher.end();
  });
  const client = await other.connect();
  try {
    await client.query(`SET search_path TO "${store.schema}"`);
    await client.query('BEGIN');
    await client.query('DROP TABLE claim_commands');
    await client.query('DROP TABLE claims');
    const raced = retireClaims(state, store.blobs());
    // Wait until this server's read of the claims table is queued behind that DROP.
    for (let waited = 0; ; waited += 1) {
      const blocked = await watcher.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM claims ORDER BY%'",
      );
      if (blocked.rowCount) break;
      assert.ok(waited < 500, 'the read never waited on the DROP');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.query('COMMIT');
    assert.equal(await raced, 0);
  } finally {
    client.release();
  }
});
