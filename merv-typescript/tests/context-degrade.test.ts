/**
 * Frozen renderers degrade instead of failing where the plan allows it. A lenient unit (an
 * optional section, an `auto` section, a ranked item) shows its reference when its stored bytes are
 * permanently unreadable; a required `text` section still embeds its bytes or fails. A document
 * whose bytes are not UTF-8 has no text form, so it is shown as its reference in every mode. Missing
 * blobs and transient storage errors fail everywhere, so a pinned prompt never records an outage.
 */
import { createService, MervError, sha256Hex } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { RecipeContextBuilder } from '@merv/context-builder';
import { HIERARCHICAL_RECIPES } from '@merv/reflections/definitions';
import type {
  Artifact,
  Caller,
  ContextInput,
  RankedContextItem,
  TaskTypeDefinition,
} from '@merv/contracts';
import { openState } from './fixtures/state.js';

const definition: TaskTypeDefinition = {
  name: 'test.degrade',
  version: 1,
  kind: 'work',
  recipe: {
    instructions: 'Inspect the assigned evidence.',
    sections: [
      { key: 'evidence', title: 'Evidence', required: true },
      { key: 'background', title: 'Background', required: false },
    ],
    outputInstructions: 'Report the result with evidence.',
    maxChars: 1600,
  },
};
const subject = { id: 'assignment', revision: 1 };

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-context-degrade-'));
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
  const identity = await scope.bootstrap({ projectName: 'Degrade', actorName: 'Operator' });
  const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
  // Reads are counted, and a chosen artifact's read throws a chosen code.
  const read = artifacts.read.bind(artifacts);
  const reads: string[] = [];
  const failures = new Map<string, string>();
  artifacts.read = async (caller, id) => {
    reads.push(id);
    const code = failures.get(id);
    if (code) throw new MervError(code, 'Chosen read failure', 503);
    return await read(caller, id);
  };
  return { artifacts, builder, operator, reads, failures };
}

/** The reference stanza a document is shown by when its bytes are not included. */
const reference = (document: Artifact) =>
  `Artifact ${document.id} (${document.title}; sha256 ${document.hash}; ${document.mediaType}; ${document.size} bytes)\nBytes are not included in this context.`;

test('a document whose bytes are not UTF-8 renders its reference in text mode, required or optional', async (t) => {
  const { artifacts, builder, operator } = await setup(t);
  const png = await artifacts.create(operator, {
    title: 'Figure',
    mediaType: 'image/png',
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]).toString('base64'),
    encoding: 'base64',
  });
  const text = await artifacts.create(operator, { title: 'Notes', content: 'Readable notes.' });
  const registration = await builder.register(definition);
  const required = await registration.preview(operator, {
    subject,
    inputs: { evidence: { artifactIds: [text.id, png.id] } },
  });
  assert.ok(required.prompt.includes(reference(png)));
  assert.match(required.prompt, /Readable notes\./);
  assert.deepEqual(
    required.sources.map((source) => source.id),
    [text.id, png.id],
  );
  assert.deepEqual(required.omitted, ['background']);
  const optional = await registration.preview(operator, {
    subject,
    inputs: { evidence: { text: 'Assigned.' }, background: { artifactIds: [png.id] } },
  });
  assert.ok(optional.prompt.includes(reference(png)));
  assert.deepEqual(optional.omitted, []);
});

test('a permanent read error degrades a lenient unit to its reference and fails a required text section', async (t) => {
  const { artifacts, builder, operator, failures } = await setup(t);
  const registration = await builder.register(definition);
  const ranked = await builder.register({ ...definition, name: 'test.degrade-ranked' });
  for (const code of ['blob_corrupt', 'artifact_hash_mismatch', 'artifact_size']) {
    const unreadable = await artifacts.create(operator, {
      title: `Unreadable ${code}`,
      content: `Stored bytes for ${code}.`,
    });
    failures.set(unreadable.id, code);
    const lenient: Record<string, ContextInput>[] = [
      { evidence: { text: 'Assigned.' }, background: { artifactIds: [unreadable.id] } },
      { evidence: { artifactIds: [unreadable.id], mode: 'auto' } },
      {
        evidence: { text: 'Assigned.' },
        background: { artifactIds: [unreadable.id], mode: 'auto' },
      },
    ];
    for (const inputs of lenient) {
      const preview = await registration.preview(operator, { subject, inputs });
      assert.ok(preview.prompt.includes(reference(unreadable)), code);
      assert.doesNotMatch(preview.prompt, /Stored bytes/);
      assert.ok(preview.sources.some((source) => source.id === unreadable.id));
    }
    const item = {
      id: `item:${code}`,
      title: 'Unreadable item',
      priority: 10,
      content: { artifactId: unreadable.id },
      hash: unreadable.hash,
      refs: [{ tool: 'artifact.read', input: { artifactId: unreadable.id } }],
    };
    const listed = await ranked.preview(operator, {
      subject,
      inputs: { evidence: { rankedItems: [item] } },
    });
    assert.ok(listed.prompt.includes(unreadable.id));
    assert.doesNotMatch(listed.prompt, /Stored bytes/);
    assert.deepEqual(listed.omitted, [item.id]);
    await assert.rejects(
      registration.preview(operator, {
        subject,
        inputs: { evidence: { artifactIds: [unreadable.id] } },
      }),
      { code },
    );
  }
});

test('a missing blob or a storage outage fails every section kind', async (t) => {
  const { artifacts, builder, operator, failures } = await setup(t);
  const registration = await builder.register(definition);
  const ranked = await builder.register({ ...definition, name: 'test.degrade-ranked' });
  for (const code of ['blob_not_found', 'blob_unavailable', 'storage_unavailable']) {
    const unreadable = await artifacts.create(operator, {
      title: `Unreachable ${code}`,
      content: `Stored bytes for ${code}.`,
    });
    failures.set(unreadable.id, code);
    const kinds: Record<string, ContextInput>[] = [
      { evidence: { artifactIds: [unreadable.id] } },
      { evidence: { text: 'Assigned.' }, background: { artifactIds: [unreadable.id] } },
      { evidence: { artifactIds: [unreadable.id], mode: 'auto' } },
      {
        evidence: { text: 'Assigned.' },
        background: { artifactIds: [unreadable.id], mode: 'auto' },
      },
    ];
    for (const inputs of kinds)
      await assert.rejects(registration.preview(operator, { subject, inputs }), { code });
    await assert.rejects(
      ranked.preview(operator, {
        subject,
        inputs: {
          evidence: {
            rankedItems: [
              {
                id: `item:${code}`,
                title: 'Unreachable item',
                priority: 10,
                content: { artifactId: unreadable.id },
                refs: [{ tool: 'artifact.read', input: { artifactId: unreadable.id } }],
              },
            ],
          },
        },
      }),
      { code },
    );
  }
});

test('a required auto section that does not fit renders its references, while required text still fails', async (t) => {
  const { artifacts, builder, operator, reads } = await setup(t);
  const registration = await builder.register(definition);
  const { maxChars } = definition.recipe;
  const over = await artifacts.create(operator, {
    title: 'Long log',
    content: 'x'.repeat(maxChars * 3),
  });
  const overBytes = await artifacts.create(operator, {
    title: 'Longer log',
    content: 'x'.repeat(maxChars * 4 + 1),
  });
  const short = await artifacts.create(operator, { title: 'Short note', content: 'Short note.' });
  for (const [document, read] of [
    [over, true],
    // Over the byte bound, its bytes are never read.
    [overBytes, false],
  ] as const) {
    reads.length = 0;
    const preview = await registration.preview(operator, {
      subject,
      inputs: { evidence: { artifactIds: [short.id, document.id], mode: 'auto' } },
    });
    assert.ok(preview.prompt.length <= maxChars);
    assert.ok(preview.prompt.includes(`## Evidence\n${reference(short)}`));
    assert.ok(preview.prompt.includes(reference(document)));
    assert.doesNotMatch(preview.prompt, /xxx|Short note\.\n/);
    assert.deepEqual(preview.omitted, ['background']);
    assert.deepEqual(
      preview.sources.map((source) => source.id),
      [short.id, document.id],
    );
    assert.equal(reads.includes(document.id), read);
    await assert.rejects(
      registration.preview(operator, {
        subject,
        inputs: { evidence: { artifactIds: [document.id] } },
      }),
      { code: 'context_too_large' },
    );
  }
  // An optional section that does not fit is still omitted, and references that do not fit still fail.
  const optional = await registration.preview(operator, {
    subject,
    inputs: {
      evidence: { text: 'Assigned.' },
      background: { artifactIds: [over.id], mode: 'auto' },
    },
  });
  assert.deepEqual(optional.omitted, ['background']);
  const many = await Promise.all(
    Array.from(
      { length: 6 },
      async (_, i) =>
        await artifacts.create(operator, {
          title: `${i}: ${'t'.repeat(280)}`,
          content: 'x'.repeat(2000),
        }),
    ),
  );
  await assert.rejects(
    registration.preview(operator, {
      subject,
      inputs: { evidence: { artifactIds: many.map((a) => a.id), mode: 'auto' } },
    }),
    { code: 'context_too_large' },
  );
});

/** A text item shaped as reflections builds one. */
const textItem = (
  id: string,
  title: string,
  priority: number,
  content: string,
  association: string,
  refs: RankedContextItem['refs'],
): RankedContextItem => ({
  id,
  title,
  priority,
  content: { text: content },
  hash: sha256Hex(Buffer.from(content, 'utf8')),
  association,
  refs,
});

test('a mature paper no longer fails a reflection: the lowest-ranked references are cut and counted', async (t) => {
  const { artifacts, builder, operator } = await setup(t);
  const synthesis = HIERARCHICAL_RECIPES.find(
    (recipe) => recipe.name === 'reflection.synthesis' && recipe.version === 11,
  )!;
  const registration = await builder.register(synthesis);
  const assignment = textItem(
    'reflection:wf_1:wave:4',
    'Reflection assignment',
    1000,
    JSON.stringify({ reflectionId: 'wf_1', title: 'Wave', attempt: 1 }),
    'reflection wf_1; attempt 1',
    [{ tool: 'reflection.get', input: { reflectionId: 'wf_1' } }],
  );
  const kinds = ['problem', 'goals', 'methods', 'results'];
  const paper = Array.from({ length: 240 }, (_, index) => {
    const kind = kinds[index % kinds.length],
      status = Math.floor(index / kinds.length) % 2 ? 'published' : 'current';
    return textItem(
      `paper:${kind}:${status}:4:${index}:s${index}`,
      `${kind} ${status}: Section ${index}`,
      kind === 'problem' ? (status === 'current' ? 850 : 450) : status === 'current' ? 600 : 250,
      `The ${kind} section ${index} states finding ${index}. `.repeat(8),
      `${kind}/${status}; section s${index}; updated 2026-01-01T00:00:00.000Z`,
      status === 'current'
        ? [
            { tool: 'paper.read', input: { kind, section: `s${index}` } },
            { tool: 'paper.read', input: { kind, history: true } },
          ]
        : [{ tool: 'paper.read', input: { kind, history: true } }],
    );
  });
  // The lowest-ranked paper item is backed by an artifact, so its cut shows the artifact stays a source.
  const figure = await artifacts.create(operator, {
    title: 'Figure notes',
    content: 'The figure shows finding 0.',
  });
  paper.push({
    id: `artifact:${figure.id}:figure`,
    title: figure.title,
    priority: 100,
    content: { artifactId: figure.id },
    hash: figure.hash,
    association: 'paper figure',
    refs: [{ tool: 'artifact.read', input: { artifactId: figure.id } }],
  });
  const lenses = await Promise.all(
    ['rigor', 'novelty', 'risk', 'scope', 'evidence'].map(async (perspective) => {
      const report = await artifacts.create(operator, {
        title: `${perspective} lens report`,
        content: `The ${perspective} lens found nothing new.`,
      });
      return {
        id: `artifact:${report.id}:${perspective}`,
        title: report.title,
        priority: 800,
        content: { artifactId: report.id },
        hash: report.hash,
        association: `reflection wf_1; ${perspective} lens`,
        refs: [{ tool: 'artifact.read', input: { artifactId: report.id } }],
      };
    }),
  );
  const preview = await registration.preview(operator, {
    subject: { id: 'wf_1', revision: 4 },
    inputs: {
      assignment: { rankedItems: [assignment] },
      projectPaper: { rankedItems: paper },
      research: { rankedItems: [] },
      lenses: { rankedItems: lenses },
    },
  });
  assert.ok(preview.prompt.length <= synthesis.recipe.maxChars);
  const [listing, selected] = preview.prompt.split('\n## Selected full content\n');
  const listed = (item: RankedContextItem) => listing.includes(`"id":"${item.id}"`);
  // The top item of each required section stays listed.
  assert.ok(listed(assignment));
  assert.ok(listed(paper[0]));
  assert.ok(listed(lenses[0]));
  const cut = [assignment, ...paper, ...lenses].filter((item) => !listed(item));
  assert.ok(cut.length > 0);
  for (const item of cut) assert.ok(preview.omitted.includes(item.id), item.id);
  const cutPaper = paper.filter((item) => !listed(item)).length;
  assert.ok(
    listing.includes(
      `\n(${cutPaper} lower-priority items are not listed for lack of room; retrieve them through artifact.read or paper.read.)\n`,
    ),
  );
  // Interim: after the cut there is no room left for any body, not even the assignment's.
  assert.deepEqual(selected.match(/^### .*$/gm), null);
  assert.ok(!listed(paper.at(-1)!));
  assert.deepEqual(
    preview.sources.map((source) => source.id),
    [figure.id, ...lenses.map((lens) => lens.content.artifactId)],
  );
});

test('ranked references that must stay listed and do not fit still fail', async (t) => {
  const { builder, operator } = await setup(t);
  const registration = await builder.register({
    ...definition,
    name: 'test.degrade-floor',
    recipe: {
      ...definition.recipe,
      sections: [
        { key: 'evidence', title: 'Evidence', required: true },
        { key: 'background', title: 'Background', required: true },
      ],
      maxChars: 1000,
    },
  });
  const item = (id: string) =>
    textItem(id, 't'.repeat(300), 10, 'Body.', 'a'.repeat(500), [
      { tool: 'task.get', input: { id } },
    ]);
  await assert.rejects(
    registration.preview(operator, {
      subject,
      inputs: {
        evidence: { rankedItems: [item('first'), item('second')] },
        background: { rankedItems: [item('third')] },
      },
    }),
    { code: 'context_too_large', message: /Minimum context references exceed/ },
  );
});

test('a ranked title over 300 characters renders clipped instead of failing', async (t) => {
  const { builder, operator } = await setup(t);
  const registration = await builder.register({ ...definition, name: 'test.degrade-title' });
  const title = `${'t'.repeat(299)}😀${'u'.repeat(20)}`;
  const preview = await registration.preview(operator, {
    subject,
    inputs: {
      evidence: {
        rankedItems: [
          textItem('long', `  ${title}  `, 10, 'Short body.', 'long title', [
            { tool: 'task.get', input: { id: 'long' } },
          ]),
        ],
      },
    },
  });
  // At most 300 UTF-16 units, never half a surrogate pair.
  const clipped = 't'.repeat(299);
  assert.ok(
    preview.prompt.includes(`\n### ${clipped}\nMetadata: {"id":"long","title":"${clipped}"`),
  );
  assert.ok(preview.prompt.includes(`\n### long: ${clipped}\nShort body.\n`));
  assert.doesNotMatch(preview.prompt, /u{20}|\uD83D/);
});

test('ranked promotion reads no artifact whose shortest text cannot fit its room', async (t) => {
  const { artifacts, builder, operator, reads } = await setup(t);
  const registration = await builder.register({
    ...definition,
    name: 'test.degrade-room',
    recipe: { ...definition.recipe, maxChars: 3000 },
  });
  const item = (document: Artifact): RankedContextItem => ({
    id: 'evidence',
    title: document.title,
    priority: 10,
    content: { artifactId: document.id },
    hash: document.hash,
    refs: [{ tool: 'artifact.read', input: { artifactId: document.id } }],
  });
  const preview = async (document: Artifact) =>
    await registration.preview(operator, {
      subject,
      inputs: { evidence: { rankedItems: [item(document)] } },
    });
  const ascii = await artifacts.create(operator, { title: 'Log', content: 'x'.repeat(8000) });
  reads.length = 0;
  const skipped = await preview(ascii);
  const room = 3000 - skipped.prompt.length;
  // The old rule read anything up to four bytes per character of room.
  assert.ok(ascii.size > room && ascii.size <= room * 4, `${room}`);
  assert.deepEqual(reads, []);
  assert.deepEqual(skipped.omitted, ['evidence']);
  // Three bytes per character is the tightest a body can be, and one that fits is still read.
  const cjk = await artifacts.create(operator, { title: 'Log', content: '文'.repeat(700) });
  const embedded = await preview(cjk);
  assert.deepEqual(reads, [cjk.id]);
  assert.ok(embedded.prompt.includes(`\n### evidence: Log\n${'文'.repeat(700)}\n`));
});
