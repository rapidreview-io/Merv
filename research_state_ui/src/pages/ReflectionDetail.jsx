import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useProjectStore, useProjectHref, selectExperiments } from '../store/useProjectStore';
import ArtifactContentView from '../components/ArtifactContentView';
import FSMStrip, { REFLECTION_STAGES, REFLECTION_GATES, REFLECTION_TERMINAL } from '../components/FSMStrip';
import ReflectionGraphs from '../components/reflection/ReflectionGraphs';
import ReflectionSpotlight from '../components/reflection/ReflectionSpotlight';
import ConsolidationLedger from '../components/reflection/ConsolidationLedger';
import { buildBraid } from '../components/reflection/braidModel';
import { TERMINAL_WAVE, reflectionsByLens, secondaryDocs, resolveReflectionDoc } from '../components/reflection/waveModel';

/**
 * ReflectionDetail — one wave's own page, the reflection sibling of
 * ExperimentDetail and in its exact section grammar: STAGE (the FSM strip is
 * the status truth) → ORIENTATION (breadcrumb + R<n> title) → MAP (the wave's
 * project logic graph) → RESULTS (reflection doc, lens reflections,
 * consolidation ledger) → LINEAGE (consumed/produced experiments) → quiet
 * footer disclosures. A past wave renders FAITHFULLY from the artifacts it
 * submitted (artifact ids pin exact bytes).
 */

function shortDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

// Quiet disclosure for the secondary artifacts (change spec, review).
function Collapsible({ label, count, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="refl-collapsible">
      <button
        type="button"
        className="btn btn--ghost btn--sm refl-collapsible-toggle"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {label}{count != null ? ` (${count})` : ''}
      </button>
      {open && <div className="refl-collapsible-body">{children}</div>}
    </div>
  );
}

// A consumed/produced experiment, linking to its page.
function LineageItem({ strand, px }) {
  return (
    <Link className="rfl-lineage-item" to={px(`/experiments/${strand.id}`)}>
      <span className={`wflow-item-dot wflow-item-dot--${strand.tone}`} aria-hidden="true" />
      <span className="wflow-item-name">{strand.name}</span>
      <span className="wflow-item-sub">{String(strand.status || '').replace(/_/g, ' ')}</span>
    </Link>
  );
}

export default function ReflectionDetail() {
  const { reflectionId } = useParams();
  const projectId = useProjectStore(s => s.projectId);
  const experiments = useProjectStore(selectExperiments);
  const px = useProjectHref();
  const [data, setData] = useState(null);

  const fetchReflections = useCallback(async () => {
    try {
      const payload = await api.getReflections(projectId);
      setData(prev => (JSON.stringify(prev) === JSON.stringify(payload) ? prev : payload));
    } catch { /* keep the last good payload */ }
  }, [projectId]);
  useEffect(() => {
    fetchReflections();
    const t = setInterval(fetchReflections, 8000);
    return () => clearInterval(t);
  }, [fetchReflections]);

  const waves = data?.reflections || [];
  const idx = waves.findIndex(w => w.id === reflectionId);
  const wave = idx >= 0 ? waves[idx] : null;
  const ordinal = idx + 1;
  const isOpen = Boolean(wave && !TERMINAL_WAVE.has(String(wave.status)));

  const braid = useMemo(() => buildBraid(waves, experiments), [waves, experiments]);
  const consumed = braid.strands.filter(s => s.coverIdx === idx);
  const produced = braid.strands.filter(s => s.spawnIdx === idx);

  const graphFetcher = useCallback(
    () => api.getReflectionGraph(projectId, reflectionId),
    [projectId, reflectionId],
  );

  const reflections = useMemo(() => (wave ? reflectionsByLens(wave) : {}), [wave]);
  const roster = wave?.roster || [];
  const waveArtifacts = wave?.current_attempt_artifacts || [];
  const reviews = wave?.reviews || [];
  const reflectionDoc = resolveReflectionDoc(waveArtifacts);

  if (!data) {
    return <div className="page-stage"><div className="empty-state">Loading reflection…</div></div>;
  }
  if (!wave) {
    return (
      <div className="page-stage">
        <div className="empty-state">
          <h2>Reflection not found</h2>
          <p><Link to={px('/reflection')}>Back to reflections</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-stage">
      {/* ─────────────  STAGE  ──────────────────────────────────────── */}
      <section className="exp-fsm">
        <FSMStrip
          status={wave.status}
          stages={REFLECTION_STAGES}
          gateStates={REFLECTION_GATES}
          terminal={REFLECTION_TERMINAL}
          ariaLabel="Reflection lifecycle"
        />
      </section>

      {/* ─────────────  ORIENTATION  ────────────────────────────────── */}
      <header className="exp-orient">
        <div className="page-eyebrow">
          <Link to={px('/reflection')}>Reflections</Link>
          {(wave.attempt_index || 1) > 1 && (
            <>{' · '}<span className="exp-orient-attempt">attempt {wave.attempt_index}</span></>
          )}
        </div>
        {/* No banners: the revision context and lens coverage live in the
            process graph below (the rejected review node, the lens node). */}
        <h1 className="page-title exp-title-name">R{ordinal} · {wave.title || `Wave ${ordinal}`}</h1>
      </header>

      {/* ─────────────  GRAPHS (one slot, two views — like the experiment):
          the derived PROCESS graph (attempt story) and the wave's project
          LOGIC graph, toggled by the section title. */}
      <ReflectionGraphs
        key={`graphs-${reflectionId}`}
        projectId={projectId}
        reflectionId={reflectionId}
        wave={wave}
        isOpen={isOpen}
        fetcher={graphFetcher}
      />

      {/* ═════════════  RESULTS  ════════════════════════════════════════
          The wave's documents in the report/plan treatment: the consolidated
          Reflection and its per-lens chapters as one tabbed spotlight, then
          what happened to the code. */}
      <ReflectionSpotlight
        key={`doc-${reflectionId}`}
        projectId={projectId}
        wave={wave}
        isOpen={isOpen}
        roster={roster}
        reflections={reflections}
        reflectionDoc={reflectionDoc}
        reviews={reviews}
      />

      <ConsolidationLedger
        key={`cons-${reflectionId}`}
        projectId={projectId}
        reflectionId={wave.id}
        waveStatus={wave.status}
      />

      {/* ─────────────  LINEAGE  ─────────────────────────────────────── */}
      <div className="refl-block">
        <div className="refl-eyebrow">Consumed · {consumed.length}</div>
        {consumed.length
          ? <div className="rfl-lineage">{consumed.map(s => <LineageItem key={s.id} strand={s} px={px} />)}</div>
          : <div className="fig-panel-meta">nothing consolidated yet</div>}
        <div className="refl-eyebrow" style={{ marginTop: 14 }}>Produced · {produced.length}</div>
        {produced.length
          ? <div className="rfl-lineage">{produced.map(s => <LineageItem key={s.id} strand={s} px={px} />)}</div>
          : <div className="fig-panel-meta">no experiments materialized</div>}
      </div>

      {/* secondary, quiet: change spec + other docs, then the review */}
      {secondaryDocs(waveArtifacts).map(({ role, res, label }) => (
        <Collapsible key={role} label={label}>
          <ArtifactContentView
            projectId={projectId}
            artifactId={res.id}
            path={res.path}
          />
        </Collapsible>
      ))}
      <div className="refl-meta" style={{ marginTop: 8 }}>
        {wave.created_at && <span className="refl-meta-item">started {shortDateTime(wave.created_at)}</span>}
        {wave.published_at && <span className="refl-meta-item">published {shortDateTime(wave.published_at)}</span>}
      </div>
    </div>
  );
}
