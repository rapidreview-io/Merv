import { z } from 'zod';
import { check, MervError, type ArtifactFileProvider, type State } from '@merv/contracts';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type { ObjectRecord, SbxObjects } from '@sandboxes/storage';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().safe();
const nativeReference = z.tuple([
  z.literal(1),
  id,
  id,
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
  id,
  id,
  id,
  id,
  hash,
  size,
]);
const identity = z.object({ sha256: hash, size });
const refusals = mervRefusals(MervError);

/** Both retired providers read immutable receipts directly; no native state is resumed or changed. */
export function historicalEvidenceDownloads(
  state: State,
  objects: Pick<SbxObjects, 'get' | 'download'>,
  legacyNamespace?: string,
): ArtifactFileProvider {
  return {
    async download(projectId, reference) {
      check(
        !state.ambient && !state.readScope,
        'sandbox_evidence_transaction',
        'Historical downloads must run outside a Merv transaction',
        409,
      );
      let namespace: string, objectId: string, sha256: string, bytes: number;
      if (id.safeParse(reference).success) {
        check(
          legacyNamespace,
          'download_unsupported',
          'Legacy capture namespace is unavailable',
          503,
        );
        namespace = legacyNamespace;
        objectId = reference;
        // The legacy provider used its configured ML namespace and the artifact's project.
        // Bare object ids carry no digest: recover it from that project's immutable manifest.
        const files = await state.read((sql) =>
          sql.all<{ sha256: string; size: number }>(
            `SELECT DISTINCT f->>'hash' AS sha256,(f->>'size')::double precision AS size
             FROM artifacts a,jsonb_array_elements(a.file_refs_json) r,jsonb_array_elements(a.files_json) f
             WHERE a.project_id=? AND r->>'provider'='sandboxes' AND r->>'reference'=?
             AND f->>'name'=r->>'name' AND f->>'provider'='sandboxes'`,
            projectId,
            reference,
          ),
        );
        check(
          files.length === 1,
          'not_found',
          'Retained file does not belong to this project',
          404,
        );
        const parsed = identity.safeParse(files[0]);
        check(parsed.success, 'invalid_sandbox_evidence', 'Invalid retained file identity');
        ({ sha256, size: bytes } = parsed.data);
      } else {
        let decoded: unknown;
        try {
          decoded = JSON.parse(reference);
        } catch {
          decoded = null;
        }
        const parsed = nativeReference.safeParse(decoded);
        check(parsed.success, 'invalid_sandbox_evidence', 'Invalid retained file reference');
        const connectionId = parsed.data[1];
        [, , namespace, , , , , objectId, sha256, bytes] = parsed.data;
        const owner = await state.read((sql) =>
          sql.get(
            `SELECT c.id FROM sandbox_native_connections c
             JOIN sandbox_native_projects p ON p.project_id=c.project_id
             WHERE c.id=? AND c.project_id=?`,
            connectionId,
            projectId,
          ),
        );
        // Disconnecting or reconnecting changes the current pointer, not historical ownership.
        check(owner, 'not_found', 'Retained file does not belong to this project', 404);
      }
      const verify = (object: ObjectRecord) =>
        check(
          object.id === objectId &&
            object.namespace === namespace &&
            object.kind === 'file' &&
            object.state === 'available' &&
            object.sha256 === sha256 &&
            object.size_bytes === bytes,
          'sandbox_evidence_invalid',
          'Retained file identity changed',
          502,
        );
      verify(await refusals.call(() => objects.get(namespace, objectId)));
      const response = await refusals.call(() =>
        objects.download(namespace, objectId, { ttlSeconds: 240 }),
      );
      verify(response.object);
      return { url: response.url, expiresAt: new Date(Date.now() + 240_000).toISOString() };
    },
  };
}
