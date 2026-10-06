import type { ContextInput, ContextItem } from '@merv/contracts';
import type { PaperContextSection, PaperKind, PaperWorkspace } from './types.js';

/**
 * The most a paper context input takes, in UTF-8 bytes of its sections' JSON: a lease may
 * freeze the input in its receipt, a session packet holds 512 KiB, and the rest of a receipt is
 * far smaller.
 */
const INPUT_BYTES = 384 * 1024;

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
          // paper.read returns exactly this section of this revision, whatever came after it.
          refs: [
            {
              tool: 'paper.read',
              input: { kind, revision: revision.revision, section: section.id },
            },
          ],
        });
      }
    }
  }
  return sections;
}

/**
 * The paper as one context section's items: whole sections, highest priority first, while
 * their distinct text fits `maxChars`, since no more could ever be embedded, and while their
 * JSON fits INPUT_BYTES. One more item names the sections past that, a line each with its
 * title, revision and the paper.read that returns it, while those fit an eighth of `maxChars`,
 * and counts the rest; both keep the paper's order. It outranks every section, so a budget
 * that cuts sections still shows what was left out. A paper with nothing written is one item
 * that says so.
 */
export function paperInput(documents: PaperWorkspace['documents'], maxChars: number): ContextInput {
  const sections = contextSections(documents);
  // Each entry's JSON and the comma after it.
  const size = (entry: object) => Buffer.byteLength(JSON.stringify(entry)) + 1;
  let room = maxChars,
    bytes = INPUT_BYTES;
  const texts = new Set<string>(),
    kept = new Set<PaperContextSection>();
  for (const section of [...sections].sort((a, b) => b.priority - a.priority)) {
    const copy = texts.has(section.text);
    if ((!copy && section.text.length > room) || size(section) > bytes) continue;
    if (!copy) room -= section.text.length;
    bytes -= size(section);
    texts.add(section.text);
    kept.add(section);
  }
  const left: string[] = [],
    rest = sections.filter((section) => !kept.has(section));
  let chars = Math.floor(maxChars / 8);
  for (const { title, revision, refs } of rest) {
    const line = `- ${title} — revision ${revision} — ${refs.map((ref) => `${ref.tool} ${JSON.stringify(ref.input)}`).join('; ')}`;
    if (line.length + 1 > chars || size([line]) > bytes) break;
    chars -= line.length + 1;
    bytes -= size([line]);
    left.push(line);
  }
  const more = rest.length - left.length;
  const read = { tool: 'paper.read', input: {} };
  return {
    items: [
      ...sections
        .filter((section) => kept.has(section))
        .map(({ id, title, text, priority, note, refs }): ContextItem => ({
          id,
          title,
          body: { text },
          priority,
          note,
          refs,
        })),
      ...(rest.length
        ? [
            {
              id: 'paper:not-included',
              title: `${rest.length} more paper section${rest.length === 1 ? '' : 's'}, not included in this assignment`,
              body: { text: left.join('\n') },
              priority: 900,
              ...(more ? { note: `${more} of them not named here for lack of room` } : {}),
              refs: [read],
            },
          ]
        : []),
      ...(!sections.length
        ? [
            {
              id: 'paper:none',
              title: 'Project paper',
              body: { text: 'The project paper has no written sections yet.' },
              refs: [read],
            },
          ]
        : []),
    ],
  };
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
