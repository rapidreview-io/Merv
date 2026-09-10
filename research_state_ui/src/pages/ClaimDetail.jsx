import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsyncData } from '../store/usePolling';
import { useProjectStore, selectExperiments, selectEventsAll, useProjectHref } from '../store/useProjectStore';
import ObjId from '../components/ObjId';
import StatusPill from '../components/StatusPill';
import { ConfidenceSignal } from '../components/ClaimEvidence';
import { classifyExperiment, outcomeColor, outcomeLabel, outcomeGlyph, claimStatusColor } from '../utils/evidence';
import { expName } from '../utils/experiment';
import { computeClaimShifts } from '../utils/claimShifts';
import { relDays } from '../utils/time';
import { fmtStamp } from '../utils/format';

export default function ClaimDetail() {
  const { claimId } = useParams();
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const experiments = useProjectStore(selectExperiments);
  const events = useProjectStore(selectEventsAll);
  const [claim, error] = useAsyncData(() => api.getClaim(projectId, claimId), [projectId, claimId]);

  const linkedExperiments = experiments.filter(e =>
    Array.isArray(e.tested_claims) && e.tested_claims.some(c => c.id === claimId),
  );

  const shifts = useMemo(
    () => computeClaimShifts(events).filter(s => s.claimId === claimId),
    [events, claimId],
  );

  if (error) {
    return (
      <div className="page-stage">
        <div className="error-message">{error}</div>
        <Link className="btn" to={px('/claims')} style={{ marginTop: 12 }}>← Claims</Link>
      </div>
    );
  }
  if (!claim) {
    return <div className="page-stage"><div className="empty">Loading…</div></div>;
  }

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <div className="page-eyebrow">
          <Link to={px('/claims')}>Claims</Link> · <ObjId id={claim.id} className="page-eyebrow-id" />
        </div>
        <h1 className="page-title page-title--statement">{claim.statement}</h1>
        <div className="claim-entry-meta">
          <StatusPill value={claim.status} />
          <ConfidenceSignal level={claim.confidence} />
          {claim.scope && <span className="claim-entry-scope">scoped to {claim.scope}</span>}
          {claim.created_at && <span>created {fmtStamp(Date.parse(claim.created_at))}</span>}
        </div>
      </header>

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-title">Evidence</div>
        {linkedExperiments.length === 0 ? (
          <div className="empty">No experiments link to this claim yet.</div>
        ) : (
          <EvidenceHistory experiments={linkedExperiments} />
        )}
      </section>

      {shifts.length > 0 && (
        <section className="section">
          <div className="section-title">Belief history</div>
          <div className="shift-list">
            {shifts.map((s, i) => (
              <div className="shift-row" key={`${s.at}-${i}`}>
                <div className="shift-line">
                  <span className="shift-change">
                    {s.status ? (
                      <>
                        {s.status.from} → <b style={{ color: claimStatusColor(s.status.to) }}>{s.status.to}</b>
                      </>
                    ) : (
                      <>confidence {s.confidence.from} → {s.confidence.to}</>
                    )}
                  </span>
                  <span className="shift-time">{relDays(s.at)}</span>
                </div>
                {s.rationale && <div className="shift-rationale">{s.rationale}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// Chronological evidence rows: the tested-by list plus what each test cost
// (attempts) and concluded — the "why" behind the claim's current status.
function EvidenceHistory({ experiments }) {
  const px = useProjectHref();
  const ordered = experiments
    .slice()
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  return (
    <ul className="claim-entry-tests">
      {ordered.map(e => {
        const outcome = classifyExperiment(e);
        const attempts = e.attempt_index || 1;
        const started = e.created_at
          ? new Date(e.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })
          : null;
        const conclusion = (e.conclusion || '').trim().split('\n')[0];
        return (
          <li key={e.id} className="ev-row">
            <Link to={px(`/experiments/${e.id}`)} className="claim-exp-line">
              <span className="claim-exp-mark" style={{ color: outcomeColor(outcome) }} aria-hidden="true">
                {outcomeGlyph(outcome)}
              </span>
              <span className="claim-exp-title">{expName(e)}</span>
              <span className="claim-exp-status">{outcomeLabel(outcome)}</span>
            </Link>
            <div className="ev-row-sub">
              {started && <span>{started}</span>}
              {attempts > 1 && <span>· {attempts} attempts</span>}
            </div>
            {conclusion && <p className="ev-row-why">{conclusion}</p>}
          </li>
        );
      })}
    </ul>
  );
}
