import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import DetailPanelShell from '../DetailPanelShell';
import StatusPill from '../StatusPill';
import { useProjectHref } from '../../store/useProjectStore';
import { fmtAgo, fmtSpan } from '../../utils/format';
import {
  buildIntentIndex, consolidationSummary, debtMeter, expTimeline, gateSummary,
  lineageOf, outcomeOf, reviewHistory, seedStrands, statusWord,
  waveLenses, waveStory,
} from './panelModel.js';

/**
 * WaveFlowPanel — the right sidebar of the project graph and its primary
 * interaction point. One selected node at a time; the Open button at the top
 * is the door to the full experiment page / reflection route, and everything
 * below it tells the node's story in the same order every time:
 *
 *   identity  →  the one thing to know  →  where it sits in the stream
 *             →  the record (reviews, claims, files)  →  the dates
 *
 * Every row that names another node selects that node in the graph, so the
 * reader can walk the braid from inside the panel: an experiment to the wave
 * that proposed it, the wave to what it consumed, and back.
 */

const TERMINAL_TONES = new Set(['done', 'failed', 'abandoned']);

function fmtDay(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  } catch { return null; }
}

// "Jul 5 · 41d ago" — an absolute day the reader can place, and the distance.
function dayAgo(iso, now = Date.now()) {
  const day = fmtDay(iso);
  if (!day) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${day} · ${fmtAgo(now - t)}` : day;
}

function Eyebrow({ children }) {
  return <div className="refl-eyebrow wflow-panel-eyebrow">{children}</div>;
}

function MetaRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="wflow-meta-row">
      <span className="wflow-meta-key">{label}</span>
      <span className="wflow-meta-val">{value}</span>
    </div>
  );
}

// The panel's quiet, non-interactive line — an empty-state or a caveat.
function Note({ children, tone }) {
  return <div className={`wflow-note${tone ? ` wflow-tone--${tone}` : ''}`}>{children}</div>;
}

// A wave, named the way the canvas names it: the R-number as a small pill.
function WaveTag({ epoch, open }) {
  return <span className={`wflow-wave-tag${open ? ' wflow-wave-tag--open' : ''}`}>{`R${epoch.ordinal}`}</span>;
}

/**
 * One row naming another node. A button, because clicking selects that node
 * in the graph (the panel is a way to walk the braid, not a list of links).
 * `lead` is the tone dot or wave tag; `sub` is the quieter second line.
 */
function NodeRow({ lead, name, sub, meta, onClick, pending }) {
  return (
    <button
      type="button"
      className={`wflow-row${pending ? ' wflow-row--pending' : ''}`}
      onClick={onClick}
    >
      <span className="wflow-row-lead" aria-hidden="true">{lead}</span>
      <span className="wflow-row-main">
        <span className="wflow-row-name">{name}</span>
        {sub ? <span className="wflow-row-sub">{sub}</span> : null}
      </span>
      {meta ? <span className="wflow-row-meta">{meta}</span> : null}
      <span className="wflow-row-go" aria-hidden="true">→</span>
    </button>
  );
}

function StrandRow({ strand, intent, onSelectNode }) {
  const isTask = strand.kind === 'task';
  return (
    <NodeRow
      lead={<span className={`wflow-item-dot wflow-item-dot--${strand.tone}`} />}
      name={strand.name}
      sub={intent}
      meta={(isTask ? 'task · ' : '') + (statusWord(strand.status) || '')}
      onClick={() => onSelectNode({ kind: isTask ? 'task' : 'exp', id: strand.id })}
    />
  );
}

function WaveRow({ epoch, sub, pending, onSelectNode }) {
  return (
    <NodeRow
      lead={<WaveTag epoch={epoch} open={epoch.isOpen} />}
      name={epoch.title}
      sub={sub}
      pending={pending}
      onClick={() => onSelectNode({ kind: 'wave', id: epoch.id })}
    />
  );
}

/**
 * The lineage rows: a verb ("proposed by", "will feed") in a fixed label
 * column, then the target — a wave row, the origin, the ghost, or a plain
 * statement when there is nothing to point at.
 */
function LineageRow({ word, children }) {
  return (
    <div className="wflow-lineage-row">
      <span className="wflow-lineage-word">{word}</span>
      <div className="wflow-lineage-target">{children}</div>
    </div>
  );
}

function Lineage({ strand, braid, onSelectNode }) {
  const { from, to } = lineageOf(strand, braid);
  return (
    <div className="wflow-lineage">
      <LineageRow word={from.word}>
        {from.kind === 'wave' && <WaveRow epoch={from.epoch} onSelectNode={onSelectNode} />}
        {from.kind === 'origin' && (
          <NodeRow
            lead={<span className="wflow-origin-glyph">◆</span>}
            name="project start"
            sub="before any wave opened"
            onClick={() => onSelectNode({ kind: 'origin' })}
          />
        )}
        {from.kind === 'none' && <Note>{from.text}</Note>}
      </LineageRow>
      <LineageRow word={to.word}>
        {to.kind === 'wave' && (
          <WaveRow epoch={to.epoch} sub={to.text} pending={to.pending} onSelectNode={onSelectNode} />
        )}
        {to.kind === 'ghost' && (
          <NodeRow
            lead={<span className="wflow-wave-tag wflow-wave-tag--ghost">next</span>}
            name={to.text}
            pending
            onClick={() => onSelectNode({ kind: 'ghost' })}
          />
        )}
        {to.kind === 'none' && <Note>{to.text}</Note>}
      </LineageRow>
    </div>
  );
}

// The verdict line + the reviewer's prose: the panel's lead block.
function Verdict({ outcome }) {
  if (!outcome) return null;
  return (
    <>
      <Eyebrow>{outcome.eyebrow}</Eyebrow>
      <div className={`wflow-verdict wflow-tone--${outcome.tone}`}>
        <span className="wflow-verdict-glyph" aria-hidden="true">{outcome.glyph}</span>
        <span className="wflow-verdict-line">{outcome.line}</span>
        {outcome.when ? <span className="wflow-verdict-when">{fmtDay(outcome.when)}</span> : null}
      </div>
      {outcome.text ? <p className="wflow-lead">{outcome.text}</p> : null}
    </>
  );
}

// Review history as one row per verdict; the synopsis rides on hover.
function ReviewRows({ reviews }) {
  const rows = reviewHistory(reviews);
  if (!rows.length) return null;
  return (
    <div className="wflow-reviews">
      {rows.map(r => (
        <div key={r.id} className="wflow-review" title={r.synopsis || undefined}>
          <span className={`wflow-review-glyph wflow-tone--${r.tone}`} aria-hidden="true">{r.glyph}</span>
          <span className="wflow-review-role">{r.roleWord}</span>
          <span className={`wflow-review-verdict wflow-tone--${r.tone}`}>
            {r.verdictWord}{r.returnTo ? ` to ${r.returnTo}` : ''}
          </span>
          <span className="wflow-review-when">{fmtDay(r.when)}</span>
        </div>
      ))}
    </div>
  );
}

// The gate checklist: what still stands between this node and its next status.
// Lens items are not listed — the wave panel draws those as coverage chips —
// but a gate that is waiting on lenses alone still says so.
function Gate({ gate }) {
  if (!gate) return null;
  if (!gate.items.length && !gate.lensesMissing) return null;
  return (
    <>
      <Eyebrow>{gate.leadsTo ? `Next · ${gate.leadsTo}` : 'Next'}</Eyebrow>
      {gate.items.length > 0 && (
        <ul className="wflow-gate">
          {gate.items.map(it => (
            <li key={it.id} className={`wflow-gate-item${it.satisfied ? ' wflow-gate-item--done' : ''}`}>
              <span className="wflow-gate-mark" aria-hidden="true">{it.satisfied ? '✓' : '○'}</span>
              <span>{it.label}</span>
            </li>
          ))}
        </ul>
      )}
      {gate.lensesMissing > 0 && (
        <Note tone="qualifies">
          {`waiting on ${gate.lensesMissing} lens ${gate.lensesMissing === 1 ? 'reflection' : 'reflections'}`}
        </Note>
      )}
    </>
  );
}

function ClaimRows({ claims }) {
  const px = useProjectHref();
  const list = (claims || []).filter(c => c && c.id);
  if (!list.length) return null;
  return (
    <>
      <Eyebrow>Claims tested · {list.length}</Eyebrow>
      <div className="wflow-claims">
        {list.map(c => (
          <Link key={c.id} className="wflow-claim" to={px(`/claims/${c.id}`)}>
            <span className="wflow-claim-text">{c.statement || c.id}</span>
            {c.status ? <StatusPill value={c.status} pill={false} /> : null}
          </Link>
        ))}
      </div>
    </>
  );
}

const ROLE_LABEL = { plan: 'plan', report: 'report', result: 'results', graph: 'logic graph' };
// Lifecycle order, not alphabetical: the plan comes first, the story last.
const ROLE_RANK = { plan: 0, result: 1, report: 2, graph: 3 };

// The current attempt's files as chips; each opens the artifact record.
function RecordChips({ current, all }) {
  const px = useProjectHref();
  const cur = (current || []).filter(a => a && a.id)
    .slice()
    .sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9));
  if (!cur.length) return null;
  const earlier = Math.max(0, (all || []).length - cur.length);
  return (
    <>
      <Eyebrow>Records</Eyebrow>
      <div className="wflow-chips">
        {cur.map(a => (
          <Link
            key={a.id}
            className="wflow-chip"
            to={px(`/artifacts/${a.id}`)}
            title={[a.path, a.tldr].filter(Boolean).join(' — ')}
          >
            {ROLE_LABEL[a.role] || String(a.role || 'file').replace(/_/g, ' ')}
          </Link>
        ))}
        {/* Superseded submissions — from earlier attempts or an earlier
            pass of this one — are counted, not listed. */}
        {earlier > 0 && (
          <span className="wflow-chip wflow-chip--quiet">
            +{earlier} earlier {earlier === 1 ? 'version' : 'versions'}
          </span>
        )}
      </div>
    </>
  );
}

function ExpPanel({ strand, row, braid, intents, onClose, onOpenExp, onSelectNode }) {
  const exp = row || {};
  const outcome = outcomeOf(strand, exp);
  const finished = TERMINAL_TONES.has(strand.tone);
  const gate = finished ? null : gateSummary(exp.gate_checklist);
  const tl = expTimeline(strand, exp);
  const intent = String(exp.intent || intents.get(strand.id) || '').trim();
  return (
    <DetailPanelShell
      typeLabel="experiment"
      title={strand.name}
      status={<StatusPill value={String(strand.status || 'unknown')} />}
      onClose={onClose}
    >
      {intent ? <p className="wflow-intent">{intent}</p> : null}
      <button type="button" className="btn graph-open" onClick={() => onOpenExp(strand.id)}>
        Open experiment <span aria-hidden="true">→</span>
      </button>
      {/* A rejection that sent the work back is told by the verdict block
          (latest review · sent back to running, with the reviewer's reason),
          so no separate revision callout here. */}
      <Verdict outcome={outcome} />
      <Gate gate={gate} />
      <Eyebrow>Position</Eyebrow>
      <Lineage strand={strand} braid={braid} onSelectNode={onSelectNode} />
      {/* One review is already told in full above; a HISTORY starts at two. */}
      {(exp.reviews || []).length > 1 && (
        <>
          <Eyebrow>Reviews · {exp.reviews.length}</Eyebrow>
          <ReviewRows reviews={exp.reviews} />
        </>
      )}
      <ClaimRows claims={exp.tested_claims} />
      <RecordChips current={exp.current_attempt_artifacts} all={exp.artifacts} />
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="created" value={dayAgo(tl.created)} />
      {tl.ended
        ? <MetaRow label={tl.endWord} value={`${fmtDay(tl.ended)}${tl.spanMs != null ? ` · after ${fmtSpan(tl.spanMs)}` : ''}`} />
        : <MetaRow label={statusWord(strand.status) || 'status'} value={tl.sinceMs != null ? `for ${fmtSpan(tl.sinceMs)}` : null} />}
      {strand.attemptIndex > 1 && <MetaRow label="attempt" value={strand.attemptIndex} />}
    </DetailPanelShell>
  );
}

function TaskPanel({ strand, row, braid, intents, onClose, onOpenTask, onSelectNode }) {
  const task = row || {};
  const outcome = outcomeOf(strand, task);
  const finished = TERMINAL_TONES.has(strand.tone);
  const gate = finished ? null : gateSummary(task.gate_checklist);
  const tl = expTimeline(strand, task);
  const goal = String(task.goal || intents.get(strand.id) || '').trim();
  const checks = Array.isArray(task.checks) ? task.checks : [];
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  return (
    <DetailPanelShell
      typeLabel="task"
      title={strand.name}
      status={<StatusPill value={String(strand.status || 'unknown')} />}
      onClose={onClose}
    >
      {goal ? <p className="wflow-intent">{goal}</p> : null}
      <button type="button" className="btn graph-open" onClick={() => onOpenTask(strand.id)}>
        Open task <span aria-hidden="true">→</span>
      </button>
      <Verdict outcome={outcome} />
      <Gate gate={gate} />
      {checks.length > 0 && (
        <>
          <Eyebrow>Deliverables · {checks.length}</Eyebrow>
          <ol className="task-checks" style={{ fontSize: 'var(--text-sm)' }}>
            {checks.map((c, i) => <li key={i}>{c}</li>)}
          </ol>
        </>
      )}
      {deps.length > 0 && (
        <>
          <Eyebrow>Waits on · {deps.length}</Eyebrow>
          {deps.map(d => (
            <NodeRow
              key={d.id}
              lead={<span className={`wflow-item-dot wflow-item-dot--${d.settled ? 'done' : d.failed ? 'failed' : 'queued'}`} />}
              name={d.name || d.id}
              meta={`${d.node_type} · ${statusWord(d.status)}`}
              onClick={() => onSelectNode({ kind: d.node_type === 'task' ? 'task' : 'exp', id: d.id })}
            />
          ))}
        </>
      )}
      <Eyebrow>Position</Eyebrow>
      <Lineage strand={strand} braid={braid} onSelectNode={onSelectNode} />
      {(task.reviews || []).length > 1 && (
        <>
          <Eyebrow>Reviews · {task.reviews.length}</Eyebrow>
          <ReviewRows reviews={task.reviews} />
        </>
      )}
      <RecordChips current={task.current_attempt_artifacts} all={task.artifacts} />
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="created" value={dayAgo(tl.created)} />
      {tl.ended
        ? <MetaRow label={tl.endWord} value={`${fmtDay(tl.ended)}${tl.spanMs != null ? ` · after ${fmtSpan(tl.spanMs)}` : ''}`} />
        : <MetaRow label={statusWord(strand.status) || 'status'} value={tl.sinceMs != null ? `for ${fmtSpan(tl.sinceMs)}` : null} />}
    </DetailPanelShell>
  );
}

function LensChips({ lenses }) {
  const px = useProjectHref();
  if (!lenses.length) return null;
  return (
    <div className="wflow-chips">
      {lenses.map(l => {
        const hint = [l.title, l.tldr || l.charter].filter(Boolean).join(' — ');
        const cls = `wflow-chip wflow-lens${l.covered ? ' wflow-lens--covered' : ' wflow-lens--missing'}`;
        return l.covered && l.artifactId ? (
          <Link key={l.id} className={cls} to={px(`/artifacts/${l.artifactId}`)} title={hint}>{l.id}</Link>
        ) : (
          <span key={l.id} className={cls} title={hint}>{l.id}</span>
        );
      })}
    </div>
  );
}

function WavePanel({ epoch, wave, braid, intents, onClose, onOpenWave, onSelectNode }) {
  const { strands } = braid;
  const idx = epoch.idx;
  const consumed = strands.filter(s => s.coverIdx === idx);
  const produced = strands.filter(s => s.spawnIdx === idx);
  // The open wave also draws every uncovered strand toward itself: finished
  // work waiting to be read and live work that will arrive later.
  const feeding = epoch.isOpen ? strands.filter(s => s.coverIdx < 0) : [];
  const lenses = waveLenses(wave);
  const covered = lenses.filter(l => l.covered).length;
  const story = waveStory(wave);
  const gate = epoch.isOpen ? gateSummary(wave?.gate_checklist) : null;
  const cons = epoch.isOpen ? null : consolidationSummary(wave);
  const t0 = epoch.createdAt ? Date.parse(epoch.createdAt) : NaN;
  const t1 = epoch.publishedAt ? Date.parse(epoch.publishedAt) : NaN;
  return (
    <DetailPanelShell
      typeLabel="reflection wave"
      title={`R${epoch.ordinal} · ${epoch.title}`}
      status={<StatusPill value={epoch.status} />}
      onClose={onClose}
    >
      <button type="button" className="btn graph-open" onClick={() => onOpenWave(epoch.id)}>
        Open reflection <span aria-hidden="true">→</span>
      </button>
      {epoch.revisionContext ? (
        <div className="wflow-callout">
          <span aria-hidden="true">↩ </span>
          {epoch.attemptIndex > 1 ? `Attempt ${epoch.attemptIndex} — ` : ''}
          {epoch.revisionContext}
        </div>
      ) : null}
      {story ? (
        <>
          <Eyebrow>Reflection</Eyebrow>
          <p className="wflow-lead">{story}</p>
        </>
      ) : null}
      <Gate gate={gate} />
      {lenses.length > 0 && (
        <>
          <Eyebrow>Lenses · {covered} of {lenses.length}</Eyebrow>
          <LensChips lenses={lenses} />
        </>
      )}
      {(wave?.reviews || []).length > 0 && (
        <>
          <Eyebrow>Reviews · {wave.reviews.length}</Eyebrow>
          <ReviewRows reviews={wave.reviews} />
        </>
      )}
      <Eyebrow>Consumed · {consumed.length}</Eyebrow>
      {consumed.length
        ? consumed.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)
        : <Note>{epoch.isOpen ? 'nothing new had finished when this wave opened' : 'nothing consolidated'}</Note>}
      {epoch.isOpen && (
        <>
          <Eyebrow>Feeding in · {feeding.length}</Eyebrow>
          {feeding.length
            ? feeding.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)
            : <Note>nothing in flight</Note>}
        </>
      )}
      {!epoch.isOpen && (
        <>
          <Eyebrow>Produced · {produced.length}</Eyebrow>
          {produced.length
            ? produced.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)
            : <Note>no experiments materialized</Note>}
        </>
      )}
      {cons ? (
        <>
          <Eyebrow>Consolidation</Eyebrow>
          {cons.summary ? <p className="wflow-lead wflow-lead--quiet">{cons.summary}</p> : null}
          {cons.promoted.map(p => <MetaRow key={p.name} label={p.disposition} value={p.name} />)}
        </>
      ) : null}
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="opened" value={dayAgo(epoch.createdAt)} />
      {epoch.publishedAt ? (
        <MetaRow
          label="published"
          value={`${fmtDay(epoch.publishedAt)}${Number.isFinite(t0) && Number.isFinite(t1) ? ` · after ${fmtSpan(t1 - t0)}` : ''}`}
        />
      ) : null}
      {epoch.attemptIndex > 1 && <MetaRow label="attempt" value={epoch.attemptIndex} />}
    </DetailPanelShell>
  );
}

// A stack of dead experiments: list the members; picking one opens its full
// panel (the canvas keeps highlighting the stack that holds it). The members
// share one origin and one fate, so the stack shows the lineage once.
function GroupPanel({ ids, braid, intents, onClose, onSelectNode }) {
  const members = braid.strands.filter(s => ids.includes(s.id));
  const nF = members.filter(m => m.tone === 'failed').length;
  const nA = members.length - nF;
  const label = [nF && `${nF} failed`, nA && `${nA} abandoned`].filter(Boolean).join(' · ');
  return (
    <DetailPanelShell typeLabel="set aside" title={label || `${members.length} nodes`} onClose={onClose}>
      <p className="wflow-intent">
        Work that ended without a result, stacked so the column stays short. Pick one to open it.
      </p>
      <Eyebrow>{members.every(m => m.kind === 'task') ? 'Tasks' : members.some(m => m.kind === 'task') ? 'Nodes' : 'Experiments'} · {members.length}</Eyebrow>
      {members.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)}
      {members[0] ? (
        <>
          <Eyebrow>Position</Eyebrow>
          <Lineage strand={members[0]} braid={braid} onSelectNode={onSelectNode} />
        </>
      ) : null}
    </DetailPanelShell>
  );
}

function OriginPanel({ project, braid, intents, onClose, onSelectNode }) {
  const seeds = seedStrands(braid);
  const claims = (project?.active_claims || []).filter(c => c && c.id);
  const px = useProjectHref();
  const nWaves = braid.epochs.length;
  const nExps = braid.strands.length;
  const lastPublished = braid.epochs.slice().reverse().find(e => !e.isOpen && e.publishedAt) || null;
  return (
    <DetailPanelShell typeLabel="project" title={project?.name || 'Project'} onClose={onClose}>
      {project?.summary ? <p className="wflow-lead">{project.summary}</p> : null}
      <div className="wflow-stats" role="list">
        <div className="wflow-stat" role="listitem"><span className="wflow-stat-n">{nWaves}</span><span className="wflow-stat-l">{nWaves === 1 ? 'reflection' : 'reflections'}</span></div>
        <div className="wflow-stat" role="listitem"><span className="wflow-stat-n">{nExps}</span><span className="wflow-stat-l">{nExps === 1 ? 'experiment' : 'experiments'}</span></div>
        <div className="wflow-stat" role="listitem"><span className="wflow-stat-n">{claims.length}</span><span className="wflow-stat-l">{claims.length === 1 ? 'claim' : 'claims'}</span></div>
      </div>
      <Eyebrow>Seeded · {seeds.length}</Eyebrow>
      {seeds.length
        ? seeds.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)
        : <Note>no experiments yet — the first wave grows from here</Note>}
      {claims.length > 0 && (
        <>
          <Eyebrow>Claims · {claims.length}</Eyebrow>
          <div className="wflow-claims">
            {claims.map(c => (
              <Link key={c.id} className="wflow-claim" to={px(`/claims/${c.id}`)}>
                <span className="wflow-claim-text">{c.statement}</span>
                {c.confidence ? <span className="wflow-claim-conf">{c.confidence}</span> : null}
              </Link>
            ))}
          </div>
        </>
      )}
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="created" value={dayAgo(project?.created_at)} />
      {lastPublished ? (
        <MetaRow
          label="last published"
          value={(
            <button type="button" className="wflow-inline-link" onClick={() => onSelectNode({ kind: 'wave', id: lastPublished.id })}>
              {`R${lastPublished.ordinal} · ${fmtDay(lastPublished.publishedAt)}`}
            </button>
          )}
        />
      ) : null}
    </DetailPanelShell>
  );
}

// The reflection debt: how much finished work is waiting for the next wave.
function Meter({ meter }) {
  if (!meter) return null;
  const cells = [];
  for (let i = 0; i < meter.m; i++) {
    cells.push(
      <span
        key={i}
        className={`wflow-meter-cell${i < meter.n ? ' wflow-meter-cell--on' : ''}${meter.nudge != null && i === meter.nudge - 1 ? ' wflow-meter-cell--nudge' : ''}`}
      />,
    );
  }
  return (
    <div
      className={`wflow-meter${meter.blocked ? ' wflow-meter--blocked' : meter.nudged ? ' wflow-meter--nudged' : ''}`}
      role="img"
      aria-label={`${meter.n} of ${meter.m} finished experiments since the last reflection`}
    >
      <div className="wflow-meter-cells" aria-hidden="true">{cells}</div>
      <div className="wflow-meter-caption">
        <span className="wflow-meter-n">{meter.n} of {meter.m}</span>
        {' finished since the last reflection'}
        {meter.nudge != null ? ` · a reflection is nudged at ${meter.nudge}` : ''}
        {`, new experiments are blocked at ${meter.m}`}
      </div>
    </div>
  );
}

function GhostPanel({ braid, signal, intents, onClose, onOpenWave, onSelectNode }) {
  const { epochs, strands } = braid;
  const waiting = strands.filter(s => s.coverIdx < 0);
  const finished = waiting.filter(s => TERMINAL_TONES.has(s.tone));
  const inFlight = waiting.filter(s => !TERMINAL_TONES.has(s.tone));
  const meter = debtMeter(signal);
  const lastPublished = epochs.slice().reverse().find(e => !e.isOpen && e.publishedAt) || null;
  return (
    <DetailPanelShell typeLabel="next reflection" title="Not started yet" onClose={onClose}>
      <p className="wflow-intent">
        Finished experiments gather here until a wave opens to read them.
      </p>
      <button type="button" className="btn graph-open" onClick={() => onOpenWave(null)}>
        Open reflections <span aria-hidden="true">→</span>
      </button>
      {meter?.blocked ? (
        <div className="wflow-callout wflow-callout--block">
          New experiments are blocked until a reflection reads the finished work.
        </div>
      ) : null}
      <Meter meter={meter} />
      {signal?.hint ? <p className="wflow-lead wflow-lead--quiet">{signal.hint}</p> : null}
      <Eyebrow>Waiting to be read · {finished.length}</Eyebrow>
      {finished.length
        ? finished.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)
        : <Note>nothing finished since the last wave</Note>}
      {inFlight.length > 0 && (
        <>
          <Eyebrow>Still in flight · {inFlight.length}</Eyebrow>
          {inFlight.map(s => <StrandRow key={s.id} strand={s} intent={intents.get(s.id)} onSelectNode={onSelectNode} />)}
        </>
      )}
      {lastPublished ? (
        <>
          <Eyebrow>Last published</Eyebrow>
          <WaveRow
            epoch={lastPublished}
            sub={lastPublished.publishedAt ? dayAgo(lastPublished.publishedAt) : null}
            onSelectNode={onSelectNode}
          />
        </>
      ) : null}
    </DetailPanelShell>
  );
}

export default function WaveFlowPanel({
  sel, braid, waves, experiments, tasks = [], signal, project,
  onClose, onOpenExp, onOpenTask, onOpenWave, onSelectNode,
}) {
  // Intent lines for every node the panel may list, from whichever source
  // names it — the live rows first, then what the waves recorded.
  const intents = useMemo(() => buildIntentIndex(experiments, waves, tasks), [experiments, waves, tasks]);
  if (!sel) return null;
  const { epochs, strands } = braid;
  let body = null;
  if (sel.kind === 'group') {
    body = (
      <GroupPanel
        ids={sel.ids || []}
        braid={braid}
        intents={intents}
        onClose={onClose}
        onSelectNode={onSelectNode}
      />
    );
  } else if (sel.kind === 'origin') {
    body = (
      <OriginPanel
        project={project}
        braid={braid}
        intents={intents}
        onClose={onClose}
        onSelectNode={onSelectNode}
      />
    );
  } else if (sel.kind === 'exp') {
    const strand = strands.find(s => s.id === sel.id);
    if (!strand) return null;
    const row = (experiments || []).find(e => e.id === sel.id) || null;
    body = (
      <ExpPanel
        strand={strand}
        row={row}
        braid={braid}
        intents={intents}
        onClose={onClose}
        onOpenExp={onOpenExp}
        onSelectNode={onSelectNode}
      />
    );
  } else if (sel.kind === 'task') {
    const strand = strands.find(s => s.id === sel.id);
    if (!strand) return null;
    const row = (tasks || []).find(t => t.id === sel.id) || null;
    body = (
      <TaskPanel
        strand={strand}
        row={row}
        braid={braid}
        intents={intents}
        onClose={onClose}
        onOpenTask={onOpenTask || (() => {})}
        onSelectNode={onSelectNode}
      />
    );
  } else if (sel.kind === 'wave') {
    const i = epochs.findIndex(e => e.id === sel.id);
    if (i < 0) return null;
    const wave = (waves || []).find(w => w.id === sel.id) || null;
    body = (
      <WavePanel
        epoch={{ ...epochs[i], idx: i }}
        wave={wave}
        braid={braid}
        intents={intents}
        onClose={onClose}
        onOpenWave={onOpenWave}
        onSelectNode={onSelectNode}
      />
    );
  } else {
    body = (
      <GhostPanel
        braid={braid}
        signal={signal}
        intents={intents}
        onClose={onClose}
        onOpenWave={onOpenWave}
        onSelectNode={onSelectNode}
      />
    );
  }
  return body;
}
