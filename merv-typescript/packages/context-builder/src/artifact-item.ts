import { itemTitle, type ContextInput, type ContextItem } from '@merv/contracts';

// How a recipe's consumer lists its inputs: pure, so each consumer runs it on its own inputs.

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

/** A text as a context item: its body the text itself, read again through `item.refs`. */
export const textItem = (
  id: string,
  title: string,
  text: string,
  item: Omit<ContextItem, 'id' | 'title' | 'body'> = {},
): ContextItem => ({ id, title, body: { text }, ...item });

/** Every artifact the items of these inputs name, once each, in the order they are named. */
export const itemArtifactIds = (inputs: Record<string, ContextInput>): string[] => [
  ...new Set(
    Object.values(inputs).flatMap((input) =>
      input.items.flatMap((item) => ('artifactId' in item.body ? [item.body.artifactId] : [])),
    ),
  ),
];
