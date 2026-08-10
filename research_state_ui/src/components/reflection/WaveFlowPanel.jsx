import DetailPanelShell from '../DetailPanelShell';
import StatusPill from '../StatusPill';

/**
 * WaveFlowPanel — the right sidebar of the project graph and its primary
 * interaction point. One selected node at a time (experiment, reflection
 * wave, or the ghost "next" wave); the giant Open button at the top is the
 * door to the full experiment page / reflection route. Everything below it
 * is organized identity → substance → lineage → meta, so the eye always
 * lands on the same order.
 */

const TERMINAL_TONES = new Set(['done', 'failed', 'abandoned']);

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return null; }
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

// A strand reference inside a list: tone dot + name, click selects that node.
function StrandItem({ strand, onSelectNode }) {
  return (
    <button
      type="button"
      className="wflow-panel-item"
      onClick={() => onSelectNode({ kind: 'exp', id: strand.id })}
    >
      <span className={`wflow-item-dot wflow-item-dot--${strand.tone}`} aria-hidden="true" />
      <span className="wflow-item-name">{strand.name}</span>
      <span className="wflow-item-sub">{String(strand.status || '').replace(/_/g, ' ')}</span>
    </button>
  );
}

function Eyebrow({ children }) {
  return <div className="refl-eyebrow wflow-panel-eyebrow">{children}</div>;
}

function ExpPanel({ strand, row, epochs, onClose, onOpenExp, onSelectNode }) {
  const exp = row || {};
  const spawn = strand.spawnIdx >= 0 ? epochs[strand.spawnIdx] : null;
  const cover = strand.coverIdx >= 0 ? epochs[strand.coverIdx] : null;
  return (
    <DetailPanelShell typeLabel="experiment" title={strand.name} onClose={onClose}>
      <button type="button" className="wflow-open-btn" onClick={() => onOpenExp(strand.id)}>
        Open experiment →
      </button>
      <div className="wflow-panel-pills">
        <StatusPill value={String(strand.status || 'unknown')} />
        {strand.attemptIndex > 1 && <span className="wflow-chip-quiet">attempt {strand.attemptIndex}</span>}
      </div>
      {exp.intent && <p className="wflow-panel-prose">{exp.intent}</p>}
      {exp.conclusion && (
        <>
          <Eyebrow>Conclusion</Eyebrow>
          <p className="wflow-panel-prose">{exp.conclusion}</p>
        </>
      )}
      <Eyebrow>Lineage</Eyebrow>
      {spawn ? (
        <button
          type="button"
          className="wflow-panel-item"
          onClick={() => onSelectNode({ kind: 'wave', id: spawn.id })}
        >
          <span className="wflow-item-name">proposed by R{spawn.ordinal}</span>
        </button>
      ) : (
        <div className="fig-panel-meta">added outside a reflection wave</div>
      )}
      {cover ? (
        <button
          type="button"
          className="wflow-panel-item"
          onClick={() => onSelectNode({ kind: 'wave', id: cover.id })}
        >
          <span className="wflow-item-name">consolidated by R{cover.ordinal}</span>
        </button>
      ) : (
        <div className="fig-panel-meta wflow-pending-note">
          {TERMINAL_TONES.has(strand.tone) ? 'finished — not yet consolidated' : 'in flight — will feed the next reflection'}
        </div>
      )}
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="created" value={fmtDate(exp.created_at || strand.createdAt)} />
      <MetaRow label="updated" value={fmtDate(exp.updated_at)} />
      <MetaRow label="tested claims" value={(exp.tested_claims || []).length || null} />
      <MetaRow label="artifacts" value={(exp.artifacts || []).length || null} />
    </DetailPanelShell>
  );
}

function WavePanel({ epoch, wave, strands, onClose, onOpenWave, onSelectNode }) {
  const idx = epoch.idx;
  const consumed = strands.filter(s => s.coverIdx === idx);
  const produced = strands.filter(s => s.spawnIdx === idx);
  const lenses = wave?.reflection_coverage?.lenses || [];
  const covered = lenses.filter(l => l.covered).length;
  const missing = wave?.reflection_coverage?.missing || [];
  const reviewItem = (wave?.gate_checklist?.items || []).find(it => it.kind === 'review') || null;
  return (
    <DetailPanelShell typeLabel="reflection · consolidation" title={`R${epoch.ordinal} · ${epoch.title}`} onClose={onClose}>
      <button type="button" className="wflow-open-btn" onClick={() => onOpenWave(epoch.id)}>
        Open reflection →
      </button>
      <div className="wflow-panel-pills">
        <StatusPill value={epoch.status} />
        {epoch.attemptIndex > 1 && <span className="wflow-chip-quiet">attempt {epoch.attemptIndex}</span>}
      </div>
      {epoch.revisionContext && (
        <div className="wflow-revision">↩ {epoch.revisionContext}</div>
      )}
      {epoch.isOpen && lenses.length > 0 && (
        <>
          <Eyebrow>Coverage</Eyebrow>
          <MetaRow label="lenses" value={`${covered} of ${lenses.length}`} />
          {missing.length > 0 && <MetaRow label="missing" value={missing.join(', ')} />}
          {reviewItem && <MetaRow label="review" value={String(reviewItem.status || '').replace(/_/g, ' ')} />}
        </>
      )}
      <Eyebrow>Consumed · {consumed.length}</Eyebrow>
      {consumed.length
        ? consumed.map(s => <StrandItem key={s.id} strand={s} onSelectNode={onSelectNode} />)
        : <div className="fig-panel-meta">nothing consolidated yet</div>}
      <Eyebrow>Produced · {produced.length}</Eyebrow>
      {produced.length
        ? produced.map(s => <StrandItem key={s.id} strand={s} onSelectNode={onSelectNode} />)
        : <div className="fig-panel-meta">no experiments materialized</div>}
      <Eyebrow>Details</Eyebrow>
      <MetaRow label="started" value={fmtDate(epoch.createdAt)} />
      <MetaRow label="published" value={fmtDate(epoch.publishedAt)} />
    </DetailPanelShell>
  );
}

// Pre-wave column membership, mirroring buildFlowModel's colOf === -1.
function seedStrands({ epochs, strands }) {
  const openIdx = epochs.findIndex(e => e.isOpen);
  const frontierCol = openIdx >= 0 ? openIdx - 1 : epochs.length - 1;
  const colOf = s => (s.spawnIdx >= 0 ? s.spawnIdx
    : s.coverIdx >= 0 ? s.coverIdx - 1 : frontierCol);
  return strands.filter(s => colOf(s) === -1);
}

// A stack of dead experiments: list the members; picking one opens its full
// panel (the canvas keeps highlighting the stack that holds it).
function GroupPanel({ ids, strands, onClose, onSelectNode }) {
  const members = strands.filter(s => ids.includes(s.id));
  return (
    <DetailPanelShell typeLabel="set aside" title={`${members.length} experiments`} onClose={onClose}>
      <div className="fig-panel-meta">
        Failed and abandoned work, stacked to keep the column short.
      </div>
      {members.map(s => <StrandItem key={s.id} strand={s} onSelectNode={onSelectNode} />)}
    </DetailPanelShell>
  );
}

function OriginPanel({ project, braid, onClose, onSelectNode }) {
  const seeds = seedStrands(braid);
  return (
    <DetailPanelShell typeLabel="project" title={project?.name || 'Project'} onClose={onClose}>
      {project?.summary && <p className="wflow-panel-prose">{project.summary}</p>}
      <Eyebrow>Seeded · {seeds.length}</Eyebrow>
      {seeds.length
        ? seeds.map(s => <StrandItem key={s.id} strand={s} onSelectNode={onSelectNode} />)
        : <div className="fig-panel-meta">no experiments yet — the first wave grows from here</div>}
    </DetailPanelShell>
  );
}

function GhostPanel({ strands, signal, onClose, onOpenWave, onSelectNode }) {
  const waiting = strands.filter(s => s.coverIdx < 0);
  const finished = waiting.filter(s => TERMINAL_TONES.has(s.tone));
  const n = signal?.new_terminal_since_publish;
  const m = signal?.block_new_terminal_threshold;
  return (
    <DetailPanelShell typeLabel="next reflection" title="Not started yet" onClose={onClose}>
      <button type="button" className="wflow-open-btn" onClick={() => onOpenWave(null)}>
        Open reflection →
      </button>
      {n != null && m && (
        <div className="wflow-revision">
          {n} of {m} finished experiments since the last wave{signal?.experiment_create_blocked ? ' — new experiments blocked' : ''}.
        </div>
      )}
      {signal?.hint && <p className="wflow-panel-prose">{signal.hint}</p>}
      <Eyebrow>Waiting to be consumed · {finished.length}</Eyebrow>
      {finished.length
        ? finished.map(s => <StrandItem key={s.id} strand={s} onSelectNode={onSelectNode} />)
        : <div className="fig-panel-meta">nothing finished since the last wave</div>}
    </DetailPanelShell>
  );
}

export default function WaveFlowPanel({
  sel, braid, waves, experiments, signal, project,
  onClose, onOpenExp, onOpenWave, onSelectNode,
}) {
  if (!sel) return null;
  const { epochs, strands } = braid;
  let body = null;
  if (sel.kind === 'group') {
    body = (
      <GroupPanel
        ids={sel.ids || []}
        strands={strands}
        onClose={onClose}
        onSelectNode={onSelectNode}
      />
    );
  } else if (sel.kind === 'origin') {
    body = (
      <OriginPanel
        project={project}
        braid={braid}
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
        epochs={epochs}
        onClose={onClose}
        onOpenExp={onOpenExp}
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
        strands={strands}
        onClose={onClose}
        onOpenWave={onOpenWave}
        onSelectNode={onSelectNode}
      />
    );
  } else {
    body = (
      <GhostPanel
        strands={strands}
        signal={signal}
        onClose={onClose}
        onOpenWave={onOpenWave}
        onSelectNode={onSelectNode}
      />
    );
  }
  return <div className="wflow-panel">{body}</div>;
}
