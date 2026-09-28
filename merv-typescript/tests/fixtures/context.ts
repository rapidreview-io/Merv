import type {
  Artifact,
  Caller,
  ContextBuild,
  ContextPackage,
  ContextRegistration,
  ContextSource,
  Transaction,
} from '@merv/contracts';

/** Renders and saves a context as tasks does: a preview, then `build` of that preview. */
export async function buildContext(
  registration: ContextRegistration,
  caller: Caller,
  { requestId, ...input }: ContextBuild,
  tx?: Transaction,
): Promise<ContextPackage> {
  const preview = await registration.preview(caller, input, tx);
  return await registration.build(caller, { requestId, preview }, tx);
}

/** An artifact as a context package records it among its sources. */
export const contextSource = ({ id, title, mediaType, hash, size }: Artifact): ContextSource => ({
  id,
  title,
  mediaType,
  hash,
  size,
});
