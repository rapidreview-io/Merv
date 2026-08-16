import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useProjectStore } from '../store/useProjectStore';
import { useStreamAwarePoll } from '../store/useEventStream';
import { api } from '../api';
import MarkdownView from '../components/MarkdownView';
import EntityChip from '../components/EntityChip';
import { EntityRefScope } from '../components/EntityRefScope';
import { citedSections, paperSeed, sectionSeed, sourceLabel } from '../utils/litreview';

/**
 * The living literature review: one continuous document in the product's
 * spotlight frame — a compact masthead, a contents rail (sticky on wide
 * screens) that tracks where the reader is, the General Summary as unframed
 * prose, hairline-separated theme sections (each ending in its own reference
 * list), then the Papers ledger. Citation numbers are stable ledger positions;
 * every citation — the reference lists, and the `paper_…` chips the agents
 * write inline — jumps to its Papers entry and flashes it, and a paper's
 * section links jump back up. Agents write it through litreview.* tools;
 * this is the read.
 */
export default function LitReview() {
  const projectId = useProjectStore(s => s.projectId);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState(() => new Set());
  const [flash, setFlash] = useState(null);
  const [active, setActive] = useState(null);
  const etagRef = useRef(null);
  const flashTimer = useRef(null);

  const fetchReview = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api.getLitReviewIfChanged(projectId, etagRef.current);
      if (res?.notModified) { setError(null); return; }
      etagRef.current = res?.etag || null;
      setData(res?.data ?? res);
      setError(null);
    } catch (e) {
      setError(e?.message || 'Failed to load the literature review');
    }
  }, [projectId]);

  useStreamAwarePoll(fetchReview, {
    matches: (row) => String(row?.type || '').startsWith('litreview.'),
  });

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const sections = data?.sections || [];
  const papers = data?.papers || [];
  const papersById = useMemo(() => new Map(papers.map((p) => [p.id, p])), [papers]);
  // Ledger order (created_seq) is the stable citation number for the document.
  const numById = useMemo(() => new Map(papers.map((p, i) => [p.id, i + 1])), [papers]);
  const sectionsById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);

  // Which landmark the reader is in, for the contents rail. Keyed on the id
  // list (not the array identity) so a poll that returns the same document
  // does not tear the observer down and rebuild it.
  const navKey = sections.map((s) => s.id).join('|');
  const hasPapers = papers.length > 0;
  useEffect(() => {
    const ids = [
      'litreview-summary',
      ...(navKey ? navKey.split('|').map((id) => `lit-${id}`) : []),
      ...(hasPapers ? ['litreview-papers'] : []),
    ];
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (els.length < 2) { setActive(null); return undefined; }
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => seen.set(e.target.id, e.isIntersecting));
      const hit = els.find((el) => seen.get(el.id));
      // Nothing in the band (a section taller than it) keeps the last answer.
      setActive((prev) => (hit ? hit.id : prev));
    }, { rootMargin: '-72px 0px -62% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [navKey, hasPapers]);

  const toggle = (id) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allClosed = sections.length > 0 && sections.every((s) => closed.has(s.id));
  const toggleAll = () => setClosed(allClosed ? new Set() : new Set(sections.map((s) => s.id)));

  const jumpToPaper = useCallback((id) => {
    const el = document.getElementById(`paper-${id}`);
    if (el) {
      scrollToEl(el, 'center');
      // Keyboard users land on the entry itself, not back at the reference.
      el.focus({ preventScroll: true });
    }
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  const jumpToSection = useCallback((id) => {
    setClosed((prev) => { const next = new Set(prev); next.delete(id); return next; });
    requestAnimationFrame(() => {
      const el = document.getElementById(`lit-${id}`);
      if (!el) return;
      scrollToEl(el, 'start');
      document.getElementById(`lit-head-${id}`)?.focus({ preventScroll: true });
    });
  }, []);

  // The ids agents write inline in the prose (`paper_…`, `lit_…`) resolve
  // against the document already on screen: each chip shows its citation
  // number and title with no fetch, its hover card carries the ledger facts,
  // and clicking lands on the entry here instead of navigating to this page.
  const refScope = useMemo(() => ({
    resolve: (id) => {
      const p = papersById.get(id);
      if (p) {
        return paperSeed({
          paper: p, num: numById.get(id), sections: citedSections(p, sectionsById),
        });
      }
      const s = sectionsById.get(id);
      return s ? sectionSeed(s) : null;
    },
    activate: (id) => {
      const p = papersById.get(id);
      if (p) {
        return {
          onClick: () => jumpToPaper(id),
          label: `Reference ${numById.get(id)}, ${p.title || p.url} — go to its entry in the papers ledger`,
          hint: 'Click for its entry in the papers ledger',
        };
      }
      const s = sectionsById.get(id);
      if (!s) return null;
      return {
        onClick: () => jumpToSection(id),
        label: `Go to the section ${s.title}`,
        hint: 'Click to go to this section',
      };
    },
  }), [papersById, numById, sectionsById, jumpToPaper, jumpToSection]);

  // A deep link from another screen (`/litreview#paper-paper_…`) gets the same
  // landing an in-page citation gives — once, and only after the document the
  // target lives in has loaded.
  const { hash } = useLocation();
  const landedFor = useRef(null);
  useEffect(() => {
    if (!hash || landedFor.current === hash) return;
    if (hash.startsWith('#paper-') && papersById.has(hash.slice(7))) {
      landedFor.current = hash;
      jumpToPaper(hash.slice(7));
    } else if (hash.startsWith('#lit-') && sectionsById.has(hash.slice(5))) {
      landedFor.current = hash;
      jumpToSection(hash.slice(5));
    }
  }, [hash, papersById, sectionsById, jumpToPaper, jumpToSection]);

  const jumpTo = (id, focusId) => {
    const el = document.getElementById(id);
    if (!el) return;
    scrollToEl(el, 'start');
    document.getElementById(focusId)?.focus({ preventScroll: true });
  };
  const jumpToPapers = () => jumpTo('litreview-papers', 'litreview-papers-h');
  const jumpToSummary = () => jumpTo('litreview-summary', 'litreview-summary');

  // A transient poll failure never blanks last-good data — the error screen
  // only shows when there is nothing to render at all.
  if (!data) {
    return (
      <div className="page-stage litreview">
        <p className="muted litreview-empty" role="status">{error || 'Loading…'}</p>
      </div>
    );
  }

  const empty = !data.summary?.exists && sections.length === 0 && papers.length === 0;
  if (empty) {
    return (
      <div className="page-stage litreview">
        <p className="muted litreview-empty">
          No literature review yet. Agents build it as papers enter the
          project — citing a paper (litreview.cite) and making targeted
          section edits (litreview.edit).
        </p>
      </div>
    );
  }

  const railed = sections.length > 0;

  return (
    <div className="page-stage litreview">
      <article className="spotlight litreview-sheet" aria-labelledby="litreview-title">
        <header className="litreview-masthead">
          <p className="spotlight-eyebrow">Literature review</p>
          <h1 className="litreview-title" id="litreview-title">
            {data.summary?.title || 'General Summary'}
          </h1>
          <p className="litreview-meta">
            <span>{countLabel(sections.length, 'theme')}</span>
            <span aria-hidden="true">·</span>
            <span>{countLabel(papers.length, 'paper')}</span>
          </p>
          {error ? (
            <p className="litreview-stale" role="status">
              Couldn’t refresh — showing the last loaded version.
            </p>
          ) : null}
        </header>

        <EntityRefScope value={refScope}>
          <div className={'litreview-columns' + (railed ? ' litreview-columns--railed' : '')}>
            {railed && (
              <aside className="litreview-rail">
                <nav className="litreview-toc" aria-labelledby="litreview-toc-label">
                  <p className="spotlight-eyebrow" id="litreview-toc-label">Contents</p>
                  <div className="litreview-toc-body">
                    <button
                      type="button"
                      className="litreview-toc-item"
                      aria-current={active === 'litreview-summary' ? 'true' : undefined}
                      onClick={jumpToSummary}
                    >
                      <span className="litreview-toc-num" aria-hidden="true" />
                      <span className="litreview-toc-title">Summary</span>
                    </button>
                    <ol className="litreview-toc-list">
                      {sections.map((s, i) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            className="litreview-toc-item"
                            aria-current={active === `lit-${s.id}` ? 'true' : undefined}
                            onClick={() => jumpToSection(s.id)}
                          >
                            <span className="litreview-toc-num" aria-hidden="true">{i + 1}</span>
                            <span className="litreview-toc-title">{s.title}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                    {papers.length > 0 && (
                      <button
                        type="button"
                        className="litreview-toc-item"
                        aria-current={active === 'litreview-papers' ? 'true' : undefined}
                        onClick={jumpToPapers}
                      >
                        <span className="litreview-toc-num" aria-hidden="true" />
                        <span className="litreview-toc-title">Papers ledger</span>
                      </button>
                    )}
                  </div>
                </nav>
                {sections.length > 1 && (
                  <div className="litreview-rail-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-label={allClosed ? 'Expand all sections' : 'Collapse all sections'}
                      onClick={toggleAll}
                    >
                      {allClosed ? 'Expand all' : 'Collapse all'}
                    </button>
                  </div>
                )}
              </aside>
            )}

            <div className="litreview-doc">
              <section
                className="litreview-summary"
                id="litreview-summary"
                aria-labelledby="litreview-summary-h"
                tabIndex={-1}
              >
                <h2 className="litreview-sr" id="litreview-summary-h">General summary</h2>
                {data.summary?.exists === false ? (
                  <p className="muted">Not written yet.</p>
                ) : (
                  <>
                    {data.summary?.tldr ? <p className="litreview-lede">{data.summary.tldr}</p> : null}
                    {data.summary?.body ? <MarkdownView text={data.summary.body} /> : null}
                  </>
                )}
              </section>

              {sections.length > 0 && (
                <section className="litreview-zone litreview-themes" aria-labelledby="litreview-themes-h">
                  <h2 className="litreview-zone-title" id="litreview-themes-h">
                    Themes <span className="litreview-count">{sections.length}</span>
                  </h2>

                  {sections.map((s, i) => {
                    const isOpen = !closed.has(s.id);
                    const refs = (s.cited_papers || []).length;
                    return (
                      <section
                        key={s.id}
                        id={`lit-${s.id}`}
                        className={'litreview-section' + (isOpen ? '' : ' is-closed')}
                        aria-labelledby={`lit-head-${s.id}`}
                      >
                        <h3 className="litreview-section-h">
                          <button
                            type="button"
                            id={`lit-head-${s.id}`}
                            className="litreview-section-head"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? `lit-body-${s.id}` : undefined}
                            onClick={() => toggle(s.id)}
                          >
                            <span className="litreview-section-num" aria-hidden="true">{i + 1}</span>
                            <span className="litreview-section-title">{s.title}</span>
                            {refs > 0 && (
                              <span className="litreview-section-refs">{countLabel(refs, 'reference')}</span>
                            )}
                            <span className={'litreview-chevron' + (isOpen ? ' open' : '')} aria-hidden="true">›</span>
                          </button>
                        </h3>
                        <p className="litreview-tldr">{s.tldr}</p>
                        {isOpen && (
                          <div className="litreview-body" id={`lit-body-${s.id}`}>
                            {s.body ? <MarkdownView text={s.body} /> : <p className="muted">No body yet.</p>}
                            <SectionRefs
                              cited={s.cited_papers || []}
                              papersById={papersById}
                              numById={numById}
                              onJump={jumpToPaper}
                            />
                          </div>
                        )}
                      </section>
                    );
                  })}
                </section>
              )}

              {papers.length > 0 && (
                <section
                  id="litreview-papers"
                  className="litreview-zone litreview-papers"
                  aria-labelledby="litreview-papers-h"
                >
                  <div className="litreview-zone-head">
                    <h2 className="litreview-zone-title" id="litreview-papers-h" tabIndex={-1}>
                      Papers <span className="litreview-count">{papers.length}</span>
                    </h2>
                  </div>
                  <p className="litreview-zone-note">
                    Every paper the review cites, numbered in the order it entered the
                    project — the same number used by the references above.
                  </p>
                  <ol className="litreview-paper-list">
                    {papers.map((p) => (
                      <PaperEntry
                        key={p.id}
                        paper={p}
                        num={numById.get(p.id)}
                        sectionsById={sectionsById}
                        flash={flash === p.id}
                        onJumpToSection={jumpToSection}
                      />
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </div>
        </EntityRefScope>
      </article>
    </div>
  );
}

/** The structured reference list a section ends with; entries jump to Papers. */
function SectionRefs({ cited, papersById, numById, onJump }) {
  if (!cited.length) return null;
  return (
    <div className="litreview-refs">
      <div className="litreview-refs-label">
        References <span className="litreview-count">{cited.length}</span>
      </div>
      <ol>
        {cited.map((c) => {
          const p = papersById.get(c.id);
          const n = numById.get(c.id);
          const title = p?.title || c.title || c.url;
          return (
            <li key={c.id}>
              <button
                type="button"
                className="litreview-ref"
                aria-label={`Reference ${n}, ${title} — go to its entry in the papers ledger`}
                onClick={() => onJump(c.id)}
              >
                <span className="litreview-ref-num" aria-hidden="true">[{n}]</span>
                <span className="litreview-ref-title">{title}</span>
                <span className="litreview-ref-meta" aria-hidden="true">{shortAuthors(p)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// How long a jumped-to ledger entry stays lit (kept in step with the
// litreview-flash keyframes).
const FLASH_MS = 1700;

function countLabel(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function shortAuthors(p) {
  if (!p) return '';
  const first = (p.authors || [])[0];
  const name = first ? first.split(',')[0].trim() : '';
  const etAl = (p.authors || []).length > 1 ? ' et al.' : '';
  return [name && name + etAl, p.year].filter(Boolean).join(', ');
}

/** Smooth by default; a jump, not a glide, when the reader asked for less motion. */
function scrollToEl(el, block) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block });
}

const FLAG_LABEL = { manual: 'manual entry', failed: 'fetch failed' };

function PaperEntry({ paper: p, num, sectionsById, flash, onJumpToSection }) {
  const links = p.links || [];
  const sectionLinks = links.filter((l) => l.target_type === 'litreview_section');
  const entityLinks = links.filter((l) => l.target_type !== 'litreview_section');
  // The cite note repeats on every link it was recorded with — show it once.
  const notes = [...new Set(links.map((l) => (l.note || '').trim()).filter(Boolean))];
  const source = sourceLabel(p);
  // Authors / year / source read as one citation line, not as three chips.
  const byline = [(p.authors || []).join(' · '), p.year].filter(Boolean).join(' — ');

  return (
    <li id={`paper-${p.id}`} className={'litreview-paper' + (flash ? ' flash' : '')} tabIndex={-1}>
      <div className="litreview-paper-num">[{num}]</div>
      <div className="litreview-paper-main">
        <div className="litreview-paper-title-row">
          <a className="litreview-paper-title" href={p.url} target="_blank" rel="noreferrer">
            {p.title || p.url}
          </a>
          {p.fetch_status !== 'fetched' && (
            <span className="litreview-badge litreview-badge--flag">
              {FLAG_LABEL[p.fetch_status] || p.fetch_status}
            </span>
          )}
        </div>
        {(byline || source) ? (
          <div className="litreview-paper-meta">
            {byline}
            {byline && source ? <span aria-hidden="true"> · </span> : null}
            {source ? <span className="litreview-paper-source">{source}</span> : null}
          </div>
        ) : null}
        {notes.map((n) => <p key={n} className="litreview-paper-note">{n}</p>)}
        {sectionLinks.length > 0 && (
          <div className="litreview-paper-links">
            <span className="litreview-links-label">Cited in</span>
            {sectionLinks.map((l) => {
              const title = sectionsById.get(l.target_id)?.title || 'section';
              return (
                <button
                  key={l.target_id}
                  type="button"
                  className="litreview-section-link"
                  aria-label={`Go to the section ${title}`}
                  onClick={() => onJumpToSection(l.target_id)}
                >
                  <span aria-hidden="true">§ </span>{title}
                </button>
              );
            })}
          </div>
        )}
        {entityLinks.length > 0 && (
          <div className="litreview-paper-links">
            <span className="litreview-links-label">Linked</span>
            {entityLinks.map((l, i) => (
              <EntityChip key={`${l.target_id}-${i}`} id={l.target_id} compact />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
