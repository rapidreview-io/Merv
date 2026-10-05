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

/** At most about this many characters of snapshot. */
const whole = 30_000;
/**
 * The paper as a main agent's turn is told it: the Problem sections still empty, then each
 * section by its context priority (the Problem's current sections first), labeled with its
 * document, status and revision. Bodies are whole while `bodies` characters of them fit; a
 * published body the snapshot already holds as current names that section; every other body, and
 * every section past the snapshot's size, says how to read it.
 */
export function paperSnapshot(documents: PaperWorkspace['documents'], bodies = 12_000): string {
  const empty = (documents.problem?.current.sections ?? [])
    .filter((section) => !section.content.trim())
    .map((section) => section.id);
  const lines = [
    'Project paper snapshot (current and published revisions are labeled). Read omitted section content with paper.read before relying on it.',
    ...(empty.length ? [`Empty Problem sections: ${empty.join(', ')}.`] : []),
  ];
  const shown = new Map<string, string>();
  let left = bodies;
  let size = lines.join('\n').length;
  let omitted = 0;
  for (const section of contextSections(documents).sort((a, b) => b.priority - a.priority)) {
    const key = `${section.kind}\n${section.text}`;
    const same = section.status === 'published' ? shown.get(key) : undefined;
    const fits = !same && section.text.length <= left;
    const body = same
      ? `(same content as current section ${same})`
      : fits
        ? section.text
        : `(${section.text.length} characters; read with paper.read)`;
    const entry = `\n## ${section.title}\n${section.note}\n${body}`;
    if (size + entry.length > whole) {
      omitted++;
      continue;
    }
    if (fits) left -= section.text.length;
    if (fits && section.status === 'current') shown.set(key, section.id);
    size += entry.length;
    lines.push(entry);
  }
  if (omitted) lines.push(`\n${omitted} more sections omitted; read with paper.read.`);
  return lines.join('\n');
}
