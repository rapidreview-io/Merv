import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { useStorageLedger } from '../store/useStorageLedger';
import { api } from '../api';
import ObjId from '../components/ObjId';
import { formatBytes, fmtDuration, fmtStamp, fmtDayTime } from '../utils/format';
import './storage.css';

const DAY = 86400000;

// The expiry verdict — one phrase per object. `sort` orders by how loudly the
// object needs attention: expiring soonest first, then the rest, kept, gone cold.
function expiryState(o) {
  if (!o.expires_at) return { key: 'kept', label: 'kept', sort: 1e15 };
  const ms = new Date(o.expires_at).getTime() - Date.now();
  if (ms <= 0) return { key: 'cold', label: 'gone cold', sort: 2e15 };
  if (ms < 7 * DAY) return { key: 'soon', label: `expires ${fmtDuration(ms)}`, sort: ms };
  return { key: 'live', label: `expires ${Math.round(ms / DAY)}d`, sort: ms };
}

const stamp = (iso) => (iso ? fmtStamp(new Date(iso).getTime()) : '—');

const COLS = [
  ['no', 'no.', 'vlt-c-no'],
  ['object', 'object', 'vlt-c-name'],
  ['kind', 'kind', 'vlt-c-kind'],
  ['mass', 'mass', 'vlt-c-mass'],
  ['saved', 'saved', 'vlt-c-saved'],
  ['state', 'state', 'vlt-c-state'],
];

/**
 * Storage — the long-term ledger as a typed manifest. A ring gauge carries the
 * project's preserved mass (tap a segment ↔ focus its row); mono manifest
 * rows carry accession no. / object / kind / mass / saved / expiry state;
 * the focused row slides open into a retrieval record. Focus is URL state
 * (/storage/:objectId), the same contract as everywhere else.
 */
export default function Storage() {
  const { objectId } = useParams();
  const navigate = useNavigate();
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const { objects, loading, error, unsupported, reload } = useStorageLedger(projectId);
  const [sort, setSort] = useState({ col: 'mass', asc: null }); // asc null → column default

  // Accession numbers are permanent: assigned by save order, immune to sorting.
  const rows = useMemo(() => {
    const byAge = objects.slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    const no = new Map(byAge.map((o, i) => [o.id, i + 1]));
    return objects.map(o => ({
      o,
      no: no.get(o.id),
      mass: o.size_bytes || 0,
      saved: o.created_at ? new Date(o.created_at).getTime() : 0,
      state: expiryState(o),
    }));
  }, [objects]);

  const defaultAsc = { no: true, object: true, kind: true, mass: false, saved: false, state: true };
  const sortAsc = sort.asc ?? defaultAsc[sort.col];
  const board = useMemo(() => {
    const cmp = {
      no: (a, b) => a.no - b.no,
      object: (a, b) => (a.o.name || '').localeCompare(b.o.name || ''),
      kind: (a, b) => (a.o.kind || '').localeCompare(b.o.kind || ''),
      mass: (a, b) => a.mass - b.mass,
      saved: (a, b) => a.saved - b.saved,
      state: (a, b) => a.state.sort - b.state.sort,
    }[sort.col];
    const s = rows.slice().sort(cmp);
    if (!sortAsc) s.reverse();
    return s;
  }, [rows, sort, sortAsc]);
  const onSort = (col) =>
    setSort(prev => (prev.col === col ? { col, asc: !(prev.asc ?? defaultAsc[col]) } : { col, asc: null }));

  // The ring holds what still occupies storage; gone-cold objects live only
  // in the manifest, as ghosts. Segment order mirrors the default sort (mass).
  const ring = useMemo(
    () => rows.filter(r => r.state.key !== 'cold').sort((a, b) => b.mass - a.mass),
    [rows],
  );
  const totalMass = ring.reduce((s, r) => s + r.mass, 0);
  const kept = ring.filter(r => r.state.key === 'kept').length;
  const expiring = ring.length - kept;
  const cold = rows.length - ring.length;
  const soonest = ring.filter(r => r.state.key === 'soon').sort((a, b) => a.state.sort - b.state.sort)[0] || null;

  const toggle = (id) => navigate(px(!id || id === objectId ? '/storage' : `/storage/${id}`));

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <h1 className="page-title">Storage</h1>
      </header>

      {error && <div className="error-message">{error}</div>}

      {unsupported ? (
        <div className="empty-state">
          <h2>Storage isn’t enabled on this backend yet</h2>
          <p>The long-term storage service is part of an in-progress rollout. Once the backend exposes it, datasets and models saved by the agent will appear here.</p>
        </div>
      ) : loading && objects.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : objects.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing in storage yet</h2>
          <p>Agents preserve precious datasets and trained models with the <span className="mono">storage.*</span> tools. Objects expire after 60 days unless touched or kept.</p>
        </div>
      ) : (
        <div className="vlt">
          {ring.length > 0 && (
            <div className="vlt-instrument">
              <MassRing ring={ring} total={totalMass} focusId={objectId} onPick={toggle} />
              <div className="vlt-legend">
                {kept > 0 && <div className="vlt-leg vlt-leg--kept">{kept} kept</div>}
                {expiring > 0 && <div className="vlt-leg">{expiring} expiring</div>}
                {soonest && <div className="vlt-leg vlt-leg--warn">{soonest.o.name} {soonest.state.label}</div>}
                {cold > 0 && <div className="vlt-leg vlt-leg--cold">{cold} gone cold</div>}
              </div>
            </div>
          )}

          <div className="vlt-board">
            <div className="vlt-head">
              {COLS.map(([col, label, cls]) => (
                <button
                  key={col}
                  type="button"
                  className={`th th--led ${cls}${col === 'mass' || col === 'state' ? ' th--r' : ''}${sort.col === col ? ' on' : ''}`}
                  onClick={() => onSort(col)}
                >
                  {label}{sort.col === col && <span className="arr">{sortAsc ? '▲' : '▼'}</span>}
                </button>
              ))}
            </div>
            {board.map(r => (
              <ManifestRow
                key={r.o.id}
                r={r}
                open={r.o.id === objectId}
                onToggle={() => toggle(r.o.id)}
                projectId={projectId}
                onChanged={reload}
                onDiscarded={() => { toggle(null); reload(); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const RING_R = 62;
const RING_C = 2 * Math.PI * RING_R;

// Mass gauge. Arc length is honest byte proportion, with a legibility floor:
// slivers get ≥6px of arc so they stay visible and tappable, paid for by the
// segments that can afford it.
function MassRing({ ring, total, focusId, onPick }) {
  const GAP = ring.length > 1 ? 2 : 0;
  const MIN = 6;
  const avail = RING_C - GAP * ring.length;
  let lens = ring.map(r => (total > 0 ? (r.mass / total) * avail : avail / ring.length));
  const deficit = lens.reduce((s, l) => s + Math.max(0, MIN - l), 0);
  const surplus = lens.reduce((s, l) => s + Math.max(0, l - MIN), 0);
  lens = lens.map(l => (l < MIN ? MIN : l - (surplus > 0 ? deficit * ((l - MIN) / surplus) : 0)));

  let off = 0;
  const segs = ring.map((r, i) => {
    const seg = { r, len: lens[i], off };
    off += lens[i] + GAP;
    return seg;
  });

  return (
    <svg className="vlt-ring" width="150" height="150" viewBox="0 0 150 150" role="group"
      aria-label={`${formatBytes(total)} preserved across ${ring.length} object${ring.length === 1 ? '' : 's'}`}>
      <g transform="rotate(-90 75 75)">
        {segs.map(({ r, len, off: o }) => (
          <circle
            key={r.o.id}
            className={`vlt-seg${focusId === r.o.id ? ' on' : ''}`}
            cx="75" cy="75" r={RING_R} fill="none" strokeWidth="10"
            strokeDasharray={`${len} ${RING_C}`} strokeDashoffset={-o}
            role="button" tabIndex={0}
            aria-label={`${r.o.name} · ${formatBytes(r.mass)}`}
            onClick={() => onPick(r.o.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.o.id); } }}
          >
            <title>{`${r.o.name} · ${formatBytes(r.mass)}`}</title>
          </circle>
        ))}
      </g>
      <text x="75" y="72" textAnchor="middle" className="vlt-hub-total">{formatBytes(total)}</text>
      <text x="75" y="89" textAnchor="middle" className="vlt-hub-count">{ring.length} object{ring.length === 1 ? '' : 's'}</text>
    </svg>
  );
}

function ManifestRow({ r, open, onToggle, projectId, onChanged, onDiscarded }) {
  const { o, no, state } = r;
  return (
    <div className={`vlt-obj${open ? ' is-open' : ''}${state.key === 'cold' ? ' is-cold' : ''}`}>
      <div
        className="vlt-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <span className="vlt-c-no">{String(no).padStart(3, '0')}</span>
        <span className="vlt-c-name">
          {o.name}{o.version != null && <span className="vlt-ver"> v{o.version}</span>}
        </span>
        <span className="vlt-c-kind">{o.kind}</span>
        <span className="vlt-c-mass">{formatBytes(o.size_bytes)}</span>
        <span className="vlt-c-saved">{fmtDayTime(o.created_at)?.day || '—'}</span>
        <span className={`vlt-c-state vlt-c-state--${state.key}`}>{state.label}</span>
      </div>
      {open && (
        <RetrievalRecord o={o} projectId={projectId} onChanged={onChanged} onDiscarded={onDiscarded} />
      )}
    </div>
  );
}

// The specimen drawer: one field per line in an aligned label column,
// custodial verbs apart. retrieve = presigned download (also renews the expiry
// clock), keep = pin, extend = reset the 60 days. Retention only ever
// lengthens in the storage service, so there is no release verb: an object is
// either let go by its own clock or discarded outright.
function RetrievalRecord({ o, projectId, onChanged, onDiscarded }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);
  const [link, setLink] = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function run(verb, fn) {
    setBusy(verb);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  const pinned = !o.expires_at;
  const expired = !pinned && new Date(o.expires_at).getTime() <= Date.now();
  const sha = o.content_sha256 || '';

  return (
    <div className="vlt-record">
      <div className="vlt-record-inner">
        <div className="vlt-fields">
          <Field k="id"><ObjId id={o.id} /></Field>
          {sha && <Field k="seal"><span title={sha}>{sha.slice(0, 8)}…{sha.slice(-8)}</span></Field>}
          {o.content_type && <Field k="type">{o.content_type}</Field>}
          <Field k="kept since">{stamp(o.created_at)}</Field>
        </div>

        {link && (
          <div className="vlt-linkline">
            <a href={link} target="_blank" rel="noreferrer">{link.length > 72 ? `${link.slice(0, 72)}…` : link}</a>
            <span className="vlt-linknote">short-lived retrieval link</span>
          </div>
        )}

        <div className="vlt-verbs">
          {!expired && (
            <button
              type="button" className="vlt-verb vlt-verb--lead" disabled={!!busy}
              onClick={() => run('retrieve', async () => {
                const res = await api.storageDownloadLink(projectId, o.id);
                setLink(res?.download?.url || null);
                onChanged();
              })}
            >
              {busy === 'retrieve' ? 'retrieving…' : 'retrieve'}
            </button>
          )}
          {!pinned && (
            <>
              <button
                type="button" className="vlt-verb" disabled={!!busy}
                onClick={() => run('keep', async () => { await api.pinStorage(projectId, o.id); onChanged(); })}
              >
                {busy === 'keep' ? '…' : 'keep'}
              </button>
              <button
                type="button" className="vlt-verb" disabled={!!busy}
                onClick={() => run('extend', async () => { await api.renewStorage(projectId, o.id); onChanged(); })}
              >
                {busy === 'extend' ? '…' : 'extend 60d'}
              </button>
            </>
          )}
          {confirming ? (
            <span className="vlt-confirm">
              discard forever?
              <button
                type="button" className="vlt-verb vlt-verb--danger" disabled={!!busy}
                onClick={() => run('discard', async () => { await api.deleteStorage(projectId, o.id); onDiscarded(); })}
              >
                {busy === 'discard' ? 'discarding…' : 'discard'}
              </button>
              <button type="button" className="vlt-verb" disabled={!!busy} onClick={() => setConfirming(false)}>cancel</button>
            </span>
          ) : (
            <button type="button" className="vlt-verb vlt-verb--danger" disabled={!!busy} onClick={() => setConfirming(true)}>
              discard
            </button>
          )}
        </div>

        {err && <div className="vlt-err">{err}</div>}
      </div>
    </div>
  );
}

function Field({ k, children }) {
  return (
    <div className="vlt-field">
      <span className="vlt-k">{k}</span>
      <span className="vlt-v">{children}</span>
    </div>
  );
}
