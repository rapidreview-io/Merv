import type { PaperContextSection, PaperKind, PaperWorkspace } from './types.js';

/**
 * The paper as context sections: each document's current revision, section by section, then its
 * published revision, document by document in the order `documents` holds them (the order `read`
 * returns). Every body is whole: the consumer's context budget decides what it embeds, and each
 * section names where it is read again.
 */
export function contextSections(documents: PaperWorkspace['documents']): PaperContextSection[] {
  return Object.entries(documents).flatMap(([name, { current, published }]) => {
    const kind = name as PaperKind;
    return (
      [
        ['current', current, null],
        ['published', published?.document, published?.publication ?? null],
      ] as const
    ).flatMap(([status, revision, publication]) =>
      (revision?.sections ?? []).map((section, index): PaperContextSection => ({
        kind,
        status,
        revision: revision!.revision,
        id: `paper:${kind}:${status}:${revision!.revision}:${index}:${section.id}`,
        title: `${kind} ${status}: ${section.title || section.id}`,
        text: section.content,
        note: `${kind}/${status}; section ${section.id}; updated ${revision!.updatedAt ?? 'unknown'}${publication ? `; publication ${publication.id}` : ''}`,
        // paper.read returns a current section by its ID; a published one is in the history.
        refs: [
          ...(status === 'current'
            ? [{ tool: 'paper.read', input: { kind, section: section.id } }]
            : []),
          { tool: 'paper.read', input: { kind, history: true } },
        ],
      })),
    );
  });
}
