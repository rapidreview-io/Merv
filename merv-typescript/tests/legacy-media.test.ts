import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './fixtures/app.js';
import { importLegacyFoundation, type LegacyFoundationSnapshot } from '../src/legacy-import.js';
import {
  legacyUnavailableArtifacts,
  planLegacyMedia,
  prepareLegacyMediaFoundation,
} from '../src/legacy-media.js';
import { historyMediaLinks } from '../src/legacy-media-links.js';
import { emptyLegacyHistorySnapshot, legacyHistoryRow } from './fixtures/legacy-history.js';
import { stateConfig } from './fixtures/state.js';

const contents = [
  Buffer.from('retained artifact and figure'),
  Buffer.from('<html>old embed</html>'),
  Buffer.from('preview image'),
];
const hashes = contents.map((bytes) => createHash('sha256').update(bytes).digest('hex'));
const createdAt = '2026-08-01T00:00:00.000Z';
function fixture() {
  const foundation: LegacyFoundationSnapshot = {
    sourceId: 'media-rehearsal',
    schemaVersion: 81,
    issuer: 'https://shared.example/auth/v1',
    projects: [
      {
        id: 'project_original',
        name: 'Original',
        summary: 'Retained',
        status: 'active',
        created_at: createdAt,
      },
    ],
    memberships: [{ project_id: 'project_original', user_id: 'same-user', added_at: createdAt }],
    artifacts: [
      {
        id: 'artifact_original',
        project_id: 'project_original',
        title: 'Source report',
        path: 'report.md',
        created_by: 'original-agent',
        created_at: createdAt,
        status: 'complete',
        content_type: 'text/markdown',
        content_sha256: hashes[0]!,
        size_bytes: contents[0]!.length,
      },
    ],
    claims: [],
  };
  const history = emptyLegacyHistorySnapshot(['project_original'], foundation.sourceId);
  history.tables.projects.push(legacyHistoryRow('projects', foundation.projects[0]!));
  history.tables.artifacts.push(legacyHistoryRow('artifacts', foundation.artifacts[0]!));
  history.tables.artifact_figures.push(
    legacyHistoryRow('artifact_figures', {
      id: 'figure_original',
      artifact_id: 'artifact_original',
      link_path: 'figures/original.svg',
      content_sha256: hashes[0]!,
      size_bytes: contents[0]!.length,
      status: 'complete',
    }),
  );
  history.tables.posts.push(
    legacyHistoryRow('posts', {
      id: 'post_original',
      project_id: 'project_original',
      author_handle: 'original-handle',
      author_role: 'operator',
      created_at: createdAt,
      image_sha256: hashes[0]!,
      image_content_type: 'image/png',
      embed_sha256: hashes[1]!,
      embed_content_type: 'text/html',
      link_preview_json: {
        image_sha256: hashes[2]!,
        image_content_type: 'image/jpeg',
        url: 'https://external.example/never-fetched',
      },
    }),
  );
  const receipts = contents.map((bytes, index) => ({
    namespace: 'project_original',
    hash: hashes[index]!,
    size: bytes.length,
  }));
  return { foundation, history, receipts };
}

test('media planning preserves each real file binding while deduplicating namespace/hash transfers', () => {
  const f = fixture();
  const plan = planLegacyMedia(f.history);
  assert.equal(plan.distinctObjects, 3);
  assert.equal(plan.files.length, 4);
  assert.equal(plan.missingSizesRequiringHead, 2);
  assert.deepEqual(plan.references, {
    artifacts: 1,
    figures: 1,
    postImages: 1,
    postEmbeds: 1,
    linkPreviewImages: 1,
  });
  const figure = plan.files.find((file) => file.sourceType === 'artifact_figures')!;
  assert.equal(figure.parentArtifactId, 'artifact_original');
  assert.equal(figure.path, 'figures/original.svg');
  assert.equal(figure.createdBy, 'original-agent');
  assert.equal(figure.createdAt, createdAt);
  assert.equal(
    figure.mediaType,
    'application/octet-stream',
    'Never guess executable image MIME from its extension',
  );
  const embed = plan.files.find((file) => file.slot === 'embed')!;
  assert.equal(embed.mediaType, 'application/octet-stream');
  assert.equal(embed.createdBy, 'original-handle');
  assert.equal(embed.attribution, 'post-author-handle');
  const prepared = prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts);
  assert.equal(prepared.foundation.artifacts.length, 5);
  assert.equal(prepared.manifest.originalArtifacts, 1);
  assert.equal(prepared.manifest.derivedArtifacts, 4);
  assert.deepEqual(
    prepared.foundation.artifacts.find((a) => a.id === 'artifact_original'),
    f.foundation.artifacts[0],
  );
  assert.deepEqual(prepared.foundation.memberships, f.foundation.memberships);
  assert.deepEqual(
    prepared.manifest.bindings.map((file) => file.artifactId).sort(),
    plan.files.map((file) => file.artifactId).sort(),
  );
  assert.equal(f.foundation.artifacts.length, 1, 'The source snapshot is never mutated');
});

test('prepared manifests replay deterministically and UI links resolve the same file IDs', () => {
  const f = fixture();
  const first = prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts);
  const second = prepareLegacyMediaFoundation(
    structuredClone(f.foundation),
    structuredClone(f.history),
    [...f.receipts].reverse(),
  );
  assert.deepEqual(first, second);
  for (const type of ['posts', 'artifact_figures'] as const) {
    const row = f.history.tables[type][0]!;
    const links = historyMediaLinks(type, String(row.id), row, 'project_original');
    for (const link of links)
      assert.ok(first.foundation.artifacts.some((a) => a.id === link.artifactId));
  }
  const post = f.history.tables.posts[0]!;
  const original = historyMediaLinks('posts', String(post.id), post, 'project_original');
  const other = historyMediaLinks(
    'posts',
    String(post.id),
    { ...post, project_id: 'project_other' },
    'project_other',
  );
  assert.ok(
    original.every((link) => other.every((candidate) => link.artifactId !== candidate.artifactId)),
  );
  assert.equal(
    new Set(first.manifest.bindings.map((b) => b.artifactId)).size,
    4,
    'Figure/image/embed/preview never collide',
  );
  assert.throws(() => historyMediaLinks('posts', String(post.id), post, 'project_other'), {
    code: 'legacy_media_scope',
  });
  assert.throws(() => historyMediaLinks('posts', 'different-record', post, 'project_original'), {
    code: 'legacy_media_scope',
  });
});

test('media preparation rejects missing, extra, duplicate, wrong-project and wrong-size receipts', () => {
  const f = fixture();
  const invalid = [
    f.receipts.slice(1),
    [...f.receipts, { ...f.receipts[0]!, hash: 'f'.repeat(64) }],
    [...f.receipts, f.receipts[0]!],
    f.receipts.map((r, i) => (i === 0 ? { ...r, namespace: 'project_other' } : r)),
    f.receipts.map((r, i) => (i === 0 ? { ...r, size: r.size + 1 } : r)),
    f.receipts.map((r, i) => (i === 1 ? { ...r, size: 512 * 1024 * 1024 + 1 } : r)),
  ];
  for (const receipts of invalid)
    assert.throws(() => prepareLegacyMediaFoundation(f.foundation, f.history, receipts), {
      code: 'legacy_media_receipt',
    });
});

test('native source records cannot be modified or replaced while appending media', () => {
  const f = fixture();
  for (const alter of [
    (foundation: LegacyFoundationSnapshot) => {
      foundation.artifacts[0]!.title = 'Altered';
    },
    (foundation: LegacyFoundationSnapshot) => {
      foundation.projects[0]!.summary = 'Altered';
    },
    (foundation: LegacyFoundationSnapshot) => {
      foundation.artifacts = [];
    },
    (foundation: LegacyFoundationSnapshot) => {
      foundation.sourceId = 'different';
    },
  ]) {
    const changed = structuredClone(f.foundation);
    alter(changed);
    assert.throws(() => prepareLegacyMediaFoundation(changed, f.history, f.receipts), {
      code: 'legacy_media_source_mismatch',
    });
  }
  const derivedId = planLegacyMedia(f.history).files[0]!.artifactId;
  const pending = structuredClone(f.history);
  pending.tables.artifacts.push(
    legacyHistoryRow('artifacts', {
      ...f.foundation.artifacts[0]!,
      id: derivedId,
      status: 'pending',
    }),
  );
  assert.throws(() => prepareLegacyMediaFoundation(f.foundation, pending, f.receipts), {
    code: 'legacy_media_collision',
  });
  const collision = { ...f.foundation.artifacts[0]!, id: derivedId };
  f.foundation.artifacts.push(collision);
  f.history.tables.artifacts.push(legacyHistoryRow('artifacts', collision));
  assert.throws(() => prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts), {
    code: 'legacy_media_collision',
  });
});

test('media derivation never follows arbitrary URLs or sandbox ledger and fails incomplete retained hashes', () => {
  const f = fixture();
  const before = planLegacyMedia(f.history);
  f.history.tables.storage_objects.push(
    legacyHistoryRow('storage_objects', {
      id: 'sandbox_owned',
      project_id: 'project_original',
      content_sha256: 'f'.repeat(64),
      size_bytes: 48_000_000_000,
      source_uri: 'https://outside.example/object',
      status: 'available',
    }),
  );
  f.history.tables.artifact_figures.push(
    legacyHistoryRow('artifact_figures', {
      id: 'not_completed',
      artifact_id: 'artifact_original',
      status: 'pending',
      link_path: 'pending.png',
    }),
  );
  const after = planLegacyMedia(f.history);
  assert.deepEqual(after.objects, before.objects);
  assert.deepEqual(after.files, before.files);
  f.history.tables.posts[0]!.image_sha256 = 'https://outside.example/object';
  assert.throws(() => planLegacyMedia(f.history), { code: 'legacy_media_hash' });
  f.history.tables.posts[0]!.image_sha256 = hashes[0]!;
  f.history.tables.artifact_figures[0]!.content_sha256 = '';
  assert.throws(() => planLegacyMedia(f.history), { code: 'legacy_media_hash' });
});

test('prepared real-file artifacts import atomically, retain original attribution and obey project access', async (t) => {
  const f = fixture();
  const prepared = prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts);
  const directory = await mkdtemp(join(tmpdir(), 'merv-legacy-media-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const services = {
    state: app.ctx.state,
    destinationBlobs: app.ctx.blobs,
    sourceBlobs: {
      async get(namespace: string, hash: string) {
        assert.equal(namespace, 'project_original');
        return Buffer.from(contents[hashes.indexOf(hash)]!);
      },
    },
  };
  const imported = await importLegacyFoundation(services, prepared.foundation);
  assert.equal(imported.artifacts, 5);
  assert.deepEqual(await importLegacyFoundation(services, prepared.foundation), imported);
  const principal = await app.ctx.scope.acceptVerifiedIdentity({
    issuer: f.foundation.issuer,
    subject: 'same-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const caller = await app.ctx.scope.caller(principal, 'project_original');
  for (const file of prepared.manifest.bindings) {
    const result = await app.ctx.artifacts.read(caller, file.artifactId);
    assert.equal(result.artifact.createdBy, file.createdBy);
    assert.deepEqual(
      Buffer.from(result.content, result.encoding),
      contents[hashes.indexOf(file.hash)],
    );
  }
  const other = await app.ctx.scope.bootstrap({
    projectName: 'Other',
    actorName: 'Other operator',
  });
  await assert.rejects(
    app.ctx.artifacts.read(
      { actorId: other.actor.id, projectId: other.project.id },
      prepared.manifest.bindings[0]!.artifactId,
    ),
    { code: 'not_found' },
  );
});

test('zero-byte completed evidence survives preparation and native import without permitting empty new uploads', async (t) => {
  const f = fixture();
  const empty = Buffer.alloc(0);
  const emptyHash = createHash('sha256').update(empty).digest('hex');
  const original = { ...f.foundation.artifacts[0]!, content_sha256: emptyHash, size_bytes: 0 };
  f.foundation.artifacts = [original];
  f.history.tables.artifacts = [legacyHistoryRow('artifacts', original)];
  f.history.tables.posts = [];
  f.history.tables.artifact_figures = [];
  const prepared = prepareLegacyMediaFoundation(f.foundation, f.history, [
    { namespace: 'project_original', hash: emptyHash, size: 0 },
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'merv-legacy-empty-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await importLegacyFoundation(
    {
      state: app.ctx.state,
      sourceBlobs: { get: async () => empty },
      destinationBlobs: app.ctx.blobs,
    },
    prepared.foundation,
  );
  const principal = await app.ctx.scope.acceptVerifiedIdentity({
    issuer: f.foundation.issuer,
    subject: 'same-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const caller = await app.ctx.scope.caller(principal, 'project_original');
  const read = await app.ctx.artifacts.read(caller, original.id);
  assert.equal(read.artifact.hash, emptyHash);
  assert.equal(read.artifact.size, 0);
  assert.equal(read.content, '');
  await assert.rejects(
    app.ctx.artifacts.create(caller, { title: 'New empty upload', content: '' }),
    { code: 'artifact_size' },
  );
});

function unavailableFixture() {
  const f = fixture();
  const metadataOnly = {
    ...f.foundation.artifacts[0]!,
    id: 'legacy_lineage',
    content_sha256: 'd'.repeat(64),
    size_bytes: 42,
  };
  f.foundation.artifacts.push(metadataOnly);
  f.history.tables.artifacts.push(legacyHistoryRow('artifacts', metadataOnly));
  const bytes = Buffer.from(
    JSON.stringify({
      source_objects: [],
      references: [
        {
          kind: 'artifact',
          id: metadataOnly.id,
          project_id: metadataOnly.project_id,
          sha256: metadataOnly.content_sha256,
          size_bytes: metadataOnly.size_bytes,
          covered: false,
        },
      ],
    }),
  );
  const auditSha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    ...f,
    bytes,
    auditSha256,
    audit: legacyUnavailableArtifacts(bytes, auditSha256),
    metadataOnly,
  };
}

test('approved metadata-only lineage remains complete history and cannot become a false native download', () => {
  const f = unavailableFixture();
  const original = JSON.stringify(f.history);
  const prepared = prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts, f.audit);
  assert.equal(prepared.manifest.originalArtifacts, 2);
  assert.equal(prepared.manifest.verifiedOriginalArtifacts, 1);
  assert.equal(prepared.manifest.metadataOnlyArtifacts.length, 1);
  assert.equal(prepared.foundation.artifacts.length, 5);
  assert.ok(!prepared.foundation.artifacts.some((row) => row.id === f.metadataOnly.id));
  assert.deepEqual(
    prepared.manifest.artifactRetention.artifacts.find((row) => row.id === f.metadataOnly.id),
    {
      id: f.metadataOnly.id,
      projectId: f.metadataOnly.project_id,
      hash: f.metadataOnly.content_sha256,
      size: 42,
      status: 'metadata-only',
      reason: 'legacy-lineage-without-retained-bytes',
      auditSha256: f.auditSha256,
    },
  );
  assert.equal(
    prepared.manifest.artifactRetention.artifacts.find((row) => row.id === 'artifact_original')
      ?.status,
    'verified',
  );
  assert.equal(JSON.stringify(f.history), original);
  assert.equal(f.foundation.artifacts.length, 2);
  assert.throws(
    () => prepareLegacyMediaFoundation(f.foundation, f.history, f.receipts),
    { code: 'legacy_media_receipt' },
    'Missing bytes without the explicit approved audit still fail',
  );
  assert.throws(() => legacyUnavailableArtifacts(f.bytes, 'f'.repeat(64)), {
    code: 'legacy_unavailable_audit',
  });
  for (const change of [
    (audit: typeof f.audit) => {
      audit.artifacts[0]!.size++;
    },
    (audit: typeof f.audit) => {
      audit.artifacts[0]!.id = 'other';
    },
    (audit: typeof f.audit) => {
      audit.artifacts.push({ ...audit.artifacts[0]! });
    },
  ]) {
    const modified = structuredClone(f.audit);
    change(modified);
    assert.throws(() => planLegacyMedia(f.history, modified), { code: 'legacy_unavailable_audit' });
  }
});

test('metadata-only exemption cannot spread through deduplicated hashes or exempt uploaded evidence', () => {
  for (const modify of [
    (f: ReturnType<typeof unavailableFixture>) => {
      f.history.tables.posts[0]!.image_sha256 = f.metadataOnly.content_sha256;
    },
    (f: ReturnType<typeof unavailableFixture>) => {
      f.history.tables.artifact_figures[0]!.content_sha256 = f.metadataOnly.content_sha256;
      f.history.tables.artifact_figures[0]!.size_bytes = 42;
    },
    (f: ReturnType<typeof unavailableFixture>) => {
      f.history.tables.artifacts.push(
        legacyHistoryRow('artifacts', { ...f.metadataOnly, id: 'another_retained_file' }),
      );
    },
    (f: ReturnType<typeof unavailableFixture>) => {
      f.history.tables.events.push(
        legacyHistoryRow('events', {
          id: 'event_upload',
          project_id: 'project_original',
          type: 'artifact.submitted',
          target_id: 'other',
          payload_json: { artifacts: [f.metadataOnly.id] },
        }),
      );
    },
    (f: ReturnType<typeof unavailableFixture>) => {
      f.history.tables.artifact_figures[0]!.artifact_id = f.metadataOnly.id;
    },
  ]) {
    const f = unavailableFixture();
    modify(f);
    assert.throws(() => planLegacyMedia(f.history, f.audit), { code: 'legacy_unavailable_audit' });
  }
});
