import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { experimentFigure } from '../utils/experimentFigure';
import { TERMINAL_STATUSES } from '../utils/experiment';
import GraphOutline from './GraphOutline';
import { normalizeFigure, normalizeLogic, makeFigureDetail, makeLogicDetail } from './graphModel';

const GraphCanvasOverlay = lazy(() => import('./GraphCanvasOverlay'));

/**
 * MobileGraphSection — the experiment's figure ⇄ logic graph on mobile.
 * The figure is derived from the experiment state the screen already polls
 * (see utils/experimentFigure); the agent-authored logic graph and the open
 * review requests the figure's gate card needs are fetched here (single fetch
 * on terminal experiments, slow poll while live). Renders the available one as
 * a GraphOutline with a Figure/Story toggle, and offers "view as graph" → a
 * lazy fullscreen ReactFlow overlay.
 */
export default function MobileGraphSection({ projectId, experimentId, experiment, sandboxes }) {
  const [reviews, setReviews] = useState(null);
  const [logic, setLogic] = useState(null);
  const [chosen, setChosen] = useState('figure');
  const [showCanvas, setShowCanvas] = useState(false);

  const fetchBoth = useCallback(async () => {
    const [rv, lg] = await Promise.allSettled([
      api.listReviews(projectId, { target_type: 'experiment', target_id: experimentId }),
      api.getExperimentLogicGraph(projectId, experimentId),
    ]);
    if (rv.status === 'fulfilled') setReviews(rv.value);
    if (lg.status === 'fulfilled') setLogic(lg.value);
  }, [projectId, experimentId]);

  useEffect(() => {
    fetchBoth();
    if (TERMINAL_STATUSES.includes(experiment?.status)) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fetchBoth();
    }, 5000);
    return () => clearInterval(t);
  }, [fetchBoth, experiment?.status, experiment?.attempt_index]);

  const figure = useMemo(
    () => experimentFigure({ experiment, reviews, sandboxes }),
    [experiment, reviews, sandboxes],
  );
  const figModel = useMemo(() => normalizeFigure(figure), [figure]);
  const logicGraph = logic?.available ? logic.graph : null;
  const logicModel = useMemo(() => normalizeLogic(logicGraph), [logicGraph]);

  const figAvail = figModel.nodes.length >= 2;
  const logicAvail = logicModel.nodes.length >= 1;

  // Honor the toggle, fall back to whichever view is available.
  const view = (chosen === 'figure' && figAvail) || (chosen === 'logic' && logicAvail)
    ? chosen
    : (figAvail ? 'figure' : (logicAvail ? 'logic' : null));

  const model = view === 'logic' ? logicModel : figModel;
  const renderDetail = view === 'logic'
    ? makeLogicDetail(logic?.ref_index || {})
    : makeFigureDetail();

  // Controls exist only when there is a choice to make: the Figure/Story
  // toggle needs both views, the expand button needs content.
  const showToggle = figAvail && logicAvail;
  const showExpand = view && model.nodes.length > 0;

  return (
    <section className="section">
      {(showToggle || showExpand) && (
        <div className="cluster--between" style={{ marginBottom: 10 }}>
          {showToggle ? (
            <div className="mseg mseg--inline" role="tablist" aria-label="Graph view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'figure'}
                className={`mseg-btn${view === 'figure' ? ' active' : ''}`}
                onClick={() => setChosen('figure')}
              >
                Figure
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'logic'}
                className={`mseg-btn${view === 'logic' ? ' active' : ''}`}
                onClick={() => setChosen('logic')}
              >
                Story
              </button>
            </div>
          ) : <span />}
          {showExpand && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowCanvas(true)}>
              expand ⤢
            </button>
          )}
        </div>
      )}

      {!view ? (
        <div className="empty-state empty-state--compact">
          <p>No graph yet.</p>
        </div>
      ) : (
        <GraphOutline nodes={model.nodes} edges={model.edges} renderDetail={renderDetail} />
      )}

      {showCanvas && view && (
        <Suspense fallback={<div className="gcanvas-overlay gcanvas-overlay--loading">Loading graph…</div>}>
          <GraphCanvasOverlay
            title={view === 'logic' ? (logicGraph?.title || 'Story graph') : 'Figure'}
            nodes={model.nodes}
            edges={model.edges}
            onClose={() => setShowCanvas(false)}
          />
        </Suspense>
      )}
    </section>
  );
}
