/**
 * Nisa's answers, read defensively: only allowlisted fields leave, each paper named the way
 * paper.cite takes it, and every answer sized to what an agent is shown of one result.
 */
import { canonicalId } from './input.js';
import type { NisaPaper } from './types.js';

/** What Pi shows the model of one result, at most (packages/pi/src/fit.ts), less room for the
 * envelope a transport adds: a larger answer would reach the model cut, or as a bare index. */
export const MAX_ANSWER_BYTES = 28_000;
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const MAX_SNIPPET_CHARS = 800;
export const LIST_ABSTRACT_CHARS = 600;
export const MAX_ABSTRACT_CHARS = 10_000;
export const MAX_EXCERPT_CHARS = 2_000;
const LIST_AUTHORS = 12;
const PAPER_AUTHORS = 100;

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** At most `max` characters, never half of one, and an ellipsis when cut. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return '';
  const end = /[\uD800-\uDBFF]/.test(value[max - 1] ?? '') ? max - 1 : max;
  return `${value.slice(0, end)}…`;
}
/** Text as Nisa sent it, without control characters other than line breaks and tabs. */
export const text = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? clip(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(), max)
    : '';
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const score = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const year = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1000 && number <= 9999
    ? number
    : null;
};
/** Nisa's comma-separated authors (or a list), each at most 300 characters as paper.cite takes. */
function authors(value: unknown, max: number): { authors: string[]; more?: number } {
  const all = (
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((name) => typeof name === 'string')
        : []
  )
    .map((name) => text(name, 300))
    .filter(Boolean);
  return all.length > max
    ? { authors: all.slice(0, max), more: all.length - max }
    : { authors: all };
}
export const citation = (id: string) => ({
  identifier: `arxiv:${id}`,
  arxiv_id: id,
  url: `https://arxiv.org/abs/${id}`,
});

export type Kind = 'search' | 'semantic' | 'related' | 'paper';
/** One paper from any Nisa answer, or undefined when it names no arXiv paper. `chars` bounds each
 * snippet (at most 800) and the abstract (at most 600 in a list, 10,000 from nisa.paper). */
export function paper(value: unknown, kind: Kind, chars: number): NisaPaper | undefined {
  const entry = record(value);
  const id = typeof entry?.arxiv_id === 'string' ? canonicalId(entry.arxiv_id) : undefined;
  if (!entry || !id) return undefined;
  const named = authors(entry.authors, kind === 'paper' ? PAPER_AUTHORS : LIST_AUTHORS);
  const similarity = [entry.similarity, entry.similarity_score, entry.score].find(
    (candidate) => typeof candidate === 'number',
  );
  const categories =
    typeof entry.categories === 'string'
      ? entry.categories.split(/[\s,]+/).filter((category) => /^[A-Za-z.-]{1,40}$/.test(category))
      : [];
  const abstract =
    kind === 'search'
      ? undefined
      : text(
          entry.abstract,
          Math.min(chars, kind === 'paper' ? MAX_ABSTRACT_CHARS : LIST_ABSTRACT_CHARS),
        );
  return {
    ...citation(id),
    title: text(entry.title, kind === 'paper' ? 1000 : 300),
    authors: named.authors,
    ...(named.more !== undefined && { more_authors: named.more }),
    year: year(entry.year),
    citation_count: integer(entry.citation_count),
    score: kind === 'paper' ? null : score(kind === 'search' ? entry.score : similarity),
    snippets:
      kind === 'search' && Array.isArray(entry.snippets)
        ? entry.snippets
            .slice(0, 3)
            .map((snippet) => text(snippet, Math.min(chars, MAX_SNIPPET_CHARS)))
            .filter(Boolean)
        : [],
    ...(abstract !== undefined && { abstract }),
    ...(kind === 'paper' && { categories: categories.slice(0, 20) }),
  };
}

/** The papers of a list answer, at most `max`, one entry per paper. */
export function papers(value: unknown, kind: Kind, max: number, chars: number): NisaPaper[] {
  const seen = new Set<string>();
  const found: NisaPaper[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const item = paper(entry, kind, chars);
    if (!item || seen.has(item.arxiv_id)) continue;
    seen.add(item.arxiv_id);
    found.push(item);
    if (found.length === max) break;
  }
  return found;
}

/**
 * The fullest `make(chars)`, chars from `whole` down, that fits MAX_ANSWER_BYTES: the answer
 * shortens its passages before anything else. UTF-8 bytes of the JSON are what an agent is
 * shown, so text that escapes or takes several bytes a character shortens sooner.
 */
export function sized<T>(whole: number, make: (chars: number) => T): { value: T; chars: number } {
  const fits = (value: T) => jsonBytes(value) <= MAX_ANSWER_BYTES;
  const full = make(whole);
  if (fits(full)) return { value: full, chars: whole };
  let [low, high] = [0, whole - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(make(middle))) low = middle;
    else high = middle - 1;
  }
  return { value: make(low), chars: low };
}
