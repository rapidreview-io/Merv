import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_TRANSFER_BYTES } from '@merv/blobs';
import { check, digest } from '@merv/contracts';
import { planLegacyFoundation, type LegacyFoundationSnapshot } from './legacy-import.js';
import { planLegacyHistory } from './legacy-history.js';
import {
  legacyMediaArtifactId,
  legacyMediaSlots,
  type MediaKind,
  type MediaSlot,
  type LegacyMediaLink,
} from './legacy-media-links.js';

export interface LegacyMediaFile extends LegacyMediaLink {
  namespace: string;
  sourceType: 'artifact_figures' | 'posts';
  sourceId: string;
  hash: string;
  size: number | null;
  mediaType: string;
  title: string;
  path: string;
  createdBy: string;
  createdAt: string;
  attribution: 'parent-artifact' | 'post-author-handle';
  parentArtifactId?: string;
}
interface MediaReference {
  kind: MediaKind;
  id: string;
  artifactId: string;
  mediaType: string;
  parentArtifactId?: string;
  linkPath?: string;
  slot?: MediaSlot;
}
export interface LegacyMediaObject {
  namespace: string;
  hash: string;
  size: number | null;
  references: MediaReference[];
}
export interface VerifiedLegacyMediaReceipt {
  namespace: string;
  hash: string;
  size: number;
}

const namespacePattern = /^[A-Za-z0-9_-]{1,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function string(value: unknown): string {
  check(typeof value === 'string', 'legacy_media_metadata', 'Media source metadata is invalid');
  return value;
}
const key = (object: { namespace: string; hash: string }) => `${object.namespace}/${object.hash}`;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const unavailableTupleSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().regex(namespacePattern),
    hash: z.string().regex(hashPattern),
    size: z.number().int().nonnegative(),
  })
  .strict();
export interface LegacyUnavailableArtifacts {
  auditSha256: string;
  artifacts: z.infer<typeof unavailableTupleSchema>[];
}

/** The deployment supplies an independently approved checksum, never a source-derived checksum. */
export function legacyUnavailableArtifacts(
  auditBytes: Uint8Array,
  expectedSha256: string,
): LegacyUnavailableArtifacts {
  check(
    hashPattern.test(expectedSha256) &&
      createHash('sha256').update(auditBytes).digest('hex') === expectedSha256,
    'legacy_unavailable_audit',
    'Historical unavailability audit does not match its approved checksum',
  );
  const parsed = z
    .object({
      references: z.array(
        z
          .object({
            kind: z.string(),
            id: z.string(),
            project_id: z.string(),
            sha256: z.string(),
            size_bytes: z.number(),
            covered: z.boolean(),
          })
          .strict(),
      ),
    })
    .passthrough()
    .safeParse(JSON.parse(Buffer.from(auditBytes).toString('utf8')));
  check(parsed.success, 'legacy_unavailable_audit', 'Historical audit projection is invalid');
  return {
    auditSha256: expectedSha256,
    artifacts: parsed.data.references
      .filter((row) => !row.covered)
      .map((row) => {
        check(
          row.kind === 'artifact',
          'legacy_unavailable_audit',
          'Only documented artifact lineage may lack retained bytes',
        );
        const tuple = unavailableTupleSchema.safeParse({
          id: row.id,
          projectId: row.project_id,
          hash: row.sha256,
          size: row.size_bytes,
        });
        check(tuple.success, 'legacy_unavailable_audit', 'Historical artifact tuple is invalid');
        return tuple.data;
      })
      .sort((a, b) => order(a.id, b.id)),
  };
}

function unavailableArtifacts(
  history: ReturnType<typeof planLegacyHistory>,
  audit?: LegacyUnavailableArtifacts,
) {
  if (!audit) return new Map<string, z.infer<typeof unavailableTupleSchema>>();
  check(
    hashPattern.test(audit.auditSha256),
    'legacy_unavailable_audit',
    'Invalid historical audit checksum',
  );
  const originals = new Map(
    history.records.filter((r) => r.type === 'artifacts').map((r) => [r.id, r]),
  );
  const unavailable = new Map<string, z.infer<typeof unavailableTupleSchema>>();
  for (const tuple of audit.artifacts) {
    const row = originals.get(tuple.id);
    check(
      !unavailable.has(tuple.id) &&
        row?.data.status === 'complete' &&
        row.projectId === tuple.projectId &&
        row.data.content_sha256 === tuple.hash &&
        row.data.size_bytes === tuple.size,
      'legacy_unavailable_audit',
      'Historical exception must match its exact unchanged source artifact',
    );
    unavailable.set(tuple.id, tuple);
  }
  const contains = (value: unknown): boolean =>
    typeof value === 'string'
      ? unavailable.has(value)
      : Array.isArray(value)
        ? value.some(contains)
        : value && typeof value === 'object'
          ? Object.values(value).some(contains)
          : false;
  const unavailableLinks = new Set<string>();
  for (const record of history.records) {
    if (
      record.type === 'research_artifact_links' &&
      unavailable.has(String(record.data.artifact_id))
    ) {
      check(
        !record.data.submission_id,
        'legacy_unavailable_audit',
        'Submitted evidence cannot be exempted',
      );
      unavailableLinks.add(record.id);
    }
    if (
      record.type === 'events' &&
      ['artifact.submitted', 'artifact.pinned'].includes(String(record.data.type))
    )
      check(
        !contains(record.data.target_id) && !contains(record.data.payload_json),
        'legacy_unavailable_audit',
        'Uploaded or pinned evidence cannot be exempted',
      );
    if (record.type === 'artifact_figures')
      check(
        !unavailable.has(String(record.data.artifact_id)),
        'legacy_unavailable_audit',
        'Figure parent cannot be exempted',
      );
  }
  for (const record of history.records)
    if (record.type === 'research_submission_artifacts')
      check(
        !unavailableLinks.has(String(record.data.link_id)),
        'legacy_unavailable_audit',
        'Submitted evidence cannot be exempted',
      );
  return unavailable;
}

/** Fixed Merv-owned byte references. Sandbox objects and arbitrary source_uri/link URLs are never fetched. */
export function planLegacyMedia(input: unknown, audit?: LegacyUnavailableArtifacts) {
  const history = planLegacyHistory(input);
  const unavailable = unavailableArtifacts(history, audit);
  const artifacts = new Map(
    history.records.filter((r) => r.type === 'artifacts').map((r) => [r.id, r]),
  );
  const objects = new Map<string, LegacyMediaObject>();
  const files: LegacyMediaFile[] = [];
  const references: Record<MediaKind, number> = {
    artifacts: 0,
    figures: 0,
    postImages: 0,
    postEmbeds: 0,
    linkPreviewImages: 0,
  };
  const add = (namespace: string, hash: string, size: number | null, reference: MediaReference) => {
    check(
      namespacePattern.test(namespace),
      'legacy_media_namespace',
      'Media namespace is not a supported project',
    );
    check(
      hashPattern.test(hash),
      'legacy_media_hash',
      'Media reference has an invalid content hash',
    );
    check(
      size === null || (Number.isSafeInteger(size) && size >= 0 && size <= MAX_TRANSFER_BYTES),
      'legacy_media_size',
      'Media size must be nonnegative and at most 512 MiB',
    );
    const objectKey = key({ namespace, hash });
    const object = objects.get(objectKey) ?? { namespace, hash, size: null, references: [] };
    check(
      object.size === null || size === null || object.size === size,
      'legacy_media_size',
      'References to the same media hash have conflicting sizes',
    );
    object.size ??= size;
    object.references.push(reference);
    objects.set(objectKey, object);
    references[reference.kind]++;
  };
  for (const record of history.records) {
    const { type, id, data, projectId } = record;
    if (type === 'artifacts' && data.status === 'complete' && !unavailable.has(id)) {
      add(projectId, string(data.content_sha256), data.size_bytes as number, {
        kind: 'artifacts',
        id,
        artifactId: id,
        mediaType: string(data.content_type),
      });
    }
    if (type !== 'artifact_figures' && type !== 'posts') continue;
    for (const part of legacyMediaSlots(type, data)) {
      const figure = type === 'artifact_figures';
      const parent = figure ? artifacts.get(string(data.artifact_id)) : undefined;
      check(
        !figure || (parent && parent.projectId === projectId),
        'legacy_media_parent',
        'Figure parent does not belong to the same retained project',
      );
      const createdAt = string(figure ? parent!.data.created_at : data.created_at);
      check(
        Number.isFinite(Date.parse(createdAt)),
        'legacy_media_metadata',
        'Media has an invalid source creation time',
      );
      const file: LegacyMediaFile = {
        artifactId: legacyMediaArtifactId(projectId, type, id, part.slot),
        label: part.label,
        slot: part.slot,
        namespace: projectId,
        sourceType: type,
        sourceId: id,
        hash: part.hash,
        size: figure ? (data.size_bytes as number) : null,
        mediaType: part.mediaType,
        title: `${part.label}${figure ? '' : `: ${id}`}`.slice(0, 300),
        path: figure ? string(data.link_path) : `legacy/posts/${id}/${part.slot}`,
        createdBy: string(figure ? parent!.data.created_by : data.author_handle),
        createdAt,
        attribution: figure ? 'parent-artifact' : 'post-author-handle',
        ...(figure ? { parentArtifactId: parent!.id } : {}),
      };
      files.push(file);
      add(projectId, part.hash, file.size, {
        kind: part.kind,
        id,
        artifactId: file.artifactId,
        mediaType: file.mediaType,
        slot: file.slot,
        ...(figure ? { parentArtifactId: parent!.id, linkPath: file.path } : {}),
      });
    }
  }
  files.sort((a, b) => order(a.artifactId, b.artifactId));
  const entries = [...objects.values()].sort((a, b) => order(key(a), key(b)));
  for (const tuple of unavailable.values())
    check(
      !objects.has(key({ namespace: tuple.projectId, hash: tuple.hash })),
      'legacy_unavailable_audit',
      'An exempted object is also required by a retained file',
    );
  return {
    sourceId: history.sourceId,
    historyFingerprint: history.fingerprint,
    metadataOnlyArtifacts: [...unavailable.values()].sort((a, b) => order(a.id, b.id)),
    files,
    references,
    distinctObjects: entries.length,
    missingSizesRequiringHead: entries.filter((o) => o.size === null).length,
    knownBytes: entries.reduce((sum, o) => sum + (o.size ?? 0), 0),
    objects: entries,
  };
}

const receiptSchema = z
  .object({
    namespace: z.string().regex(namespacePattern),
    hash: z.string().regex(hashPattern),
    size: z.number().int().nonnegative().max(MAX_TRANSFER_BYTES),
  })
  .strict();
const fields = {
  projects: ['id', 'name', 'summary', 'created_at', 'status'],
  claims: ['id', 'project_id', 'statement', 'scope', 'status', 'confidence', 'created_at'],
  artifacts: [
    'id',
    'project_id',
    'title',
    'path',
    'created_by',
    'created_at',
    'status',
    'content_type',
    'content_sha256',
    'size_bytes',
  ],
} as const;

/** Trusted offline receipts only, obtained from copyVerifiedFrom; never an API input.
 * Recompute from the protected source snapshot to validate an immutable prepared manifest. */
export function prepareLegacyMediaFoundation(
  foundationInput: unknown,
  historyInput: unknown,
  verifiedReceipts: readonly VerifiedLegacyMediaReceipt[],
  audit?: LegacyUnavailableArtifacts,
) {
  const base = planLegacyFoundation(foundationInput);
  const history = planLegacyHistory(historyInput);
  const media = planLegacyMedia(historyInput, audit);
  check(
    base.snapshot.sourceId === history.sourceId,
    'legacy_media_source_mismatch',
    'Foundation and media use different source snapshots',
  );
  for (const type of ['projects', 'claims', 'artifacts'] as const) {
    const original = history.records
      .filter((r) => r.type === type && (type !== 'artifacts' || r.data.status === 'complete'))
      .map((r) => Object.fromEntries(fields[type].map((field) => [field, r.data[field]])))
      .sort((a, b) => order(String(a.id), String(b.id)));
    const retained = [...base.snapshot[type]].sort((a, b) => order(a.id, b.id));
    check(
      digest(original) === digest(retained),
      'legacy_media_source_mismatch',
      'Original foundation records do not match preserved history',
    );
  }
  const receipts = new Map<string, VerifiedLegacyMediaReceipt>();
  for (const value of verifiedReceipts) {
    const parsed = receiptSchema.safeParse(value);
    check(parsed.success, 'legacy_media_receipt', 'Verified media receipt is invalid');
    const objectKey = key(parsed.data);
    check(!receipts.has(objectKey), 'legacy_media_receipt', 'Duplicate verified media receipt');
    receipts.set(objectKey, parsed.data);
  }
  check(
    receipts.size === media.objects.length,
    'legacy_media_receipt',
    'Every retained media object needs exactly one verified receipt',
  );
  for (const object of media.objects) {
    const receipt = receipts.get(key(object));
    check(
      receipt && (object.size === null || object.size === receipt.size),
      'legacy_media_receipt',
      'Verified receipt does not match its retained project, hash and size',
    );
  }
  const originalIds = new Set(
    history.records.filter((record) => record.type === 'artifacts').map((record) => record.id),
  );
  const bindings = media.files.map((file) => {
    check(
      !originalIds.has(file.artifactId),
      'legacy_media_collision',
      'Derived media ID collides with another artifact',
    );
    originalIds.add(file.artifactId);
    return { ...file, size: receipts.get(key(file))!.size };
  });
  const derived: LegacyFoundationSnapshot['artifacts'] = bindings.map((file) => ({
    id: file.artifactId,
    project_id: file.namespace,
    title: file.title,
    path: file.path,
    created_by: file.createdBy,
    created_at: file.createdAt,
    status: 'complete',
    content_type: file.mediaType,
    content_sha256: file.hash,
    size_bytes: file.size,
  }));
  const metadataOnly = new Set(media.metadataOnlyArtifacts.map((row) => row.id));
  const foundation = planLegacyFoundation({
    ...base.snapshot,
    artifacts: [...base.snapshot.artifacts.filter((row) => !metadataOnly.has(row.id)), ...derived],
  });
  const artifactRetention = {
    ...(audit ? { auditSha256: audit.auditSha256 } : {}),
    artifacts: base.snapshot.artifacts
      .map((row) => ({
        projectId: row.project_id,
        id: row.id,
        hash: row.content_sha256,
        size: row.size_bytes,
        ...(metadataOnly.has(row.id)
          ? {
              status: 'metadata-only' as const,
              reason: 'legacy-lineage-without-retained-bytes' as const,
              auditSha256: audit!.auditSha256,
            }
          : { status: 'verified' as const, artifactId: row.id }),
      }))
      .sort((a, b) => order(a.id, b.id)),
  };
  const manifest = {
    format: 'merv-legacy-media-v2' as const,
    sourceId: media.sourceId,
    sourceFoundationFingerprint: base.fingerprint,
    historyFingerprint: history.fingerprint,
    preparedFoundationFingerprint: foundation.fingerprint,
    originalArtifacts: base.artifacts,
    verifiedOriginalArtifacts: base.artifacts - metadataOnly.size,
    metadataOnlyArtifacts: media.metadataOnlyArtifacts,
    artifactRetention,
    ...(audit ? { unavailableAudit: audit } : {}),
    derivedArtifacts: bindings.length,
    bindings,
    verifiedObjects: [...receipts.values()].sort((a, b) => order(key(a), key(b))),
  };
  return {
    foundation: foundation.snapshot,
    manifest: { ...manifest, fingerprint: digest(manifest) },
  };
}
