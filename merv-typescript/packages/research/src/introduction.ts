import type { PaperRevision } from '@merv/paper/types';

/** Scope's limit for the project Introduction. */
const limit = 16_000;
const shortened = '\n\n[Shortened to fit the Introduction; paper.read returns the whole Problem.]';
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * The project Introduction, written from the accepted Problem: its four sections in paper order,
 * each under its own Markdown heading. The Problem is the one source of what the project is; the
 * Introduction is how every worker's assignment carries it. Too long a Problem is cut at a
 * character boundary and says so, since Scope stores at most 16,000 UTF-8 bytes.
 */
export function introductionFrom(problem: Pick<PaperRevision, 'sections'>): string {
  const text = problem.sections
    .filter((section) => ['problem', 'scope', 'goals', 'constraints'].includes(section.id))
    .map((section) => `## ${section.title}\n\n${section.content.trim()}`)
    .join('\n\n');
  if (bytes(text) <= limit) return text;
  let room = limit - bytes(shortened);
  let end = 0;
  for (const character of text) {
    room -= bytes(character);
    if (room < 0) break;
    end += character.length;
  }
  return text.slice(0, end).trimEnd() + shortened;
}
