import { check, digest, type Data } from '@merv/contracts';
import type { LegacyHistoryType } from './history.js';

type MediaSlot = 'figure' | 'image' | 'embed' | 'link-preview-image';
interface LegacyMediaLink {
  artifactId: string;
  label: string;
  slot: MediaSlot;
}
const namespacePattern = /^[A-Za-z0-9_-]{1,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function string(value: unknown): string {
  check(typeof value === 'string', 'legacy_media_metadata', 'Media source metadata is invalid');
  return value;
}

/** The media slots a record fills, each with a valid content hash. */
function mediaSlots(type: LegacyHistoryType, data: Data) {
  const result: { slot: MediaSlot; label: string }[] = [];
  const add = (slot: MediaSlot, hash: unknown, label: string) => {
    if (hash === '' || hash === null || hash === undefined) return;
    check(
      typeof hash === 'string' && hashPattern.test(hash),
      'legacy_media_hash',
      'Media reference has an invalid content hash',
    );
    result.push({ slot, label });
  };
  if (type === 'artifact_figures' && data.status === 'complete') {
    check(
      typeof data.content_sha256 === 'string' && hashPattern.test(data.content_sha256),
      'legacy_media_hash',
      'Completed figure has no valid content hash',
    );
    add('figure', data.content_sha256, `Figure: ${string(data.link_path)}`);
  }
  if (type === 'posts') {
    add('image', data.image_sha256, 'Post image');
    add('embed', data.embed_sha256, 'Post embed');
    const preview = data.link_preview_json;
    check(
      preview !== null && typeof preview === 'object' && !Array.isArray(preview),
      'legacy_media_metadata',
      'Post preview must be validated structured history',
    );
    add('link-preview-image', preview.image_sha256, 'Link preview image');
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
  return mediaSlots(type, data).map(({ slot, label }) => ({
    artifactId: `art_legacy_media_${digest({ namespace: projectId, type, id, slot })}`,
    label,
    slot,
  }));
}
