import { useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useReflectionLedger } from '../store/useLedger';
import { StaleNote } from '../components/LoadState';
import { useProjectStore, useProjectHref, selectExperiments, selectTasks } from '../store/useProjectStore';
import StatusPill from '../components/StatusPill';
import ConsoleTable, {
  DurationCell, SPAN_SORTS, WhenCell, spanFacts, useTableSort,
} from '../components/ConsoleTable';
import { buildBraid } from '../components/reflection/braidModel';
import { TERMINAL_WAVE } from '../components/reflection/waveModel';
import { fmtDayTime } from '../utils/format';

/**
 * Reflection list: one row per reflection wave, in the
 * experiments-table console dialect. Rows click through to the wave's own
 * page (/reflection/<id>); the graph lives on Home, not here.
 */

// Row facts the table sorts on. Duration is started→published for settled
// waves, started→now for the open one.
function rowFacts(w, nowMs) {
  const status = String(w.status || '');
  return {
    status,
    publishedMs: w.published_at ? Date.parse(w.published_at) : 0,
    ...spanFacts(
      { createdAt: w.created_at, endAt: w.published_at, settled: TERMINAL_WAVE.has(status) },
      nowMs,
    ),
  };
}

const SORTS = {
  duration: SPAN_SORTS.duration,
  wave: (a, b) => a.ordinal - b.ordinal,
  status: (a, b) => a.facts.status.localeCompare(b.facts.status),
  consumed: (a, b) => a.consumed - b.consumed,
  produced: (a, b) => a.produced - b.produced,
  published: (a, b) => a.facts.publishedMs - b.facts.publishedMs,
};

const COLUMNS = [
  { key: 'wave', label: 'Reflection' },
  { key: 'status', label: 'Status' },
  { key: 'consumed', label: 'Consumed', right: true },
  { key: 'produced', label: 'Produced', right: true },
  { key: 'published', label: 'Published' },
  { key: 'duration', label: 'Duration', right: true },
];

export default function Reflection() {
  const projectId = useProjectStore(s => s.projectId);
  const experiments = useProjectStore(selectExperiments);
  const tasks = useProjectStore(selectTasks);
  const navigate = useNavigate();
  const px = useProjectHref();
  const sort = useTableSort('wave');

  // Legacy deep links (?wave=<id>) predate per-wave pages — forward them.
  const [searchParams] = useSearchParams();
  const legacy = searchParams.get('wave');
  useEffect(() => {
    if (legacy) navigate(px(`/reflection/${legacy}`), { replace: true });
  }, [legacy, navigate, px]);

  const [data, error] = useReflectionLedger(projectId, 8000);

  const waves = data?.reflections || [];

  const rows = useMemo(() => {
    const nowMs = Date.now();
    const { strands } = buildBraid(waves, experiments, tasks);
    const list = waves.map((w, i) => ({
      wave: w,
      ordinal: i + 1,
      consumed: strands.filter(s => s.coverIdx === i).length,
      produced: strands.filter(s => s.spawnIdx === i).length,
      facts: rowFacts(w, nowMs),
    }));
    return sort.sorted(list, SORTS);
  }, [waves, experiments, tasks, sort.sortKey, sort.sortDir]);

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <h1 className="page-title">Reflection</h1>
        {error && (data ? <StaleNote error={error.message} /> : <div className="error-message">{error.message}</div>)}
      </header>

      {rows.length === 0 ? data && (
        <div className="empty-state">
          <h2>No reflections yet</h2>
          <p>The first wave grows from the project graph on Home.</p>
        </div>
      ) : (
        <ConsoleTable
          label="Reflections"
          className="expt--refl"
          columns={COLUMNS}
          sort={sort}
          rows={rows.map(({ wave: w, ordinal, consumed, produced, facts }) => ({
            key: w.id,
            href: px(`/reflection/${w.id}`),
            cells: (
              <>
                <div className="expt-main">
                  <div className="expt-title">R{ordinal} · {w.title || `Wave ${ordinal}`}</div>
                  {w.revision_context && (
                    <div className="expt-desc" title={w.revision_context}>↩ {w.revision_context}</div>
                  )}
                  {(w.attempt_index || 1) > 1 && (
                    <div className="expt-sub">attempt {w.attempt_index}</div>
                  )}
                </div>
                <div><StatusPill value={w.status} /></div>
                <div className="expt-dur">{consumed || '—'}</div>
                <div className="expt-dur">{produced || '—'}</div>
                <WhenCell
                  parts={facts.settled ? fmtDayTime(w.published_at) : null}
                  title={w.published_at || ''}
                  noneTitle="still open"
                />
                <DurationCell
                  facts={facts}
                  doneTitle="started → published"
                  liveTitle="elapsed since started"
                />
              </>
            ),
          }))}
        />
      )}
    </div>
  );
}
