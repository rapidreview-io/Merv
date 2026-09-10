import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useProjectStore,
  useProjectHref,
  selectClaims,
  selectExperiments,
  selectEventsAll,
} from '../store/useProjectStore';
import { api } from '../api';
import { tallyOutcomes, claimStatusColor } from '../utils/evidence';
import { ConfidenceSignal } from '../components/ClaimEvidence';
import { computeClaimShifts } from '../utils/claimShifts';
import { relDays } from '../utils/time';
import { cx } from '../utils/format';

/**
 * The state-of-knowledge page: a claims board. Claims are shelved by what
 * the evidence says; each shelf is a masonry field of cards at natural
 * height — full statements, evidence in words, weight by standing
 * (established firmer/larger, frontier dashed/tentative, live pulsing).
 * The ledger dialect stays where records are dead or tabular: the shifts
 * changelog and the abandoned archive. Depth lives on ClaimDetail.
 */
const SHELVES = [
  { key: 'held', title: 'What held up' },
  { key: 'ruled', title: "What didn't" },
  { key: 'testing', title: 'Being tested' },
  { key: 'untested', title: 'Believed, untested' },
  { key: 'frontier', title: 'Frontier' },
];

function shelfOf(claim, linkedExperiments) {
  const status = (claim.status || 'active').toLowerCase();
  if (status === 'supported') return 'held';
  if (status === 'contradicted' || status === 'weakened') return 'ruled';
  if (status === 'abandoned') return 'archive';
  if (linkedExperiments.length > 0) return 'testing';
  return status === 'draft' ? 'frontier' : 'untested';
}

function lastEvidenceAt(experiments) {
  let latest = null;
  for (const e of experiments) {
    const at = e.updated_at || e.created_at;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

export default function Claims() {
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const claims = useProjectStore(selectClaims);
  const experiments = useProjectStore(selectExperiments);
  const events = useProjectStore(selectEventsAll);
  const [showForm, setShowForm] = useState(false);

  const experimentsByClaim = useMemo(() => {
    const map = new Map();
    for (const e of experiments) {
      const linked = Array.isArray(e.tested_claims) ? e.tested_claims : [];
      for (const tc of linked) {
        if (!tc?.id) continue;
        if (!map.has(tc.id)) map.set(tc.id, []);
        map.get(tc.id).push(e);
      }
    }
    return map;
  }, [experiments]);

  const shelves = useMemo(() => {
    const buckets = { held: [], ruled: [], testing: [], untested: [], frontier: [], archive: [] };
    for (const c of claims) {
      buckets[shelfOf(c, experimentsByClaim.get(c.id) || [])].push(c);
    }
    return buckets;
  }, [claims, experimentsByClaim]);

  const shifts = useMemo(() => computeClaimShifts(events).slice(0, 6), [events]);

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <h1 className="page-title">What we think</h1>
        <p className="page-summary">Durable statements about the domain, shelved by what the evidence says.</p>
      </header>

      {SHELVES.map(({ key, title }) => {
        const rows = shelves[key];
        if (key !== 'frontier' && rows.length === 0) return null;
        return (
          <section className="section section--shelf" key={key}>
            <div className="section-title">
              {title}
              <span className="shelf-count">{rows.length}</span>
            </div>
            <div className="clb">
              {rows.map(c => (
                <ClaimCard
                  key={c.id}
                  claim={c}
                  experiments={experimentsByClaim.get(c.id) || []}
                  shelf={key}
                />
              ))}
              {key === 'frontier' && !showForm && (
                <button className="clb-card clb-card--add" onClick={() => setShowForm(true)}>
                  ＋ New claim
                </button>
              )}
            </div>
            {key === 'frontier' && showForm && (
              <div style={{ marginTop: 14 }}>
                <NewClaimForm
                  projectId={projectId}
                  onCancel={() => setShowForm(false)}
                  onCreated={async () => { setShowForm(false); await refreshHome(); }}
                />
              </div>
            )}
          </section>
        );
      })}

      {shifts.length > 0 && (
        <section className="section section--shelf">
          <div className="section-title">Recent shifts</div>
          <ShiftsLedger shifts={shifts} />
        </section>
      )}

      {shelves.archive.length > 0 && (
        <details className="claim-archive">
          <summary>Abandoned · {shelves.archive.length}</summary>
          <ClaimsLedger rows={shelves.archive} experimentsByClaim={experimentsByClaim} />
        </details>
      )}
    </div>
  );
}

// One claim, one card. Standing sets the card's weight: established claims
// sit firmer and larger, frontier drafts render dashed and tentative, and a
// card with a running experiment carries the product's live dot.
function ClaimCard({ claim, experiments, shelf }) {
  const px = useProjectHref();
  const tally = tallyOutcomes(experiments);
  const evidenceAt = lastEvidenceAt(experiments);
  const cls = cx(
    'clb-card',
    shelf === 'held' ? 'clb-card--held' : '',
    shelf === 'frontier' || shelf === 'untested' ? 'clb-card--tentative' : '',
  );
  return (
    <Link to={px(`/claims/${claim.id}`)} className={cls}>
      <div className="clb-statement">{claim.statement}</div>
      <div className="clb-foot">
        <span className="clb-evidence">
          <EvidenceTally tally={tally} />
        </span>
        <span className="clb-meta">
          <ConfidenceSignal level={claim.confidence} />
          {evidenceAt && <span>{relDays(evidenceAt)}</span>}
        </span>
      </div>
    </Link>
  );
}

function ClaimsLedger({ rows, experimentsByClaim }) {
  return (
    <div className="clg">
      <div className="clg-row clg-row--head" aria-hidden="true">
        <span className="th th--led">claim</span>
        <span className="th th--led">evidence</span>
        <span className="th th--led">confidence</span>
        <span className="th th--led th--r">last tested</span>
      </div>
      {rows.map(c => (
        <ClaimRow key={c.id} claim={c} experiments={experimentsByClaim.get(c.id) || []} />
      ))}
    </div>
  );
}

function ClaimRow({ claim, experiments }) {
  const px = useProjectHref();
  const tally = tallyOutcomes(experiments);
  const evidenceAt = lastEvidenceAt(experiments);
  const mixed = tally.for > 0 && tally.against > 0;
  return (
    <Link
      to={px(`/claims/${claim.id}`)}
      className={`clg-row${mixed ? ' clg-row--mixed' : ''}`}
      title={claim.statement}
    >
      <span className="clg-claim">{claim.statement}</span>
      <span className="clg-evidence"><EvidenceTally tally={tally} /></span>
      <span className="clg-conf">
        <ConfidenceSignal level={claim.confidence} />
      </span>
      <span className="clg-when">{evidenceAt ? relDays(evidenceAt) : '—'}</span>
    </Link>
  );
}

// Evidence in words, colored by the product's fixed semantics — no glyphs
// to decode. Buckets render only when non-zero.
function EvidenceTally({ tally }) {
  const parts = [
    tally.for > 0 && <span key="f" className="ev-for">{tally.for} for</span>,
    tally.against > 0 && <span key="a" className="ev-against">{tally.against} against</span>,
    tally.unclear > 0 && <span key="u" className="ev-unclear">{tally.unclear} unclear</span>,
    tally.running > 0 && <span key="r" className="ev-running">{tally.running} running</span>,
  ].filter(Boolean);
  if (parts.length === 0) return <span className="ev-none">—</span>;
  return parts.flatMap((el, i) =>
    i === 0 ? [el] : [<span key={`s${i}`} className="ev-sep"> · </span>, el],
  );
}

function ShiftsLedger({ shifts }) {
  const px = useProjectHref();
  return (
    <div className="clg clg--shifts">
      <div className="clg-row clg-row--head" aria-hidden="true">
        <span className="th th--led">claim</span>
        <span className="th th--led">shift</span>
        <span className="th th--led th--r">when</span>
      </div>
      {shifts.map((s, i) => (
        <Link
          key={`${s.claimId}-${s.at}-${i}`}
          to={px(`/claims/${s.claimId}`)}
          className="clg-row"
          title={s.rationale || s.statement}
        >
          <span className="clg-claim">{s.statement}</span>
          <span className="clg-shift">
            {s.status ? (
              <>
                {s.status.from} → <b style={{ color: claimStatusColor(s.status.to) }}>{s.status.to}</b>
              </>
            ) : (
              <>confidence {s.confidence.from} → {s.confidence.to}</>
            )}
          </span>
          <span className="clg-when">{relDays(s.at)}</span>
        </Link>
      ))}
    </div>
  );
}

function NewClaimForm({ projectId, onCancel, onCreated }) {
  const [statement, setStatement] = useState('');
  const [scope, setScope] = useState('');
  const [confidence, setConfidence] = useState('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!statement.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createClaim(projectId, { statement: statement.trim(), scope: scope.trim(), confidence });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <div className="form-row">
        <label className="label">Statement</label>
        <textarea
          className="textarea"
          value={statement}
          onChange={e => setStatement(e.target.value)}
          placeholder="A length-threshold classifier improves accuracy on toy.csv."
          autoFocus
          required
        />
      </div>
      <div className="form-row">
        <label className="label">Scope</label>
        <input className="input" value={scope} onChange={e => setScope(e.target.value)} placeholder="toy.csv only" />
      </div>
      <div className="form-row">
        <label className="label">Confidence</label>
        <select className="select" value={confidence} onChange={e => setConfidence(e.target.value)}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={busy || !statement.trim()}>
          {busy ? 'Creating…' : 'Create claim'}
        </button>
      </div>
    </form>
  );
}
