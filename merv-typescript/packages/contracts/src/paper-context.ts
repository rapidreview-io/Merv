type Section = { id?: string; content: string };
type Revision = { revision?: number; sections: Section[] };
type Document = { current: Revision; published: { document: Revision } | null };
const rank = (id?: string) => {
  const position = ['goals', 'scope', 'problem', 'constraints'].indexOf(id ?? '');
  return position < 0 ? 4 : position;
};

/** Keep revision metadata and mark long paper sections for an explicit paper.read. */
export function boundedPaperContext<T extends object>(documents: T, room = 40_000): T {
  const copy = structuredClone(documents);
  let left = room;
  const currentBodies = new Map<string, Map<string, string>>();
  const shorten = (revision: Revision, prioritizeGoal = false) => {
    const included = new Map<string, string>();
    const sections = prioritizeGoal
      ? [...revision.sections].sort((a, b) => rank(a.id) - rank(b.id))
      : revision.sections;
    for (const section of sections) {
      if (section.content.length <= left) {
        left -= section.content.length;
        if (!included.has(section.content))
          included.set(section.content, section.id ?? `#${revision.sections.indexOf(section) + 1}`);
      } else section.content = `(${section.content.length} characters; read with paper.read)`;
    }
    return included;
  };
  const entries = Object.entries(copy) as [string, Document][];
  for (const [kind, document] of entries) {
    if (kind === 'problem') currentBodies.set(kind, shorten(document.current, true));
  }
  for (const [kind, document] of entries) {
    if (kind !== 'problem') currentBodies.set(kind, shorten(document.current));
  }
  for (const [kind, document] of entries) {
    if (!document.published) continue;
    // A published revision may contain the current section verbatim. Keep its own revision,
    // section title and publication provenance, but point its duplicate body at the current
    // section when that body was actually included above. Compare original bytes, never ids or
    // abbreviated content, so a distinct published draft is still shown.
    for (const section of document.published.document.sections) {
      const sameAs = currentBodies.get(kind)?.get(section.content);
      if (sameAs !== undefined) {
        section.content = `(same content as current revision ${document.current.revision ?? '?'}, section ${sameAs}; read with paper.read)`;
      } else if (section.content.length <= left) {
        left -= section.content.length;
      } else {
        section.content = `(${section.content.length} characters; read with paper.read)`;
      }
    }
  }
  return copy;
}
