import { newId, sha256Hex, type Artifact, type Caller, type State } from '@merv/contracts';

/**
 * An artifact row as it was written before bytes were kept in the row: metadata only, with its
 * bytes wherever `store` puts them (blobs, or an object store). Reads of it fetch from storage.
 */
export async function legacyArtifact(
  state: State,
  caller: Caller,
  bytes: Buffer,
  store: (bytes: Buffer) => unknown,
  options: { title?: string; objectId?: string } = {},
): Promise<Artifact> {
  await store(bytes);
  const artifact: Artifact = {
    id: newId('art'),
    projectId: caller.projectId,
    createdBy: caller.actorId,
    title: options.title ?? 'Legacy evidence',
    mediaType: 'text/plain',
    hash: sha256Hex(bytes),
    size: bytes.length,
    createdAt: new Date().toISOString(),
    ...(options.objectId ? { objectId: options.objectId } : {}),
  };
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,object_id) VALUES(?,?,?,?,?,?,?,?,?)',
      artifact.id,
      artifact.projectId,
      artifact.createdBy,
      artifact.title,
      artifact.mediaType,
      artifact.hash,
      artifact.size,
      artifact.createdAt,
      options.objectId ?? null,
    ),
  );
  return artifact;
}
