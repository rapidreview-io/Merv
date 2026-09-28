import { newId, sha256Hex, type Artifact, type Caller, type State } from '@merv/contracts';

/**
 * A row of at most the inline limit without its bytes, as rows were written before bytes were
 * kept in the row: a server fault on every read, now that none is left in production.
 */
export async function legacyArtifact(
  state: State,
  caller: Caller,
  bytes: Buffer,
): Promise<Artifact> {
  const artifact: Artifact = {
    id: newId('art'),
    projectId: caller.projectId,
    createdBy: caller.actorId,
    title: 'Legacy evidence',
    mediaType: 'text/plain',
    hash: sha256Hex(bytes),
    size: bytes.length,
    createdAt: new Date().toISOString(),
  };
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?)',
      artifact.id,
      artifact.projectId,
      artifact.createdBy,
      artifact.title,
      artifact.mediaType,
      artifact.hash,
      artifact.size,
      artifact.createdAt,
    ),
  );
  return artifact;
}
