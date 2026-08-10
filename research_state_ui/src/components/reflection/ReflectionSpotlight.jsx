import { useState } from 'react';
import ArtifactContentView from '../ArtifactContentView';
import ReviewCard from '../ReviewCard';

/**
 * ReflectionSpotlight — the wave's documents in the exact report/plan
 * treatment an experiment gets: one spotlight section, compact header bar
 * (status + active file path + review/body toggles) above the rendered
 * markdown. The header's title is a TAB STRIP: the consolidated Reflection
 * first, then one tab per roster lens — the lens fan-in reads as chapters of
 * one document instead of a card grid. An uncovered lens keeps its tab
 * (dimmed) so the missing work is visible, not hidden.
 */

// Wave status → the plan-status vocabulary used on experiment docs.
function docStatus(status) {
  const s = String(status || '');
  if (s === 'published') return { word: 'published', cls: 'accepted' };
  if (s === 'reflection_review') return { word: 'under review', cls: 'under_review' };
  if (s === 'consolidating') return { word: 'consolidating', cls: 'under_review' };
  if (s === 'abandoned') return { word: 'abandoned', cls: 'drafting' };
  return { word: 'drafting', cls: 'drafting' };
}

export default function ReflectionSpotlight({
  projectId, wave, isOpen, roster, reflections, reflectionDoc, reviews,
}) {
  const [tab, setTab] = useState('reflection');
  const [showBody, setShowBody] = useState(true);
  const [showReview, setShowReview] = useState(false);

  const lenses = roster || [];
  const status = docStatus(wave?.status);
  const activeLens = tab === 'reflection' ? null : lenses.find(l => l.id === tab) || null;
  const activeRefl = activeLens ? reflections?.[activeLens.id] : null;
  const activeArtifact = activeLens
    ? (activeRefl?.artifactId ? { id: activeRefl.artifactId, path: activeRefl.path } : null)
    : (reflectionDoc ? { id: reflectionDoc.id, path: reflectionDoc.path } : null);

  const reviewAvailable = (reviews || []).length > 0;

  return (
    <section id="reflection-doc" className="spotlight">
      <header className="spotlight-head spotlight-head--row">
        <div className="spotlight-head-left">
          <span className="fig-title-tabs rfls-tabs" role="tablist" aria-label="Reflection documents">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'reflection'}
              className={`fig-title-tab${tab === 'reflection' ? ' fig-title-tab--on' : ''}`}
              onClick={() => setTab('reflection')}
            >
              Reflection
            </button>
            {lenses.map(l => {
              const covered = Boolean(reflections?.[l.id]?.covered && reflections?.[l.id]?.artifactId);
              return (
                <span key={l.id} className="rfls-tab-slot">
                  <span className="fig-title-tab-sep" aria-hidden="true">/</span>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === l.id}
                    className={[
                      'fig-title-tab',
                      tab === l.id ? 'fig-title-tab--on' : '',
                      covered ? '' : 'rfls-tab--pending',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setTab(l.id)}
                    title={covered ? l.charter : `${l.title || l.id} — reflection not submitted yet`}
                  >
                    {l.title || l.id}
                  </button>
                </span>
              );
            })}
          </span>
          <span className={`plan-status plan-status--${status.cls}`}>{status.word}</span>
        </div>
        <div className="spotlight-head-right">
          {activeArtifact?.path && (
            <span className="mono spotlight-bar-path" title={activeArtifact.path}>
              {activeArtifact.path}
            </span>
          )}
          {reviewAvailable && (
            <button type="button" className="btn btn--sm" onClick={() => setShowReview(v => !v)}>
              <span className="toggle-verb">{showReview ? 'Hide' : 'Show'}</span>{' review'}
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={() => setShowBody(v => !v)}>
            <span className="toggle-verb">{showBody ? 'Hide' : 'Show'}</span>{' doc'}
          </button>
        </div>
      </header>

      {showReview && reviewAvailable && (
        <div className="spotlight-review">
          {reviews.map(r => <ReviewCard key={r.id} review={r} />)}
        </div>
      )}

      {showBody && (
        <div className="spotlight-body">
          {activeLens && activeLens.charter && (
            <p className="rfls-charter">{activeLens.charter}</p>
          )}
          {activeArtifact ? (
            <ArtifactContentView
              key={activeArtifact.id}
              projectId={projectId}
              artifactId={activeArtifact.id}
              path={activeArtifact.path}
              stripTitle
            />
          ) : activeLens ? (
            <div className="empty">Reflection not submitted yet.</div>
          ) : (
            <div className="empty">
              {isOpen
                ? "The consolidated reflection isn't written yet."
                : 'This wave published no reflection document.'}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
