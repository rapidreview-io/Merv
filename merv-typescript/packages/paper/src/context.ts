import type { PaperContextSection, PaperKind, PaperWorkspace } from './types.js';

/**
 * The paper as context sections: each document's current revision, section by section, then its
 * published revision, document by document in the order `documents` holds them (the order `read`
 * returns). Every body is whole: the consumer's context budget decides what it embeds, and each
 * section names where it is read again. A section without content is left out, since it holds
 * nothing to read; the IDs of the others keep their place in the revision.
 */
export function contextSections(documents: PaperWorkspace['documents']): PaperContextSection[] {
  const sections: PaperContextSection[] = [];
  for (const [name, { current, published }] of Object.entries(documents)) {
    const kind = name as PaperKind;
    for (const [status, revision, publication] of [
      ['current', current, null],
      ['published', published?.document, published?.publication ?? null],
    ] as const) {
      if (!revision) continue;
      for (const [index, section] of revision.sections.entries()) {
        if (!section.content) continue;
        sections.push({
          kind,
          status,
          revision: revision.revision,
          id: `paper:${kind}:${status}:${revision.revision}:${index}:${section.id}`,
          title: `${kind} ${status}: ${section.title || section.id}`,
          text: section.content,
          priority:
            kind === 'problem'
              ? status === 'current'
                ? 850
                : 450
              : status === 'current'
                ? 600
                : 250,
          note: `${kind}/${status} revision ${revision.revision}; section ${section.id}; updated ${revision.updatedAt ?? 'unknown'}${publication ? `; publication ${publication.id}` : ''}`,
          // paper.read returns a current section by its ID; a published one is in the history.
          refs: [
            ...(status === 'current'
              ? [{ tool: 'paper.read', input: { kind, section: section.id } }]
              : []),
            { tool: 'paper.read', input: { kind, history: true } },
          ],
        });
      }
    }
  }
  return sections;
}
