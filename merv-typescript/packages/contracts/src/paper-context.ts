type Section = { id?: string; content: string };
type Revision = { sections: Section[] };
type Document = { current: Revision; published: { document: Revision } | null };
const rank = (id?: string) => {
  const position = ['goals', 'scope', 'problem', 'constraints'].indexOf(id ?? '');
  return position < 0 ? 4 : position;
};

/** Keep revision metadata and mark long paper sections for an explicit paper.read. */
export function boundedPaperContext<T extends object>(documents: T, room = 40_000): T {
  const copy = structuredClone(documents);
  let left = room;
  const shorten = (revision: Revision, prioritizeGoal = false) => {
    const sections = prioritizeGoal
      ? [...revision.sections].sort((a, b) => rank(a.id) - rank(b.id))
      : revision.sections;
    for (const section of sections) {
      if (section.content.length <= left) left -= section.content.length;
      else section.content = `(${section.content.length} characters; read with paper.read)`;
    }
  };
  const entries = Object.entries(copy) as [string, Document][];
  for (const [kind, document] of entries) {
    if (kind === 'problem') shorten(document.current, true);
  }
  for (const [kind, document] of entries) {
    if (kind !== 'problem') shorten(document.current);
  }
  for (const [, document] of entries) {
    if (document.published) shorten(document.published.document);
  }
  return copy;
}
