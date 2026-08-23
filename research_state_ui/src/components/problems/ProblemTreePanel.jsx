import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { request } from '../../api';
import { useProjectHref } from '../../store/useProjectStore';
import { fmtAgo } from '../../utils/format';
import DetailPanelShell, { PanelResizer } from '../DetailPanelShell';
import GraphDrawer from '../GraphDrawer';
import GraphExpandButton from '../GraphExpandButton';
import MarkdownView from '../MarkdownView';
import { buildProblemTree } from './problemTreeModel.js';
import ProblemTreeFlow from './ProblemTreeFlow.jsx';

/**
 * ProblemTreePanel — Home's living problem tree for workflow_mode:
 * "problem_tree" projects. Fetches /problem-tree on a 5s cadence (the tree is
 * the project's heartbeat — it should feel alive), renders the section title
 * with the status counts, the tree, one compact legend row, and a selection
 * detail panel below the canvas. Clicking an attempt mark or an attempts-list
 * row deep-links to the experiment/task page.
 */

const POLL_MS = 5000;
// Canonical order for the title-row counts and nothing else.
const COUNT_ORDER = ['open', 'solved', 'stuck', 'failed', 'moot', 'decomposed'];

const statusWord = (s) => String(s || '').replace(/_/g, ' ');

// Revisit verdicts that own a .ptree-status--* recipe; anything else wears
// the neutral base chip (same closed-vocabulary discipline as problemStatus).
const VERDICT_CHIPS = new Set(['solved', 'failed', 'stuck', 'next', 'continue', 'moot']);
const verdictChipClass = (v) =>
  `ptree-status${VERDICT_CHIPS.has(v) ? ` ptree-status--${v}` : ''}`;

// "Aug 23" — the WaveFlowPanel day format, year only when it isn't this year.
function fmtDay(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  } catch { return null; }
}

// "Aug 23 · 2d ago" — an absolute day the reader can place, and the distance.
function dayAgo(iso) {
  const day = fmtDay(iso);
  if (!day) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${day} · ${fmtAgo(Date.now() - t)}` : day;
}

// The details document self-titles itself ("# Root problem"); the sidebar
// already labels the section, so the H1 would just be a redundant header
// before the real content. Same move the reflection doc makes.
function stripLeadingH1(md) {
  if (!md) return md;
  const m = md.match(/^\s*#\s+.+?\s*#*\s*(?:\r?\n|$)/);
  return m ? md.slice(m[0].length).replace(/^\s+/, '') : md;
}

// The rendered details document — the shared markdown pipeline, re-pitched by
// .ptree-doc-body CSS so ## sections read as the sidebar's eyebrow grammar.
function ProblemDoc({ md }) {
  return (
    <div className="ptree-doc-body">
      <MarkdownView text={stripLeadingH1(md)} />
    </div>
  );
}

// One journal entry: kind + verdict chip + when on a line, why beneath, then
// the quieter record (summary, mooted/spawned counts) when present.
function RevisitRow({ r }) {
  return (
    <div className="ptree-rev">
      <div className="ptree-rev-head">
        <span className="ptree-rev-kind">{r.kind}</span>
        {r.verdict && (
          <span className={verdictChipClass(r.verdict)}>{statusWord(r.verdict)}</span>
        )}
        <span className="ptree-rev-when">{dayAgo(r.at)}</span>
      </div>
      {r.why && <p className="ptree-rev-why">{r.why}</p>}
      {r.summary && <p className="ptree-rev-summary">{r.summary}</p>}
      {(r.mootedCount > 0 || r.spawnedCount > 0) && (
        <div className="ptree-rev-counts">
          {r.mootedCount > 0 && (
            <span>{`mooted ${r.mootedCount} ${r.mootedCount === 1 ? 'subtree' : 'subtrees'}`}</span>
          )}
          {r.spawnedCount > 0 && <span>{`spawned ${r.spawnedCount}`}</span>}
        </div>
      )}
    </div>
  );
}

export default function ProblemTreePanel({ projectId }) {
  const px = useProjectHref();
  const navigate = useNavigate();
  // Identity discipline: keep the raw JSON string and only replace it when
  // the payload really changed, so a quiet poll tick re-renders nothing.
  const [json, setJson] = useState(null);
  const [selId, setSelId] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setJson(null);
    setSelId(null);
    const load = async () => {
      try {
        const data = await request(`/api/projects/${encodeURIComponent(projectId)}/problem-tree`);
        if (cancelled) return;
        const next = JSON.stringify(data);
        setJson(prev => (prev === next ? prev : next));
      } catch {
        // Keep the last picture; the next tick retries.
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectId]);

  const data = useMemo(() => (json ? JSON.parse(json) : null), [json]);
  const model = useMemo(
    () => buildProblemTree(data?.exists ? data.root : null),
    [data],
  );
  const sel = useMemo(
    () => (selId ? model.nodes.find(n => n.id === selId) || null : null),
    [model, selId],
  );

  // Escape peels one layer at a time: drawer first, then fullscreen — the
  // same order every graph honors.
  useEffect(() => {
    if (!sel && !expanded) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (sel) setSelId(null);
      else setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, expanded]);
  // Fullscreen: lock page scroll while expanded.
  useEffect(() => {
    if (!expanded) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [expanded]);

  const attemptHref = useCallback(
    (a) => px(a.kind === 'task' ? `/tasks/${a.id}` : `/experiments/${a.id}`),
    [px],
  );
  const openAttempt = useCallback(
    (a) => navigate(attemptHref(a)),
    [navigate, attemptHref],
  );

  // No flash-of-nothing discipline: render nothing until the first payload.
  if (!data) return null;

  const counts = data.counts || {};
  const attempting = counts.attempting || 0;
  const restCounts = COUNT_ORDER
    .filter(k => counts[k] > 0)
    .map(k => `${counts[k]} ${k}`)
    .join(' · ');

  return (
    <section className="section" id="problem-tree">
      {expanded && (
        <div
          className="fig-backdrop"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        />
      )}
      {/* Title row and canvas share one slot, and the SLOT goes fullscreen —
          the header rides along so Collapse and the legend stay reachable. */}
      <div className={`ptree-slot${expanded ? ' ptree-slot--expanded' : ''}`}>
      <div className="ptree-titlerow">
        <div className="section-title">
          Problem tree
          {attempting > 0 && (
            <span className="section-title-badge">
              <span className="sidebar-live-dot" />
              {attempting} attempting
            </span>
          )}
          {restCounts && <span className="ptree-title-hint">{restCounts}</span>}
        </div>
        <div className="fig-head-right">
        <div className="ptree-legend" aria-hidden="true">
          <span className="fig-chip fig-st--open">open</span>
          <span className="fig-chip ptree-chip--attempting">
            <span className="ptree-chip-dot" />
            attempting
          </span>
          <span className="fig-chip fig-st--done">solved</span>
          <span className="fig-chip fig-st--revise">stuck</span>
          <span className="fig-chip fig-st--failed">failed</span>
          <span className="fig-chip ptree-chip--moot">moot</span>
          <span className="fig-chip ptree-chip--marks">
            <svg viewBox="0 0 22 12" width="18" height="10" focusable="false">
              <rect className="ptree-swatch-exp" x="1" y="1" width="20" height="10" rx="2.5" />
            </svg>
            experiment
          </span>
          <span className="fig-chip fig-chip--task">
            <svg className="fig-task-swatch" viewBox="0 0 22 12" width="18" height="10" focusable="false">
              <polygon points="4.5,0.75 17.5,0.75 21.25,6 17.5,11.25 4.5,11.25 0.75,6" />
            </svg>
            task
          </span>
        </div>
        <GraphExpandButton
          expanded={expanded}
          onToggle={() => setExpanded(v => !v)}
          label="problem tree"
        />
        </div>
      </div>

      {data.exists && model.nodes.length ? (
        <div className="ptree-stage">
          <ProblemTreeFlow
            model={model}
            selectedId={selId}
            onSelect={setSelId}
            onOpenAttempt={openAttempt}
          />
          {sel && <PanelResizer />}
          {/* The shared drawer every graph sidebar rides — problem details
              dock over the canvas's right edge, same as the braid's. */}
          <GraphDrawer open={!!sel}>
            {sel && (
              <DetailPanelShell
                typeLabel={sel.isRoot ? 'root problem' : 'problem'}
                title={sel.statement}
                status={(
                  <span className={`ptree-status ptree-status--${sel.status}`}>
                    {statusWord(sel.status)}
                  </span>
                )}
                onClose={() => setSelId(null)}
              >
                {(sel.isRoot || sel.revisitCount > 0) && (
                  <div className="ptree-side-meta">
                    {sel.isRoot && <span className="ptree-detail-tag">charter</span>}
                    {sel.revisitCount > 0 && (
                      <span className="ptree-detail-tag">
                        revisited ×{sel.revisitCount}
                      </span>
                    )}
                  </div>
                )}
                {sel.summary && (
                  <p className="ptree-detail-summary">{sel.summary}</p>
                )}
                {sel.attempts.length > 0 && (
                  <div className="ptree-detail-attempts">
                    <div className="ptree-detail-label">Attempts</div>
                    {sel.attempts.map(a => (
                      <Link key={a.id} className="ptree-att-row" to={attemptHref(a)}>
                        <span className="ptree-att-glyph" aria-hidden="true">
                          {a.kind === 'task' ? '◇' : '◈'}
                        </span>
                        <span className="ptree-att-name">{a.name}</span>
                        <span className={`ptree-att-status ptree-att-status--${a.tone}`}>
                          {statusWord(a.status)}
                          {a.verdict ? ` · ${a.verdict}` : ''}
                        </span>
                        <span className="ptree-att-arrow" aria-hidden="true">→</span>
                      </Link>
                    ))}
                  </div>
                )}
                {/* The details document. The root's is the charter — the
                    project's contract — so it renders open, the star of the
                    panel; a child's is a quiet collapsed disclosure. */}
                {sel.details && sel.isRoot && (
                  <div className="ptree-doc">
                    <div className="ptree-detail-label ptree-doc-label">
                      Charter
                      <span className="ptree-doc-version">{`details v${sel.detailsVersion}`}</span>
                    </div>
                    <ProblemDoc md={sel.details} />
                    {Array.isArray(data.details_history) && data.details_history.length > 0 && (
                      <details className="ptree-disclosure ptree-history">
                        <summary>
                          <span className="ptree-detail-label">History</span>
                        </summary>
                        <div className="ptree-disclosure-body">
                          {[...data.details_history].reverse().map(h => (
                            <details key={h.version} className="ptree-disclosure ptree-hist">
                              <summary>
                                <span className="ptree-hist-line">
                                  {`v${h.version} · superseded ${fmtDay(h.superseded_at) || ''}`}
                                </span>
                              </summary>
                              <ProblemDoc md={h.details} />
                            </details>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
                {sel.details && !sel.isRoot && (
                  <details className="ptree-disclosure ptree-doc">
                    <summary>
                      <span className="ptree-detail-label">Details</span>
                    </summary>
                    <ProblemDoc md={sel.details} />
                  </details>
                )}
                {/* The decision journal — newest first, the way a reader asks
                    "what happened here last?". */}
                {sel.revisits.length > 0 && (
                  <div className="ptree-revisits">
                    <div className="ptree-detail-label">Revisits</div>
                    {[...sel.revisits].reverse().map(r => (
                      <RevisitRow key={r.id} r={r} />
                    ))}
                  </div>
                )}
              </DetailPanelShell>
            )}
          </GraphDrawer>
        </div>
      ) : (
        <div className="empty-state empty-state--compact">
          <p>No problem tree yet.</p>
        </div>
      )}
      </div>
    </section>
  );
}
