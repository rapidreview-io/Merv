import { check, digest, type Data } from '@merv/contracts';
import type { LegacyHistoryType } from './legacy-history.js';

export type MediaKind = 'artifacts' | 'figures' | 'postImages' | 'postEmbeds' | 'linkPreviewImages';
export type MediaSlot = 'figure' | 'image' | 'embed' | 'link-preview-image';
export interface LegacyMediaLink {
  artifactId: string;
  label: string;
  slot: MediaSlot;
}
const namespacePattern = /^[A-Za-z0-9_-]{1,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const safeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
]);
const mediaType = (value: unknown) =>
  typeof value === 'string' && safeTypes.has(value.toLowerCase())
    ? value.toLowerCase()
    : 'application/octet-stream';
function string(value: unknown): string {
  check(typeof value === 'string', 'legacy_media_metadata', 'Media source metadata is invalid');
  return value;
}
export const legacyMediaArtifactId = (
  namespace: string,
  type: string,
  id: string,
  slot: MediaSlot,
) => `art_legacy_media_${digest({ namespace, type, id, slot })}`;

export function legacyMediaSlots(type: LegacyHistoryType, data: Data) {
  const result: {
    slot: MediaSlot;
    kind: MediaKind;
    hash: string;
    mediaType: string;
    label: string;
  }[] = [];
  const add = (slot: MediaSlot, kind: MediaKind, hash: unknown, mime: unknown, label: string) => {
    if (hash === '' || hash === null || hash === undefined) return;
    check(
      typeof hash === 'string' && hashPattern.test(hash),
      'legacy_media_hash',
      'Media reference has an invalid content hash',
    );
    result.push({ slot, kind, hash, mediaType: mediaType(mime), label });
  };
  if (type === 'artifact_figures' && data.status === 'complete') {
    check(
      typeof data.content_sha256 === 'string' && hashPattern.test(data.content_sha256),
      'legacy_media_hash',
      'Completed figure has no valid content hash',
    );
    add('figure', 'figures', data.content_sha256, undefined, `Figure: ${string(data.link_path)}`);
  }
  if (type === 'posts') {
    add('image', 'postImages', data.image_sha256, data.image_content_type, 'Post image');
    add('embed', 'postEmbeds', data.embed_sha256, data.embed_content_type, 'Post embed');
    const preview = data.link_preview_json;
    check(
      preview !== null && typeof preview === 'object' && !Array.isArray(preview),
      'legacy_media_metadata',
      'Post preview must be validated structured history',
    );
    add(
      'link-preview-image',
      'linkPreviewImages',
      preview.image_sha256,
      preview.image_content_type,
      'Link preview image',
    );
  }
  return result;
}

/** The caller must first authorize this historical record. Never accepts a blob key or URL. */
export function historyMediaLinks(
  type: LegacyHistoryType,
  id: string,
  data: Data,
  projectId: string,
): LegacyMediaLink[] {
  if (type !== 'posts' && type !== 'artifact_figures') return [];
  check(
    namespacePattern.test(projectId) &&
      data.id === id &&
      (type !== 'posts' || data.project_id === projectId),
    'legacy_media_scope',
    'Media record identity does not match its authorized project',
  );
  return legacyMediaSlots(type, data).map(({ slot, label }) => ({
    artifactId: legacyMediaArtifactId(projectId, type, id, slot),
    label,
    slot,
  }));
}
