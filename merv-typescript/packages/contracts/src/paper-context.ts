type Section = { id?: string; content: string };
type Revision = { revision?: number; sections: Section[]; omittedSections?: number };
type Document = { current: Revision; published: { document: Revision } | null };
const rank = (id?: string) => {
  const position = ['goals', 'scope', 'problem', 'constraints'].indexOf(id ?? '');
  return position < 0 ? 4 : position;
};
const marker = (length: number) => `(${length} characters; read with paper.read)`;

/** The paper JSON cap for a frozen recipe whose required section carries the paper: a third of
 *  its budget, so the paper leaves room for everything else the section and recipe hold. */
export const paperJsonCap = (maxChars: number) => Math.floor(maxChars / 3);

/**
 * Keep revision metadata and mark long paper sections for an explicit paper.read. `room` bounds
 * the section bodies. When the JSON is still longer than `maxJson`, which counts titles, IDs and
 * markers too, every body but the current problem's goals, scope, problem and constraints becomes
 * its marker; if that is not enough, those other sections are removed and each revision counts
 * them in `omittedSections`. Only the problem's current revision keeps those four sections: its
 * published revision loses them like any other. Under the cap the result is exactly what `room`
 * alone gives. The result is typed as `T`, but a capped revision may hold fewer sections and an
 * extra `omittedSections` count, so callers treat it as JSON for the prompt.
 */
export function boundedPaperContext<T extends object>(
  documents: T,
  room = 40_000,
  maxJson = Infinity,
): T {
  const copy = structuredClone(documents);
  let left = room;
  const currentBodies = new Map<string, Map<string, string>>();
  /** Sections that still hold their whole body. */
  const whole = new Set<Section>();
  const shorten = (revision: Revision, prioritizeGoal = false) => {
    const included = new Map<string, string>();
    const sections = prioritizeGoal
      ? [...revision.sections].sort((a, b) => rank(a.id) - rank(b.id))
      : revision.sections;
    for (const section of sections) {
      if (section.content.length <= left) {
        left -= section.content.length;
        whole.add(section);
        if (!included.has(section.content))
          included.set(section.content, section.id ?? `#${revision.sections.indexOf(section) + 1}`);
      } else section.content = marker(section.content.length);
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
      const reference =
        sameAs === undefined
          ? null
          : `(same content as current revision ${document.current.revision ?? '?'}, section ${sameAs}; read with paper.read)`;
      if (reference && reference.length < section.content.length) {
        section.content = reference;
      } else if (section.content.length <= left) {
        left -= section.content.length;
        whole.add(section);
      } else {
        section.content = marker(section.content.length);
      }
    }
  }
  if (JSON.stringify(copy).length <= maxJson) return copy;
  const revisions = entries.flatMap(([, document]) =>
    document.published ? [document.current, document.published.document] : [document.current],
  );
  const problem = entries.find(([kind]) => kind === 'problem')?.[1].current;
  const kept = (revision: Revision, section: Section) =>
    revision === problem && rank(section.id) < 4;
  for (const revision of revisions)
    for (const section of revision.sections)
      if (whole.has(section) && !kept(revision, section)) {
        const shorter = marker(section.content.length);
        if (shorter.length < section.content.length) section.content = shorter;
      }
  if (JSON.stringify(copy).length <= maxJson) return copy;
  for (const revision of revisions) {
    const sections = revision.sections.filter((section) => kept(revision, section));
    if (sections.length === revision.sections.length) continue;
    revision.omittedSections = revision.sections.length - sections.length;
    revision.sections = sections;
  }
  return copy;
}
