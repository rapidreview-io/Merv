import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import {
  digest,
  type Caller,
  type ContextBuild,
  type ContextItem,
  type ContextPreview,
  type TaskTypeDefinition,
  type Transaction,
} from '@merv/contracts';
import { buildContext, contextSource } from './fixtures/context.js';
import { countWrites, openState, storedContext } from './fixtures/state.js';

const definition: TaskTypeDefinition = {
  name: 'test.preview',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the assigned evidence.',
    sections: [
      { key: 'background', title: 'Background', required: false },
      { key: 'evidence', title: 'Evidence', required: true },
      { key: 'notes', title: 'Notes', required: false },
    ],
    outputInstructions: 'Report the result with evidence.',
    maxChars: 1600,
    format: 2,
  },
};
const text = (id: string, body: string, rest: Partial<ContextItem> = {}) => ({
  items: [{ id, title: id, body: { text: body }, ...rest }],
});
/** Artifacts as items, embedded as `embed` says. */
const docs = (ids: string[], embed?: ContextItem['embed']) => ({
  items: ids.map((id) => ({
    id,
    title: id,
    body: { artifactId: id },
    ...(embed ? { embed } : {}),
  })),
});

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-preview-'));
  const state = await openState(directory);
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
  const identity = await scope.bootstrap({ projectName: 'Preview', actorName: 'Operator' });
  const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
  // INSERT/UPDATE/DELETE statements issued through the state, rolled back or not.
  const changes = countWrites(state);
  const packageCount = async () =>
    await state.read(
      async (sql) =>
        (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM context_packages'))!.n,
    );
  return { directory, state, scope, artifacts, builder, operator, changes, packageCount };
}

test('preview renders the exact future package without creating IDs, timestamps, receipts or events', async (t) => {
  const { state, artifacts, builder, operator, changes, packageCount } = await setup(t);
  const evidence = await artifacts.create(operator, {
    title: 'Proof',
    content: 'The exact result is 42.',
  });
  const registration = await builder.register(definition);
  const input: Omit<ContextBuild, 'requestId'> = {
    subject: { id: 'assignment', revision: 3, claimId: 'claim-current' },
    inputs: {
      background: text('background', 'x'.repeat(1500)),
      evidence: docs([evidence.id]),
      notes: text('notes', 'Use the retained receipt.'),
    },
  };
  const before = await changes();
  const eventHead = await state.eventHead();
  const preview = await registration.preview(operator, input);
  assert.equal(await changes(), before);
  assert.equal(await state.eventHead(), eventHead);
  assert.equal(await packageCount(), 0);
  assert.ok(!Object.hasOwn(preview, 'id'));
  assert.ok(!Object.hasOwn(preview, 'createdAt'));
  assert.ok(!Object.hasOwn(preview, 'requestId'));
  assert.deepEqual(preview.omitted, ['background']);
  assert.deepEqual(preview.sources, [contextSource(evidence)]);
  assert.match(preview.prompt, /The exact result is 42/);
  assert.match(preview.prompt, /Use the retained receipt/);
  assert.ok(preview.prompt.length <= definition.recipe.maxChars);
  const { hash, ...body } = preview;
  assert.equal(hash, digest(body));
  assert.equal(
    await registration.replay(operator, { subject: input.subject, requestId: 'begin' }),
    null,
  );
  const built = await buildContext(registration, operator, { ...input, requestId: 'begin' });
  const { id, createdAt, ...savedPreview } = built;
  assert.match(id, /^context_/);
  assert.ok(createdAt);
  assert.deepEqual(savedPreview, preview);
  assert.equal(await packageCount(), 1);
  assert.ok((await changes()) > before, 'the write counter sees the saved build');
  assert.equal(await state.eventHead(), eventHead + 1);
  assert.deepEqual(
    await registration.replay(operator, { subject: input.subject, requestId: 'begin' }),
    built,
  );

  // Returned DTOs cannot rewrite an assignment, a source manifest, or its durable package.
  preview.subject.revision = 99;
  preview.sources[0].title = 'Modified outside the builder';
  preview.omitted.push('evidence');
  preview.prompt = 'Modified outside the builder';
  input.subject.revision = 7;
  assert.deepEqual(await storedContext(state, id), built);
  assert.equal((await artifacts.get(operator, evidence.id)).title, 'Proof');
  assert.equal(
    (await registration.preview(operator, { ...input, subject: built.subject })).hash,
    hash,
  );
});

test('build saves only an unchanged preview this registration rendered for its caller, once per request ID', async (t) => {
  const { state, scope, builder, operator, changes, packageCount } = await setup(t);
  const registration = await builder.register(definition);
  const sibling = await builder.register({ ...definition, name: 'test.preview-sibling' });
  const producer: Caller = {
    actorId: (await scope.issueActor(operator, { name: 'Producer', role: 'producer' })).actor.id,
    projectId: operator.projectId,
  };
  const input = {
    subject: { id: 'assignment', revision: 0 },
    inputs: { evidence: text('evidence', 'Verified.') },
  };
  const preview = await registration.preview(operator, input);
  const { hash, ...body } = preview;
  const forged = { ...body, prompt: 'Forged.' };
  const before = await changes();
  const eventHead = await state.eventHead();
  const refused: [string, unknown, Caller?][] = [
    ['a copy', { ...preview }],
    ['a clone', structuredClone(preview)],
    ['a forged preview with its own hash', { ...forged, hash: digest(forged) }],
    ['a preview of another recipe', await sibling.preview(operator, input)],
    ['a preview rendered for another caller', preview, producer],
    ['no preview', undefined],
  ];
  for (const [name, candidate, caller = operator] of refused)
    await assert.rejects(
      registration.build(caller, { requestId: 'refused', preview: candidate as ContextPreview }),
      { code: 'invalid_context' },
      name,
    );
  // Changed in place after rendering, whether or not its hash is changed to match.
  preview.prompt = 'Changed outside the builder';
  await assert.rejects(registration.build(operator, { requestId: 'changed', preview }), {
    code: 'invalid_context',
  });
  const { hash: _hash, ...changed } = preview;
  preview.hash = digest(changed);
  await assert.rejects(registration.build(operator, { requestId: 'rehashed', preview }), {
    code: 'invalid_context',
  });
  preview.hash = hash;
  // Changed into something that cannot be copied, or cannot be hashed.
  for (const [name, value] of [
    ['a function', () => 'Changed'],
    ['a bigint', 1n],
  ] as const) {
    Object.assign(preview, { prompt: value });
    await assert.rejects(
      registration.build(operator, { requestId: 'uncopyable', preview }),
      { code: 'invalid_context' },
      name,
    );
  }
  preview.prompt = body.prompt;
  for (const save of [
    { requestId: ' ', preview },
    { requestId: 'extra', preview, inputs: input.inputs },
  ])
    await assert.rejects(registration.build(operator, save), { code: 'invalid_context' });
  assert.equal(await changes(), before);
  assert.equal(await state.eventHead(), eventHead);

  // Concurrent builds under one request ID save one package, which both return.
  const again = await registration.preview(operator, input);
  const [first, second] = await Promise.all([
    registration.build(operator, { requestId: 'once', preview }),
    registration.build(operator, { requestId: 'once', preview: again }),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.hash, hash);
  assert.equal(await packageCount(), 1);
  assert.equal(await state.eventHead(), eventHead + 1);
  registration.dispose();
  await assert.rejects(registration.build(operator, { requestId: 'disposed', preview }), {
    code: 'recipe_unavailable',
  });
});

test('context requests retain their caller and assignment across authorization', async (t) => {
  const { scope, builder, operator } = await setup(t);
  const identity = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const other = { actorId: identity.actor.id, projectId: identity.project.id };
  const registration = await builder.register(definition);
  const original = {
    subject: { id: 'assignment', revision: 3 },
    inputs: { evidence: text('evidence', 'Original evidence') },
    requestId: 'original',
  };
  const built = await buildContext(registration, operator, original);
  const { id, createdAt, ...preview } = built;
  const authorize = scope.require.bind(scope);
  for (const method of ['preview', 'build', 'replay'] as const) {
    await t.test(method, async () => {
      const caller = { ...operator };
      const input = structuredClone(original);
      const { requestId: _requestId, ...request } = original;
      // A preview saved under a new request ID, so build writes what it holds after authorization.
      const save = { requestId: 'saved', preview: await registration.preview(operator, request) };
      scope.require = async (...args) => {
        const actor = await authorize(...args);
        Object.assign(caller, other);
        input.subject.revision = 99;
        input.inputs.evidence.items[0].body = { text: 'Changed evidence' };
        input.requestId = 'changed';
        save.requestId = 'changed';
        save.preview.subject.revision = 99;
        save.preview.prompt = 'Changed evidence';
        return actor;
      };
      try {
        if (method === 'preview') {
          const { requestId, ...request } = input;
          assert.deepEqual(await registration.preview(caller, request), preview);
        } else if (method === 'build') {
          const saved = await registration.build(caller, save);
          const { id: _id, createdAt: _createdAt, ...rendered } = saved;
          assert.deepEqual(rendered, preview);
          assert.deepEqual(
            await registration.replay(operator, { subject: original.subject, requestId: 'saved' }),
            saved,
          );
        } else {
          const { inputs, ...request } = input;
          assert.deepEqual(await registration.replay(caller, request), built);
        }
      } finally {
        scope.require = authorize;
      }
    });
  }
});

test('invalid, missing, oversized and corrupt preview inputs perform no SQL writes, including rolled-back writes', async (t) => {
  const { directory, artifacts, builder, operator, changes, packageCount, state } = await setup(t);
  const evidence = await artifacts.create(operator, { title: 'Proof', content: 'Verified.' });
  const registration = await builder.register(definition);
  const subject = { id: 'assignment', revision: 0 };
  const many = await Promise.all(
    Array.from(
      { length: 5 },
      async (_, i) =>
        await artifacts.create(operator, { title: `${i}: ${'x'.repeat(285)}`, content: `${i}` }),
    ),
  );
  const malformed: Array<[unknown, string]> = [
    [{ subject, inputs: {}, requestId: 'not-accepted-in-preview' }, 'invalid_context'],
    [{ subject: { ...subject, extra: true }, inputs: {} }, 'invalid_context'],
    [{ subject: { ...subject, revision: -1 }, inputs: {} }, 'invalid_context'],
    [
      { subject, inputs: { evidence: text('a', 'Valid', { extra: true } as object) } },
      'invalid_context',
    ],
    [{ subject, inputs: { evidence: { ...text('a', 'Valid'), extra: true } } }, 'invalid_context'],
    [
      { subject, inputs: { evidence: text('a', 'Valid'), unknown: text('b', 'Invalid') } },
      'invalid_context',
    ],
    [{ subject, inputs: { evidence: docs([evidence.id, evidence.id]) } }, 'invalid_context'],
    [{ subject, inputs: {} }, 'context_missing'],
    [{ subject, inputs: { evidence: docs([]) } }, 'context_missing'],
    [{ subject, inputs: { evidence: docs(['not-an-artifact']) } }, 'not_found'],
    [
      { subject, inputs: { evidence: text('a', 'x'.repeat(2000), { embed: 'always' }) } },
      'context_too_large',
    ],
    [
      {
        subject,
        inputs: {
          evidence: {
            items: many.map(({ id, title }) => ({
              id,
              title,
              body: { artifactId: id },
              embed: 'always' as const,
            })),
          },
        },
      },
      'context_too_large',
    ],
  ];
  const before = await changes();
  const eventHead = await state.eventHead();
  for (const [input, code] of malformed) {
    await assert.rejects(
      async () => await registration.preview(operator, input as Omit<ContextBuild, 'requestId'>),
      {
        code,
      },
    );
    assert.equal(await changes(), before, code);
  }
  writeFileSync(
    join(directory, 'blobs', operator.projectId, evidence.hash.slice(0, 2), evidence.hash),
    'Corrupt bytes',
  );
  await assert.rejects(
    async () =>
      await registration.preview(operator, {
        subject,
        inputs: { evidence: docs([evidence.id], 'always') },
      }),
    { code: 'blob_corrupt' },
  );
  assert.equal(await changes(), before);
  assert.equal(await packageCount(), 0);
  assert.equal(await state.eventHead(), eventHead);
});

test('preview checks project membership and revocation, not the work role; handles retire with their recipe or builder', async (t) => {
  const { state, scope, artifacts, builder, operator, changes } = await setup(t);
  const evidence = await artifacts.create(operator, {
    title: 'Scoped proof',
    content: 'Private evidence.',
  });
  const work = await builder.register(definition);
  const review = await builder.register({
    ...definition,
    name: 'test.review-preview',
    kind: 'review',
  });
  const actor = async (role: 'producer' | 'reviewer' | 'reader'): Promise<Caller> => ({
    actorId: (await scope.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await actor('producer'),
    reviewer = await actor('reviewer'),
    reader = await actor('reader');
  const otherIdentity = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const other = { actorId: otherIdentity.actor.id, projectId: otherIdentity.project.id };
  const input = {
    subject: { id: 'assignment', revision: 0 },
    inputs: { evidence: docs([evidence.id]) },
  };
  const before = await changes();
  // Whether an actor may do this work or review is its consumer's assignment check; the builder
  // only requires that the caller may read the project.
  for (const registration of [work, review])
    for (const caller of [producer, reviewer, reader])
      assert.equal((await registration.preview(caller, input)).actorId, caller.actorId);
  await assert.rejects(
    async () =>
      await work.preview({ actorId: producer.actorId, projectId: other.projectId }, input),
    { code: 'forbidden' },
  );
  await assert.rejects(async () => await work.preview(other, input), { code: 'not_found' });
  assert.equal(await changes(), before);
  await scope.revokeActor(operator, producer.actorId);
  await scope.revokeActor(operator, reviewer.actorId);
  await assert.rejects(async () => await work.preview(producer, input), { code: 'forbidden' });
  await assert.rejects(async () => await review.preview(reviewer, input), { code: 'forbidden' });
  const live = await state.transaction(async (tx) => await work.preview(operator, input, tx));
  let expired!: Transaction;
  await state.transaction(async (tx) => {
    expired = tx;
  });
  await assert.rejects(async () => await work.preview(operator, input, expired), {
    code: 'invalid_transaction',
  });
  work.dispose();
  await assert.rejects(async () => await work.preview(operator, input), {
    code: 'recipe_unavailable',
  });
  const next = await builder.register(definition);
  work.dispose();
  assert.deepEqual(await next.preview(operator, input), live);
  await assert.rejects(async () => await work.preview(operator, input), {
    code: 'recipe_unavailable',
  });
  builder.close();
  await assert.rejects(async () => await next.preview(operator, input), {
    code: 'recipe_unavailable',
  });
  await assert.rejects(async () => await review.preview(operator, input), {
    code: 'recipe_unavailable',
  });
});

test('a saved request ID replays without rendering and returns its package to a build of other inputs', async (t) => {
  const { directory, artifacts, builder, operator, changes, packageCount } = await setup(t);
  const evidence = await artifacts.create(operator, {
    title: 'Original proof',
    content: 'Original verified bytes.',
  });
  const registration = await builder.register(definition);
  const input = {
    subject: { id: 'assignment', revision: 0 },
    inputs: { evidence: docs([evidence.id], 'always') },
    requestId: 'saved',
  };
  const saved = await buildContext(registration, operator, input);
  writeFileSync(
    join(directory, 'blobs', operator.projectId, evidence.hash.slice(0, 2), evidence.hash),
    'Corrupt bytes',
  );
  const { requestId, ...previewInput } = input;
  const before = await changes();
  await assert.rejects(async () => await registration.preview(operator, previewInput), {
    code: 'blob_corrupt',
  });
  assert.deepEqual(
    await registration.replay(operator, { subject: input.subject, requestId }),
    saved,
  );
  // The request ID names the saved package: a preview of other inputs for the same subject gets it.
  const other = await registration.preview(operator, {
    ...previewInput,
    inputs: { evidence: text('evidence', 'Other evidence.') },
  });
  assert.deepEqual(await registration.build(operator, { requestId, preview: other }), saved);
  await assert.rejects(
    async () => await buildContext(registration, operator, { ...input, requestId: 'fresh' }),
    {
      code: 'blob_corrupt',
    },
  );
  assert.equal(await changes(), before);
  assert.equal(await packageCount(), 1);
});
