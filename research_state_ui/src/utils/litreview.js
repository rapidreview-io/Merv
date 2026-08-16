/**
 * Paper + section presentation for the literature review: the one place that
 * turns a ledger row into the strings every surface shows — the ledger line,
 * the inline citation chip, and the hover card behind it.
 *
 * Pure and data-only, so the lit-review page (which already holds the whole
 * ledger) and entityResolve's lazy hover fetch (a `paper_…` id cited in a
 * report or a feed post) build exactly the same card from the same row.
 */

// Deep links: a chip on another screen lands on the entry itself, which the
// lit review then highlights — same landing as an in-page citation.
export const paperRoute = (id) => `/litreview#paper-${id}`;
export const sectionRoute = (id) => `/litreview#lit-${id}`;

const SOURCE_WORD = { arxiv: 'arXiv', doi: 'DOI' };

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** The source word alone — a ledger line's title already carries the link. */
export function sourceLabel(paper) {
  return SOURCE_WORD[paper?.source_kind] || hostOf(paper?.url);
}

/**
 * Source with its identifier (`arXiv:2304.07193`) — the citation key a reader
 * recognises, which the clipped chip has no room for. `norm_key` is the
 * canonical `arxiv:…` / `doi:…` form the brain dedupes on.
 */
export function sourceRef(paper) {
  const key = String(paper?.norm_key || '');
  if (paper?.source_kind === 'arxiv') {
    return key.startsWith('arxiv:') ? `arXiv:${key.slice(6)}` : 'arXiv';
  }
  if (paper?.source_kind === 'doi') {
    return key.startsWith('doi:') ? `DOI ${key.slice(4)}` : 'DOI';
  }
  return hostOf(paper?.url);
}

/** Up to `max` authors, then a +N tail — a card line, never an author wall. */
export function authorLine(authors, max = 3) {
  const names = (authors || []).map((a) => String(a || '').trim()).filter(Boolean);
  if (!names.length) return '';
  const head = names.slice(0, max).join(' · ');
  return names.length > max ? `${head} +${names.length - max}` : head;
}

/** Titles of the sections a paper is cited in, in document order. */
export function citedSections(paper, sectionsById) {
  return (paper?.links || [])
    .filter((l) => l.target_type === 'litreview_section')
    .map((l) => sectionsById?.get(l.target_id)?.title)
    .filter(Boolean);
}

/**
 * The resolved entity a `paper_…` chip renders from: the citation number as a
 * badge, the title as the name, and every fact the clipped chip drops — the
 * abstract, the byline, the source key, where it is cited — in `detail` for
 * the hover card.
 */
export function paperSeed({ paper, num = null, sections = [] }) {
  const title = (paper?.title || '').trim() || paper?.url || 'paper';
  const flag = paper?.fetch_status && paper.fetch_status !== 'fetched' ? paper.fetch_status : '';
  return {
    id: paper?.id,
    type: 'paper',
    label: title,
    badge: num ? `[${num}]` : null,
    route: paperRoute(paper?.id),
    navigable: true,
    detail: {
      type: 'paper',
      num: num || null,
      title,
      description: paper?.description || '',
      authors: paper?.authors || [],
      year: paper?.year || '',
      source: sourceRef(paper),
      sections,
      flag,
    },
  };
}

/** The resolved entity a `lit_…` (section) chip renders from. */
export function sectionSeed(section) {
  return {
    id: section?.id,
    type: 'litreview_section',
    label: (section?.title || '').trim() || 'lit review section',
    route: sectionRoute(section?.id),
    navigable: true,
    detail: {
      type: 'litreview_section',
      title: section?.title || '',
      tldr: section?.tldr || '',
      refs: (section?.cited_papers || []).length,
    },
  };
}
