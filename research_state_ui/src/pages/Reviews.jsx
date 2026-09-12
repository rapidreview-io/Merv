import { Link } from 'react-router-dom';
import { useProjectStore, selectExperiments, selectReflections, useProjectHref } from '../store/useProjectStore';
import { api } from '../api';
import { useAsyncData } from '../store/usePolling';
import ObjId from '../components/ObjId';
import StatusPill from '../components/StatusPill';
import ReviewCard from '../components/ReviewCard';
import { expName, reviewQueue, targetPath } from '../utils/experiment';
import { reviewKind } from '../utils/vocab';

/**
 * Reviews page. Shows:
 *   - the open review_requests queue (no submitted review yet)
 *   - submitted reviews history with verdict + findings
 *
 * Reviewer-agent composition is handled outside this UI (Codex spawns the
 * reviewer with a capability obtained from MCP). We display only.
 */
export default function Reviews() {
  const projectId = useProjectStore(s => s.projectId);
  const experiments = useProjectStore(selectExperiments);
  const px = useProjectHref();
  const [queue, error] = useAsyncData(() => api.listReviews(projectId), [projectId]);

  const reflections = useProjectStore(selectReflections);
  const expById = Object.fromEntries(experiments.map(e => [e.id, e]));
  const reflById = Object.fromEntries((reflections?.reflections || []).map(r => [r.id, r]));
  // A target's name: the experiment's, the reflection wave's, else its id.
  const targetName = (id) => expById[id] ? expName(expById[id]) : reflById[id]?.title || <ObjId id={id} accent />;

  if (error) return <div className="page-stage"><div className="error-message">{error}</div></div>;
  if (!queue) return <div className="page-stage"><div className="empty">Loading…</div></div>;

  const { openRequests, byTarget } = reviewQueue(queue);

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <h1 className="page-title">Reviews</h1>
      </header>

      <section className="section">
        <div className="section-title">Open requests</div>
        {openRequests.length === 0 ? (
          <div className="empty">No open review requests.</div>
        ) : (
          <div className="list card card--flush">
            {openRequests.map(req => {
              const exp = expById[req.target_id];
              const to = targetPath(req.target_type, req.target_id);
              return (
                <div key={req.id} className="list-row">
                  <div className="list-row-main">
                    <div className="list-row-title">
                      {reviewKind(req.role)} · {targetName(req.target_id)}
                    </div>
                    <div className="list-row-sub">
                      <ObjId id={req.id} />{exp?.intent && <> · {exp.intent}</>}{req.reason && <> · {req.reason}</>}
                    </div>
                  </div>
                  <div className="list-row-aside">
                    <StatusPill value={req.status || 'requested'} />
                    {to && <Link to={px(to)} className="btn btn--sm btn--ghost">Open →</Link>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-title">Submitted</div>
        {byTarget.size === 0 ? (
          <div className="empty">No reviews submitted yet.</div>
        ) : (
          <div className="stack stack--lg">
            {Array.from(byTarget.entries()).map(([id, reviews]) => {
              const exp = expById[id];
              const to = targetPath(reviews[0].target_type, id);
              return (
                <div key={id}>
                  <div className="cluster--between" style={{ marginBottom: 10 }}>
                    <div className="cluster">
                      <span style={{ fontWeight: 600 }}>{targetName(id)}</span>
                      {exp && <span style={{ fontSize: 'var(--text-base)' }}>{exp.intent}</span>}
                    </div>
                    {to && <Link to={px(to)} className="btn btn--sm btn--ghost">Open →</Link>}
                  </div>
                  <div className="stack stack--sm">
                    {reviews.map(r => <ReviewCard key={r.id || r.created_at} review={r} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
