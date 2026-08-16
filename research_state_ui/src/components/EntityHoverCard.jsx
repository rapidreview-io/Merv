import StatusPill from './StatusPill';
import { TYPE_GLYPH, TYPE_LABEL } from '../utils/entityResolve';
import { authorLine } from '../utils/litreview';
import { fmtAgo } from '../utils/format';

function ago(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? fmtAgo(Date.now() - t) : null;
}

const CONF_N = { low: 1, medium: 2, high: 3 };

// Confidence dots reusing the claim visual language — but title-less (a native
// `title` here would pop a grey tooltip over the card); the row label + aria
// carry the meaning instead.
function ConfidenceDots({ level }) {
  const n = CONF_N[(level || '').toLowerCase()] || 0;
  return (
    <span className="claim-conf" aria-label={level ? `${level} confidence` : undefined}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`claim-conf-dot${i <= n ? ' is-on' : ''}`} aria-hidden="true" />
      ))}
    </span>
  );
}

// One label/value line — omitted entirely when the value is empty, so the card
// only shows facts it actually has (ledger dialect: one field per line).
function Row({ label, children }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div className="ehover-row">
      <span className="ehover-key">{label}</span>
      <span className="ehover-val">{children}</span>
    </div>
  );
}

function ExperimentBody({ d }) {
  return (
    <>
      {d.intent && <p className="ehover-lead">{d.intent}</p>}
      <Row label="status">{d.status && <StatusPill value={d.status} />}</Row>
      <Row label="review">{d.review && <StatusPill value={d.review} />}</Row>
      <Row label="metric">{d.metric}</Row>
      <Row label="updated">{ago(d.updated_at)}</Row>
    </>
  );
}

function ClaimBody({ d }) {
  return (
    <>
      {d.statement && <p className="ehover-lead ehover-clamp3">{d.statement}</p>}
      <Row label="status">{d.status && <StatusPill value={d.status} />}</Row>
      <Row label="confidence">{d.confidence && <ConfidenceDots level={d.confidence} />}</Row>
      <Row label="tests">{d.linked != null && `${d.linked} experiment${d.linked === 1 ? '' : 's'}`}</Row>
    </>
  );
}

function ArtifactBody({ d }) {
  return (
    <>
      {d.path && <p className="ehover-lead ehover-mono">{d.path}</p>}
      <Row label="role">{d.role}</Row>
      <Row label="updated">{ago(d.updated_at)}</Row>
    </>
  );
}

function ReviewBody({ d }) {
  return (
    <>
      <Row label="role">{d.role && d.role.replace(/_/g, ' ')}</Row>
      <Row label="verdict">{d.verdict && <StatusPill value={d.verdict} />}</Row>
      <Row label="submitted">{ago(d.submitted_at)}</Row>
    </>
  );
}

function ReflectionBody({ d }) {
  return (
    <>
      <Row label="wave">{d.status && <StatusPill value={d.status} />}</Row>
      <Row label="decision">{d.decision && d.decision.replace(/_/g, ' ')}</Row>
    </>
  );
}

const FLAG_LABEL = { manual: 'manual entry', failed: 'fetch failed' };

// Two section titles, then a count — a card lists where a paper is cited, it
// does not reproduce the ledger's back-links.
function citedLine(sections) {
  const s = sections || [];
  if (!s.length) return null;
  return s.length > 2 ? `${s.slice(0, 2).join(' · ')} +${s.length - 2}` : s.join(' · ');
}

// A cited paper: the ledger row, minus the link the entry itself carries. The
// abstract leads because it is what tells the reader whether to go read it.
function PaperBody({ d }) {
  return (
    <>
      {d.description && <p className="ehover-lead ehover-clamp3">{d.description}</p>}
      <Row label="authors">{authorLine(d.authors)}</Row>
      <Row label="year">{d.year}</Row>
      <Row label="source">{d.source}</Row>
      <Row label="cited in">{citedLine(d.sections)}</Row>
      <Row label="metadata">{d.flag ? (FLAG_LABEL[d.flag] || d.flag) : null}</Row>
    </>
  );
}

function SectionBody({ d }) {
  return (
    <>
      {d.tldr && <p className="ehover-lead ehover-clamp3">{d.tldr}</p>}
      <Row label="references">{d.refs ? `${d.refs} paper${d.refs === 1 ? '' : 's'}` : null}</Row>
    </>
  );
}

const BODY = {
  experiment: ExperimentBody,
  claim: ClaimBody,
  artifact: ArtifactBody,
  review: ReviewBody,
  reflection: ReflectionBody,
  paper: PaperBody,
  litreview_section: SectionBody,
};

/**
 * The floating detail card's inner content. The positioned wrapper (ref, style,
 * hover-bridge handlers) lives in EntityChip; this is purely what fills it.
 *
 * The name comes from `detail` when it has one: the chip's label is already
 * clipped to fit a line of prose, and the card exists to un-clip it. `hint`
 * (from an EntityRefScope) tells the reader what the click will do.
 */
export default function EntityHoverCard({ resolved, loading, hint }) {
  const { type, label, detail, notFound } = resolved;
  const Body = detail ? BODY[type] : null;
  const name = detail?.name || detail?.title || label;

  return (
    <div className="ehover-inner">
      <div className="ehover-head">
        <span className="ehover-glyph" aria-hidden="true">{TYPE_GLYPH[type] || '•'}</span>
        <span className="ehover-type">{TYPE_LABEL[type] || 'reference'}</span>
        {detail?.num ? <span className="ehover-num">[{detail.num}]</span> : null}
        {loading && <span className="ehover-load" aria-label="loading" />}
      </div>
      <div className="ehover-name">{name}</div>
      {Body && <Body d={detail} />}
      {!detail && !loading && notFound && (
        <div className="ehover-missing">
          <span className="ehover-mono">{resolved.id}</span>
          <span className="ehover-note">not found in this project</span>
        </div>
      )}
      {hint ? <div className="ehover-hint">{hint}</div> : null}
    </div>
  );
}
