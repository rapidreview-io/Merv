import { Link } from 'react-router-dom';
import { useProjectHref } from '../store/useProjectStore';

const REF_ICON = { exp: '⧉', paper: '¶', claim: '✦', res: '▣', sbx: '▣' };
// Object panels: header word + tone per satellite type.
const OBJ_WORD = { paper: 'paper', claim: 'claim', sbx: 'sandbox' };
const OBJ_TONE = { paper: 'supports', claim: 'qualifies', sbx: 'sbx' };

function lookupObject(objects, type, id) {
  if (type === 'paper') return objects.papers?.[id];
  if (type === 'claim') return objects.claims?.[id];
  return objects.sandboxes?.[id];
}

// Experiments that cite this object — via refs, satellites, or sandbox usage.
function referencedBy(cards, type, id) {
  const types = type === 'sbx' ? ['sbx', 'art'] : [type];
  return cards.filter((c) => (
    (type === 'sbx' && (c.sbxIds || []).includes(id))
    || (c.refs || []).some((r) => types.includes(r.type) && r.id === id)
    || (c.sats || []).some((s) => types.includes(s.type) && s.id === id)
  ));
}

/**
 * One reference row. A div with button semantics rather than <button> so the
 * paper rows can nest a real external link without invalid markup. The row is
 * its own affordance — a hover chevron stands in for the old "go →" label, and
 * a sub line that only repeats the label is dropped rather than shown twice.
 */
function RefRow({ icon, iconClass, label, sub, href, onOpen }) {
  const line = sub && sub !== label ? sub : null;
  return (
    <div
      className={`xmap-ref${onOpen ? '' : ' xmap-ref--static'}`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(); } }}
    >
      <span className={`xmap-ref-ic ${iconClass}`} aria-hidden="true">{icon}</span>
      <span className="xmap-ref-main">
        <span className="xmap-ref-label">{label}</span>
        {line ? <span className="xmap-ref-sub">{line}</span> : null}
      </span>
      {href ? (
        <a
          className="xmap-ref-ext"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${label} — open source`}
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      ) : null}
      {onOpen ? <span className="xmap-ref-go" aria-hidden="true">→</span> : null}
    </div>
  );
}

function ExpRow({ card, onTransport }) {
  return (
    <RefRow
      icon="⧉"
      iconClass="xmap-ic--exp"
      label={card.id}
      sub={card.title}
      onOpen={() => onTransport(card.id)}
    />
  );
}

// label · value rows — one grammar for both metrics and review gates.
function LeaderRow({ label, value, tone }) {
  return (
    <div className="xmap-leader-row">
      <span className="xmap-leader-label">{label}</span>
      <span className="xmap-leader-fill" />
      <span className={tone ? `xmap-tone--${tone}` : 'xmap-leader-value'}>{value}</span>
    </div>
  );
}

function PanelShell({ id, tone, word, pulse, onClose, children }) {
  return (
    <div className="xmap-panel">
      <div className="xmap-panel-head">
        {id ? <span className="xmap-panel-id">{id}</span> : null}
        <span className={`xmap-panel-status xmap-tone--${tone}`}>
          <span className={`xmap-dot${pulse ? ' xmap-dot--pulse' : ''}`} />
          {word}
        </span>
        <button type="button" className="xmap-panel-close" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="xmap-panel-body">{children}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="xmap-section">
      <div className="xmap-eyebrow">{title}</div>
      {children}
    </div>
  );
}

function ExperimentPanel({ card, cards, objects, citedBy, onClose, onTransport, onSelectObject }) {
  const px = useProjectHref();
  const cited = (citedBy[card.id] || [])
    .map((id) => cards.find((c) => c.id === id))
    .filter(Boolean);
  const meta = [
    card.artifacts != null ? `${card.artifacts} artifacts` : null,
    card.agent || null,
    card.computeStr || null,
    // Count, not uids — prod uids are 32-hex; the sandbox panel shows the full id.
    card.sbxIds?.length ? `${card.sbxIds.length} sandbox${card.sbxIds.length === 1 ? '' : 'es'}` : null,
  ].filter(Boolean);

  return (
    <PanelShell
      id={card.id}
      tone={card.status}
      word={card.status}
      pulse={card.status === 'running'}
      onClose={onClose}
    >
      <div>
        <div className="xmap-panel-title">{card.title}</div>
        {card.tldr ? <div className="xmap-panel-text">{card.tldr}</div> : null}
        <Link className="btn graph-open" to={px(`/experiments/${card.id}`)}>
          Open experiment <span aria-hidden="true">→</span>
        </Link>
      </div>
      {(card.metrics || []).length > 0 && (
        <Section title="Result">
          <div className="xmap-leader-rows">
            {card.metrics.map((m, i) => (
              <LeaderRow key={`${m.label}:${i}`} label={m.label} value={m.value} />
            ))}
          </div>
        </Section>
      )}
      {(card.gates || []).length > 0 && (
        <Section title="Gates">
          <div className="xmap-leader-rows">
            {card.gates.map((g, i) => (
              <LeaderRow key={`${g.label}:${i}`} label={g.label} value={g.result} tone={g.tone} />
            ))}
          </div>
        </Section>
      )}
      {(card.refs || []).length > 0 && (
        <Section title="References">
          <div className="xmap-refs">
            {card.refs.map((r, i) => {
              if (r.type === 'exp') {
                // Prototype grammar: id as the label, title as the sub line.
                return (
                  <RefRow
                    key={`${r.type}:${r.id}:${i}`}
                    icon="⧉"
                    iconClass="xmap-ic--exp"
                    label={r.id}
                    sub={r.label || r.sub}
                    onOpen={() => onTransport(r.id)}
                  />
                );
              }
              const obj = lookupObject(objects, r.type, r.id);
              return (
                <RefRow
                  key={`${r.type}:${r.id}:${i}`}
                  icon={REF_ICON[r.type] || '▣'}
                  iconClass={`xmap-ic--${r.type}`}
                  label={r.label || obj?.title || r.id}
                  sub={r.sub || obj?.sub}
                  href={r.type === 'paper' ? obj?.url : null}
                  onOpen={obj ? () => onSelectObject(r.type, r.id) : undefined}
                />
              );
            })}
          </div>
        </Section>
      )}
      {cited.length > 0 && (
        <Section title="Cited by">
          <div className="xmap-refs">
            {cited.map((c) => <ExpRow key={c.id} card={c} onTransport={onTransport} />)}
          </div>
        </Section>
      )}
      {meta.length > 0 && <div className="xmap-panel-meta">{meta.join(' · ')}</div>}
    </PanelShell>
  );
}

function ObjectPanel({ sel, cards, objects, onClose, onTransport }) {
  const obj = lookupObject(objects, sel.type, sel.id);
  if (!obj) return null;
  const refBy = referencedBy(cards, sel.type, sel.id);
  // An untitled citation falls back to its source label, which is already the
  // head id — drop the head rather than print the same string twice.
  const headId = sel.type === 'paper' ? obj.sourceLabel || sel.id : sel.id;
  return (
    <PanelShell
      id={headId === obj.title ? null : headId}
      tone={OBJ_TONE[sel.type] || 'sbx'}
      word={OBJ_WORD[sel.type] || sel.type}
      onClose={onClose}
    >
      <div>
        <div className="xmap-panel-title">{obj.title}</div>
        <div className="xmap-panel-text">{[obj.detail, obj.sub].filter(Boolean).join(' — ')}</div>
        {obj.url ? (
          <a className="btn graph-open" href={obj.url} target="_blank" rel="noopener noreferrer">
            Open {OBJ_WORD[sel.type] || sel.type} <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </div>
      {refBy.length > 0 && (
        <Section title="Referenced by">
          <div className="xmap-refs">
            {refBy.map((c) => <ExpRow key={c.id} card={c} onTransport={onTransport} />)}
          </div>
        </Section>
      )}
    </PanelShell>
  );
}

/**
 * MapPanel — the 380px detail panel docked to the right of the map area.
 * Experiment selections show tldr, metrics, gates, references, citations,
 * and the compute footer; object selections (paper/claim/sandbox) show
 * their detail plus every experiment that references them.
 */
export default function MapPanel({ sel, cards, objects, citedBy, onClose, onTransport, onSelectObject }) {
  if (sel.type === 'exp') {
    const card = cards.find((c) => c.id === sel.id);
    if (!card) return null;
    return (
      <ExperimentPanel
        card={card}
        cards={cards}
        objects={objects}
        citedBy={citedBy}
        onClose={onClose}
        onTransport={onTransport}
        onSelectObject={onSelectObject}
      />
    );
  }
  return (
    <ObjectPanel
      sel={sel}
      cards={cards}
      objects={objects}
      onClose={onClose}
      onTransport={onTransport}
    />
  );
}
