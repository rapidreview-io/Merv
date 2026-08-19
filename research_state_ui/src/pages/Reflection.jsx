import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useProjectStore, useProjectHref, selectExperiments, selectTasks } from '../store/useProjectStore';
import StatusPill from '../components/StatusPill';
import { buildBraid } from '../components/reflection/braidModel';
import { TERMINAL_WAVE } from '../components/reflection/waveModel';
import { fmtDayTime, fmtDuration } from '../utils/format';

/**
 * Reflection list — "What we learned": one row per reflection wave, in the
 * experiments-table console dialect. Rows click through to the wave's own
 * page (/reflection/<id>); the graph lives on Home, not here.
 */

// Row facts the table sorts on. Duration is started→published for settled
// waves, started→now for the open one.
function rowFacts(w, nowMs) {
  const status = String(w.status || '');
  const settled = TERMINAL_WAVE.has(status);
  const createdMs = w.created_at ? Date.parse(w.created_at) : NaN;
  const endMs = settled && w.published_at ? Date.parse(w.published_at) : nowMs;
  const durationMs = Number.isFinite(createdMs) ? Math.max(0, endMs - createdMs) : NaN;
  const publishedMs = w.published_at ? Date.parse(w.published_at) : 0;
  return { status, settled, createdMs, endMs, durationMs, publishedMs };
}

const SORTS = {
  wave: (a, b) => a.ordinal - b.ordinal,
  status: (a, b) => a.facts.status.localeCompare(b.facts.status),
  consumed: (a, b) => a.consumed - b.consumed,
  produced: (a, b) => a.produced - b.produced,
  published: (a, b) => a.facts.publishedMs - b.facts.publishedMs,
  duration: (a, b) => (a.facts.durationMs || 0) - (b.facts.durationMs || 0),
};

const COLUMNS = [
  { key: 'wave', label: 'Reflection' },
  { key: 'status', label: 'Status' },
  { key: 'consumed', label: 'Consumed', right: true },
  { key: 'produced', label: 'Produced', right: true },
  { key: 'published', label: 'Published' },
  { key: 'duration', label: 'Duration', right: true },
];

function WhenCell({ parts, title }) {
  if (!parts) return <div className="expt-when expt-when--none">—</div>;
  return (
    <div className="expt-when" title={title}>
      <span className="expt-when-day">{parts.day}</span>
      <span className="expt-when-time">{parts.time}</span>
    </div>
  );
}

export default function Reflection() {
  const projectId = useProjectStore(s => s.projectId);
  const experiments = useProjectStore(selectExperiments);
  const tasks = useProjectStore(selectTasks);
  const navigate = useNavigate();
  const px = useProjectHref();
  const [data, setData] = useState(null);
  const [sortKey, setSortKey] = useState('wave');
  const [sortDir, setSortDir] = useState('desc');

  // Legacy deep links (?wave=<id>) predate per-wave pages — forward them.
  const [searchParams] = useSearchParams();
  const legacy = searchParams.get('wave');
  useEffect(() => {
    if (legacy) navigate(px(`/reflection/${legacy}`), { replace: true });
  }, [legacy, navigate, px]);

  const fetchReflections = useCallback(async () => {
    try {
      const payload = await api.getReflections(projectId);
      setData(prev => (JSON.stringify(prev) === JSON.stringify(payload) ? prev : payload));
    } catch { /* keep the last good list */ }
  }, [projectId]);
  useEffect(() => {
    fetchReflections();
    const t = setInterval(fetchReflections, 8000);
    return () => clearInterval(t);
  }, [fetchReflections]);

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
    const cmp = SORTS[sortKey] || SORTS.wave;
    list.sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
    return list;
  }, [waves, experiments, tasks, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  }

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <h1 className="page-title">What we learned</h1>
      </header>

      {data && rows.length === 0 ? (
        <div className="empty-state">
          <h2>No reflections yet</h2>
          <p>The first wave grows from the project graph on Home.</p>
        </div>
      ) : (
        <div className="expt-scroll">
          <div className="expt expt--refl" role="table" aria-label="Reflections">
            <div className="expt-head con-head" role="row">
              {COLUMNS.map(col => (
                <button
                  key={col.key}
                  type="button"
                  role="columnheader"
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={[
                    'th', 'th--con',
                    col.right ? 'th--r' : '',
                    sortKey === col.key ? 'on' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="arr" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </button>
              ))}
            </div>
            {rows.map(({ wave: w, ordinal, consumed, produced, facts }) => (
              <div
                key={w.id}
                className="expt-row"
                role="row"
                tabIndex={0}
                onClick={() => navigate(px(`/reflection/${w.id}`))}
                onKeyDown={ev => { if (ev.key === 'Enter') navigate(px(`/reflection/${w.id}`)); }}
              >
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
                {facts.settled
                  ? <WhenCell parts={fmtDayTime(w.published_at)} title={w.published_at || ''} />
                  : <div className="expt-when expt-when--none" title="still open">—</div>}
                <div
                  className={`expt-dur${facts.settled ? '' : ' expt-dur--live'}`}
                  title={facts.settled ? 'started → published' : 'elapsed since started'}
                >
                  {fmtDuration(facts.durationMs)}
                  {!facts.settled && <span className="expt-live-dot" aria-hidden="true" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
