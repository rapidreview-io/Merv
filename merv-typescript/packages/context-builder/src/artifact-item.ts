import { itemTitle, type ContextItem } from '@merv/contracts';

// How a recipe's consumer lists an artifact: pure, so each consumer runs it on its own inputs.

/**
 * An artifact as a context item, named by its title, its body the artifact's bytes, and read
 * again with artifact.read. Its ID is `artifact:{id}` unless `item` gives another.
 */
export const artifactItem = (
  artifact: { id: string; title: string },
  item: Omit<ContextItem, 'title' | 'body' | 'refs' | 'id'> & { id?: string } = {},
): ContextItem => ({
  id: `artifact:${artifact.id}`,
  title: itemTitle(artifact),
  body: { artifactId: artifact.id },
  refs: [{ tool: 'artifact.read', input: { artifactId: artifact.id } }],
  ...item,
});
