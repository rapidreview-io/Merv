import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { request } from '../../api';
import { useProjectHref } from '../../store/useProjectStore';
import DetailPanelShell, { PanelResizer } from '../DetailPanelShell';
import GraphDrawer from '../GraphDrawer';
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

export default function ProblemTreePanel({ projectId }) {
  const px = useProjectHref();
  const navigate = useNavigate();
  // Identity discipline: keep the raw JSON string and only replace it when
  // the payload really changed, so a quiet poll tick re-renders nothing.
  const [json, setJson] = useState(null);
  const [selId, setSelId] = useState(null);

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

  // Escape clears the selection — the same one-layer peel the graphs do.
  useEffect(() => {
    if (!sel) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

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
              </DetailPanelShell>
            )}
          </GraphDrawer>
        </div>
      ) : (
        <div className="empty-state empty-state--compact">
          <p>No problem tree yet.</p>
        </div>
      )}
    </section>
  );
}
