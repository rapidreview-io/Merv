import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import {
  digest,
  type Caller,
  type ContextBuild,
  type TaskTypeDefinition,
  type Transaction,
} from '@merv/contracts';

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
  },
};

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-preview-'));
  const state = new SqliteState(join(directory, 'state.db'));
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
  const changes = async () =>
    await state.read(
      async (sql) => (await sql.get<{ n: number }>('SELECT total_changes() AS n'))!.n,
    );
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
      background: { text: 'x'.repeat(1500) },
      evidence: { artifactIds: [evidence.id] },
      notes: { text: 'Use the retained receipt.' },
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
  assert.deepEqual(preview.sources, [evidence]);
  assert.match(preview.prompt, /The exact result is 42/);
  assert.match(preview.prompt, /Use the retained receipt/);
  assert.ok(preview.prompt.length <= definition.recipe.maxChars);
  const { hash, ...body } = preview;
  assert.equal(hash, digest(body));
  assert.equal(
    await registration.replay(operator, { subject: input.subject, requestId: 'begin' }),
    null,
  );
  const built = await registration.build(operator, { ...input, requestId: 'begin' });
  const { id, createdAt, ...savedPreview } = built;
  assert.match(id, /^context_/);
  assert.ok(createdAt);
  assert.deepEqual(savedPreview, preview);
  assert.equal(await packageCount(), 1);
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
  assert.deepEqual(await builder.get(operator, id), built);
  assert.equal((await artifacts.get(operator, evidence.id)).title, 'Proof');
  assert.equal(
    (await registration.preview(operator, { ...input, subject: built.subject })).hash,
    hash,
  );
});

test('preview shares text, auto and references rendering, deduplicated manifests and required/optional budgets', async (t) => {
  const { artifacts, builder, operator, changes } = await setup(t);
  const text = await artifacts.create(operator, { title: 'Text', content: 'A text result.' });
  const json = await artifacts.create(operator, {
    title: 'JSON',
    mediaType: 'application/json',
    content: '{"answer":42}',
  });
  const binary = await artifacts.create(operator, {
    title: 'Binary',
    mediaType: 'application/octet-stream',
    content: '/w==',
    encoding: 'base64',
  });
  const invalidUtf8 = await artifacts.create(operator, {
    title: 'Invalid UTF-8',
    mediaType: 'text/plain',
    content: '/w==',
    encoding: 'base64',
  });
  const large = await artifacts.create(operator, { title: 'Long log', content: 'x'.repeat(10000) });
  const registration = await builder.register(definition);
  const subject = { id: 'assignment', revision: 0 };
  const read = artifacts.read.bind(artifacts);
  const reads: string[] = [];
  artifacts.read = async (caller, id) => {
    reads.push(id);
    return await read(caller, id);
  };
  const before = await changes();
  const autoInput: Omit<ContextBuild, 'requestId'> = {
    subject,
    inputs: {
      background: { artifactIds: [large.id] },
      evidence: { artifactIds: [text.id, json.id, binary.id], mode: 'auto' },
      notes: { artifactIds: [text.id] },
    },
  };
  const auto = await registration.preview(operator, autoInput);
  assert.match(auto.prompt, /A text result/);
  assert.match(auto.prompt, /"answer":42/);
  assert.ok(auto.prompt.includes(binary.hash));
  assert.match(auto.prompt, /Bytes are not included/);
  assert.deepEqual(
    auto.sources.map((item) => item.id),
    [text.id, json.id, binary.id],
  );
  assert.deepEqual(auto.omitted, ['background']);
  assert.deepEqual(reads, [text.id, json.id, text.id]);
  assert.equal(await changes(), before);
  const built = await registration.build(operator, { ...autoInput, requestId: 'auto' });
  assert.equal(auto.hash, built.hash);
  reads.length = 0;
  const referencesInput: Omit<ContextBuild, 'requestId'> = {
    subject,
    inputs: { evidence: { artifactIds: [large.id, binary.id], mode: 'references' } },
  };
  const references = await registration.preview(operator, referencesInput);
  assert.deepEqual(reads, []);
  assert.ok(references.prompt.includes(large.hash));
  assert.ok(references.prompt.includes(binary.hash));
  assert.equal(
    references.hash,
    (await registration.build(operator, { ...referencesInput, requestId: 'references' })).hash,
  );
  assert.deepEqual(reads, []);
  const fallback = await registration.preview(operator, {
    subject,
    inputs: { evidence: { artifactIds: [invalidUtf8.id], mode: 'auto' } },
  });
  assert.match(fallback.prompt, /Bytes are not included/);
  await assert.rejects(
    async () =>
      await registration.preview(operator, {
        subject,
        inputs: { evidence: { artifactIds: [invalidUtf8.id] } },
      }),
    { code: 'context_encoding' },
  );
  await assert.rejects(
    async () =>
      await registration.preview(operator, {
        subject,
        inputs: { evidence: { artifactIds: [binary.id] } },
      }),
    { code: 'context_encoding' },
  );
  await assert.rejects(
    async () =>
      await registration.preview(operator, {
        subject,
        inputs: { evidence: { artifactIds: [large.id] } },
      }),
    { code: 'context_too_large' },
  );
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
      { subject, inputs: { evidence: { artifactIds: [evidence.id], mode: 'unknown' } } },
      'invalid_context',
    ],
    [{ subject, inputs: { evidence: { text: 'Valid', extra: true } } }, 'invalid_context'],
    [
      { subject, inputs: { evidence: { text: 'Valid' }, unknown: { text: 'Invalid' } } },
      'invalid_context',
    ],
    [
      { subject, inputs: { evidence: { artifactIds: [evidence.id, evidence.id] } } },
      'invalid_context',
    ],
    [{ subject, inputs: {} }, 'context_missing'],
    [{ subject, inputs: { evidence: { text: '   ' } } }, 'context_missing'],
    [{ subject, inputs: { evidence: { artifactIds: [] } } }, 'context_missing'],
    [{ subject, inputs: { evidence: { artifactIds: ['not-an-artifact'] } } }, 'not_found'],
    [{ subject, inputs: { evidence: { text: 'x'.repeat(2000) } } }, 'context_too_large'],
    [
      {
        subject,
        inputs: { evidence: { artifactIds: many.map((item) => item.id), mode: 'references' } },
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
        inputs: { evidence: { artifactIds: [evidence.id] } },
      }),
    { code: 'blob_corrupt' },
  );
  assert.equal(await changes(), before);
  assert.equal(await packageCount(), 0);
  assert.equal(await state.eventHead(), eventHead);
});

test('preview checks project, current actor role and revocation; handles retire with their recipe or builder', async (t) => {
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
    inputs: { evidence: { artifactIds: [evidence.id] } },
  };
  const before = await changes();
  assert.equal((await work.preview(producer, input)).actorId, producer.actorId);
  assert.equal((await review.preview(reviewer, input)).actorId, reviewer.actorId);
  for (const [registration, caller] of [
    [work, reviewer],
    [review, producer],
    [work, reader],
    [review, reader],
  ] as const)
    await assert.rejects(async () => await registration.preview(caller, input), {
      code: 'forbidden',
    });
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

test('saved build receipts replay before rendering and changed inputs still conflict when fresh preview fails', async (t) => {
  const { directory, artifacts, builder, operator, changes, packageCount } = await setup(t);
  const evidence = await artifacts.create(operator, {
    title: 'Original proof',
    content: 'Original verified bytes.',
  });
  const registration = await builder.register(definition);
  const input = {
    subject: { id: 'assignment', revision: 0 },
    inputs: { evidence: { artifactIds: [evidence.id] } },
    requestId: 'saved',
  };
  const saved = await registration.build(operator, input);
  writeFileSync(
    join(directory, 'blobs', operator.projectId, evidence.hash.slice(0, 2), evidence.hash),
    'Corrupt bytes',
  );
  const { requestId: _requestId, ...previewInput } = input;
  const before = await changes();
  await assert.rejects(async () => await registration.preview(operator, previewInput), {
    code: 'blob_corrupt',
  });
  assert.deepEqual(await registration.build(operator, input), saved);
  await assert.rejects(
    async () =>
      await registration.build(operator, {
        ...input,
        inputs: { evidence: { artifactIds: ['not-found'] } },
      }),
    { code: 'request_conflict' },
  );
  await assert.rejects(
    async () => await registration.build(operator, { ...input, requestId: 'fresh' }),
    {
      code: 'blob_corrupt',
    },
  );
  assert.equal(await changes(), before);
  assert.equal(await packageCount(), 1);
});
