/**
 * Where the builder's work runs. Registering a stored version only reads it, so a restart opens
 * no write transaction. Outside any transaction, preview and replay read in a read-only snapshot
 * and never wait for State's writer lock. A render looks up each artifact its inputs name once,
 * yet fails with the same error, in the same order, as when it looked each one up itself.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import {
  createService,
  sha256Hex,
  type Artifacts,
  type Caller,
  type ContextBuild,
  type RankedContextItem,
  type Scope,
  type TaskTypeDefinition,
  type Transaction,
} from '@merv/contracts';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

const definition: TaskTypeDefinition = {
  name: 'test.placement',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the assigned evidence.',
    sections: [
      { key: 'evidence', title: 'Evidence', required: true },
      { key: 'background', title: 'Background', required: false },
      { key: 'notes', title: 'Notes', required: false },
    ],
    outputInstructions: 'Report the result with evidence.',
    maxChars: 4000,
  },
};
const subject = { id: 'assignment', revision: 1 };

async function setup(t: TestContext, options: { lockTimeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-placement-'));
  const state = await openState(directory, options);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  t.after(async () => {
    builder.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await scope.bootstrap({ projectName: 'Placement', actorName: 'Operator' });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  return { schema: schemaFor(directory), state, scope, artifacts, builder, boot, operator };
}

test('preview and replay outside a transaction never wait for the writer lock', async (t) => {
  const { schema, artifacts, builder, operator } = await setup(t, { lockTimeoutMs: 300 });
  const evidence = await artifacts.create(operator, { title: 'Proof', content: 'Result: 42.' });
  const registration = await builder.register(definition);
  const input = { subject, inputs: { evidence: { artifactIds: [evidence.id] } } };
  const saved = await registration.build(operator, { ...input, requestId: 'saved' });
  // Another instance holds this schema's writer lock.
  const holder = new pg.Client({ connectionString: postgresUrl });
  await holder.connect();
  t.after(async () => {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  });
  await holder.query('BEGIN');
  await holder.query(
    'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
    [`merv-state:${schema}`],
  );
  // A write does wait, and times out.
  await assert.rejects(registration.build(operator, { ...input, requestId: 'blocked' }), {
    code: 'state_timeout',
  });
  const { id: _id, createdAt: _createdAt, ...rendered } = saved;
  assert.deepEqual(await registration.preview(operator, input), rendered);
  assert.deepEqual(await registration.replay(operator, { subject, requestId: 'saved' }), saved);
  assert.equal(await registration.replay(operator, { subject, requestId: 'fresh' }), null);
});

test('a restart registers its stored recipe versions without a write transaction', async (t) => {
  const state = await openState();
  const stub = {} as Scope & Artifacts;
  const first = await createService(new RecipeContextBuilder(state, stub, stub));
  const definitions = [
    definition,
    { ...definition, name: 'test.placement-review', kind: 'review' },
  ];
  for (const recipe of definitions as TaskTypeDefinition[]) await first.register(recipe);
  // Before closing, mode() answers; after, it is refused like every other call.
  assert.equal(await state.transaction((tx) => first.mode({} as Caller, [], 1, tx)), 'auto');
  first.close();
  await assert.rejects(
    state.transaction((tx) => first.mode({} as Caller, [], 1, tx)),
    { code: 'context_builder_closed' },
  );

  const restarted = await createService(new RecipeContextBuilder(state, stub, stub));
  const concurrent = await createService(new RecipeContextBuilder(state, stub, stub));
  t.after(async () => {
    restarted.close();
    concurrent.close();
    await state.close();
  });
  let transactions = 0;
  const transaction = state.transaction.bind(state);
  state.transaction = ((fn: (tx: Transaction) => unknown) => {
    transactions++;
    return transaction(fn);
  }) as typeof state.transaction;
  for (const recipe of definitions as TaskTypeDefinition[]) await restarted.register(recipe);
  assert.equal(transactions, 0);
  // A stored version still pins its recipe, read without a write transaction too.
  await assert.rejects(
    concurrent.register({
      ...definition,
      name: 'test.placement-review',
      recipe: { ...definition.recipe, instructions: 'Changed.' },
    }),
    { code: 'recipe_changed' },
  );
  assert.equal(transactions, 0);
  // A new version is stored once, even when two instances both find it missing and insert it.
  const next = { ...definition, version: 2, recipe: { ...definition.recipe, maxChars: 5000 } };
  const read = state.read.bind(state);
  let missed = 0,
    release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  state.read = (async (fn: Parameters<typeof read>[0]) => {
    const result = await read(fn);
    if (++missed === 2) release();
    await both;
    return result;
  }) as typeof state.read;
  await Promise.all([restarted.register(next), concurrent.register(next)]);
  state.read = read;
  assert.equal(transactions, 2);
  await assert.rejects(concurrent.register({ ...next, name: definition.name, version: 1 }), {
    code: 'recipe_changed',
  });
  const rows = await state.read((sql) =>
    sql.all<{ version: number }>(
      'SELECT version FROM context_recipes WHERE type=? ORDER BY version',
      definition.name,
    ),
  );
  assert.deepEqual(
    rows.map((row) => Number(row.version)),
    [1, 2],
  );
});

test('a render looks up each named artifact once and fails in the same order as before', async (t) => {
  const { scope, artifacts, builder, operator } = await setup(t);
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = await artifacts.create(
    { actorId: other.actor.id, projectId: other.project.id },
    { title: 'Foreign', content: 'Private.' },
  );
  const [a, b, c] = await Promise.all(
    ['A', 'B', 'C'].map(
      async (title) => await artifacts.create(operator, { title, content: `Document ${title}.` }),
    ),
  );
  // Lookups the builder makes itself; artifacts.read looks its document up again inside.
  const lookups: string[] = [];
  let reading = 0;
  const get = artifacts.get.bind(artifacts),
    read = artifacts.read.bind(artifacts);
  artifacts.get = async (caller, id, tx) => {
    if (!reading) lookups.push(id);
    return await get(caller, id, tx);
  };
  artifacts.read = async (caller, id, range) => {
    reading++;
    try {
      return await read(caller, id, range);
    } finally {
      reading--;
    }
  };
  const registration = await builder.register(definition);
  const ranked = await builder.register({ ...definition, name: 'test.placement-ranked' });

  const legacy = await registration.preview(operator, {
    subject,
    inputs: {
      evidence: { artifactIds: [a.id, b.id] },
      background: { artifactIds: [a.id], mode: 'references' },
      notes: { artifactIds: [b.id, c.id], mode: 'auto' },
    },
  });
  assert.deepEqual(lookups, [a.id, b.id, c.id]);
  assert.deepEqual(
    legacy.sources.map((source) => source.id),
    [a.id, b.id, c.id],
  );
  const item = (id: string, artifactId: string, priority = 10): RankedContextItem => ({
    id,
    title: id,
    priority,
    content: { artifactId },
    refs: [{ tool: 'artifact.read', input: { artifactId } }],
  });
  lookups.length = 0;
  const twice = await ranked.preview(operator, {
    subject,
    inputs: {
      evidence: { rankedItems: [item('first', a.id), item('again', a.id), item('b', b.id)] },
    },
  });
  assert.deepEqual(lookups, [a.id, b.id]);
  assert.match(twice.prompt, /Document A\./);

  // The error a build fails with does not depend on which artifacts were looked up first.
  const missing = 'artifact_missing';
  const wrongHash: RankedContextItem = {
    id: 'text',
    title: 'Text',
    priority: 1,
    content: { text: 'Assigned.' },
    hash: sha256Hex('Something else.'),
    refs: [{ tool: 'task.get', input: { id: 'text' } }],
  };
  const cases: [string, Omit<ContextBuild, 'requestId'>, string][] = [
    [
      'a required section missing before a missing artifact in an optional one',
      { subject, inputs: { background: { artifactIds: [missing] } } },
      'context_missing',
    ],
    [
      'required text too large before a missing artifact in an optional section',
      {
        subject,
        inputs: {
          evidence: { text: 'x'.repeat(definition.recipe.maxChars) },
          background: { artifactIds: [missing] },
        },
      },
      'context_too_large',
    ],
    [
      'a missing artifact in a required section before duplicates in an optional one',
      {
        subject,
        inputs: {
          evidence: { artifactIds: [missing] },
          background: { artifactIds: [a.id, a.id] },
        },
      },
      'not_found',
    ],
    [
      'duplicates in a required section before a missing artifact in an optional one',
      {
        subject,
        inputs: {
          evidence: { artifactIds: [a.id, a.id] },
          background: { artifactIds: [missing] },
        },
      },
      'invalid_context',
    ],
    [
      'an unknown input before a missing artifact',
      { subject, inputs: { evidence: { artifactIds: [missing] }, unknown: { text: 'x' } } },
      'invalid_context',
    ],
    [
      'a foreign artifact',
      { subject, inputs: { evidence: { artifactIds: [a.id, foreign.id] } } },
      'not_found',
    ],
  ];
  for (const [name, input, code] of cases)
    await assert.rejects(registration.preview(operator, input), { code }, name);
  const rankedCases: [string, RankedContextItem[], string][] = [
    [
      'a missing artifact before a later wrong hash',
      [item('gone', missing), wrongHash],
      'not_found',
    ],
    [
      'a wrong hash before a later missing artifact',
      [wrongHash, item('gone', missing)],
      'invalid_context',
    ],
    ['a foreign artifact', [item('foreign', foreign.id)], 'not_found'],
  ];
  for (const [name, items, code] of rankedCases)
    await assert.rejects(
      ranked.preview(operator, { subject, inputs: { evidence: { rankedItems: items } } }),
      { code },
      name,
    );
  // A refused caller is refused before its input is judged, in preview, build and replay.
  const outsider = { actorId: operator.actorId, projectId: other.project.id };
  const invalid = { subject, inputs: { evidence: { bogus: true } } } as never;
  await assert.rejects(registration.preview(outsider, invalid), { code: 'forbidden' });
  await assert.rejects(registration.build(outsider, invalid), { code: 'forbidden' });
  await assert.rejects(registration.replay(outsider, invalid), { code: 'forbidden' });
  await assert.rejects(registration.preview(operator, invalid), { code: 'invalid_context' });
});

test('a session worker previews inside a snapshot, where nothing may write', async (t) => {
  const { state, scope, artifacts, builder, boot, operator } = await setup(t);
  const owner: Caller = { ...operator, credentialId: boot.credential.id };
  const source = await scope.delegationSource(owner);
  const worker = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      { sessionId: 'session_placement', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: worker.projectId,
    session: { id: 'session_placement' },
  };
  // The session provider vouches for the owner and records where it was asked.
  const handed: boolean[] = [];
  scope.registerSessionAuthority({
    require: async () => {
      handed.push(state.readScope);
      return source;
    },
  });
  const evidence = await artifacts.create(operator, { title: 'Proof', content: 'Result: 42.' });
  const registration = await builder.register(definition);
  const input = { subject, inputs: { evidence: { artifactIds: [evidence.id] } } };
  const preview = await state.snapshot(() => registration.preview(session, input));
  assert.equal(preview.actorId, worker.id);
  assert.match(preview.prompt, /Result: 42\./);
  assert.ok(handed.length > 0 && handed.every(Boolean), 'every decision ran in a read scope');
  assert.deepEqual(await registration.preview(session, input), preview);
  assert.equal(
    await state.snapshot(() => registration.replay(session, { subject, requestId: 'none' })),
    null,
  );
});
