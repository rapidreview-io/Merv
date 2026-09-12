import { Link } from 'react-router-dom';
import { agentPrompt, gateLabel } from '../utils/vocab';

/**
 * GateBanner — the server's `workflow` block for a live record, split by who
 * acts: the connected agent's move (one pasteable sentence) and yours (the
 * transitions the graph lets a person fire here). Transitions the workflow
 * marks blocked or applies itself are never rendered; the destructive pair
 * sits behind "More".
 *
 * Props:
 *   workflow:           { current_gate, next_action, state, ... }
 *   name:               the record's display name, used in the agent's move
 *   primaryAction:      { transition, label } | null
 *   secondaryActions:   Array<{transition, label}>  (abandon / mark failed)
 *   onAction:           (transition) => void
 *   actionsBusy:        Set<string>
 *   linkTo:             route/hash of the page section this gate is about
 */
export default function GateBanner({
  workflow, name = '', primaryAction = null, secondaryActions = [], onAction, actionsBusy = new Set(), linkTo = null,
}) {
  if (!workflow) return null;
  const { current_gate, next_action, state } = workflow;
  // `wait_` is the backend's "in motion, nothing needed from anyone".
  const isWaiting = /^wait[_-]/.test(next_action || '');
  const prompt = agentPrompt(next_action, { state, name });

  const titleInner = <>{isWaiting && <span className="gate-live-dot" aria-hidden="true" />}{gateLabel(current_gate, state)}</>;
  // A hash-only link means we're on the target page — scroll in place.
  const handleTitleClick = (e) => {
    if (typeof linkTo === 'string' && linkTo.startsWith('#')) {
      e.preventDefault();
      document.getElementById(linkTo.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  const button = (a, cls) => (
    <button key={a.transition} className={cls} disabled={actionsBusy.has(a.transition)} onClick={() => onAction(a.transition)}>
      {actionsBusy.has(a.transition) ? '…' : a.label}
    </button>
  );

  return (
    <div className={`gate-banner${isWaiting ? ' gate-banner--live' : ''}`}>
      <div className="gate-banner-body">
        {linkTo
          ? <Link to={linkTo} onClick={handleTitleClick} className="gate-banner-title gate-banner-title--link">{titleInner}</Link>
          : <div className="gate-banner-title">{titleInner}</div>}

        {prompt && (
          <div className="gate-banner-move">
            <span className="gate-banner-meta-key">Agent’s move</span>
            <code className="gate-banner-prompt">{prompt}</code>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigator.clipboard?.writeText(prompt)}>Copy</button>
          </div>
        )}

        {onAction && (primaryAction || secondaryActions.length > 0) && (
          <div className="gate-banner-move">
            <span className="gate-banner-meta-key">Your move</span>
            {primaryAction ? button(primaryAction, 'btn btn--primary') : <span className="muted">nothing until the agent moves</span>}
            {secondaryActions.length > 0 && (
              <details className="gate-banner-more">
                <summary className="btn btn--sm btn--ghost">More</summary>
                <div className="gate-banner-actions">{secondaryActions.map(a => button(a, 'btn btn--sm btn--ghost'))}</div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
