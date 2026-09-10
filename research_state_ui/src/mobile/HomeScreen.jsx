import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  useProjectStore,
  useProjectHref,
  selectProject,
  selectStats,
  selectActiveExperiments,
  selectReviewRequests,
  selectSandboxes,
  selectExperiments,
} from '../store/useProjectStore';
import { useNow } from '../store/useNow';
import { useAsyncData } from '../store/usePolling';
import { expName } from '../utils/experiment';
import { fmtDuration, fmtUsd, fmtHrs } from '../utils/format';
import { DAY_MS } from '../utils/time';
import { densifyDaily } from '../utils/spend';

const REVIEW_STATES = new Set(['design_review', 'experiment_review']);
const SOON_MS = 30 * 60 * 1000;
const METRICS_POLL_MS = 12000;

// "8×H100" / "8x H100" → 8; bare "H100" → 1; no gpu → 0.
function gpuCountOf(sandbox) {
  const gpu = sandbox?.gpu || '';
  if (!gpu) return 0;
  const m = gpu.match(/(\d+)\s*[x×]/i);
  return m ? Number(m[1]) : 1;
}

function fmtStanding(d) {
  const day = d.toLocaleDateString([], { weekday: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase().replace(/\s/g, '');
  return `${day} · ${time}`;
}

// GPU compute over the trailing 24h: Σ(overlap-with-window × gpu-count) per
// sandbox. Approximate by design — released sandboxes without an end stamp
// fall back to their expiry.
function gpuHours24(sandboxes, now) {
  const windowStart = now - DAY_MS;
  let ms = 0;
  for (const s of sandboxes) {
    const gpus = gpuCountOf(s);
    if (!gpus || !s.requested_at) continue;
    const start = Date.parse(s.requested_at);
    if (!Number.isFinite(start)) continue;
    const rawEnd = s.status === 'running'
      ? now
      : Date.parse(s.released_at || s.expires_at || s.updated_at || '') || start;
    const overlap = Math.min(rawEnd, now) - Math.max(start, windowStart);
    if (overlap > 0) ms += overlap * gpus;
  }
  const h = ms / 3600000;
  if (h <= 0) return '0';
  if (h < 10) return String(Math.round(h * 10) / 10);
  return String(Math.round(h));
}

// Live GPU-util/VRAM sampler — polls only while a running sandbox exists.
function useLiveGpu(projectId, sandbox) {
  const [gpu, setGpu] = useState(null); // {util, vram}
  const sandboxUid = sandbox?.sandbox_uid || null;
  const experimentId = sandbox?.experiment_id
    || (Array.isArray(sandbox?.active_experiment_ids) ? sandbox.active_experiment_ids[0] : null);
  useEffect(() => {
    if (!projectId || !sandbox || sandbox.status !== 'running') { setGpu(null); return undefined; }
    let cancelled = false;
    const sample = async () => {
      try {
        const res = await api.getSandboxMetrics(projectId, experimentId, { sandboxUid });
        if (cancelled) return;
        const gpus = Array.isArray(res?.metrics?.gpus) ? res.metrics.gpus : [];
        if (!res?.available || gpus.length === 0) { setGpu(null); return; }
        const util = gpus.reduce((m, g) => Math.max(m, g.util_pct ?? 0), 0);
        const withMem = gpus.filter(g => g.mem_total_mib);
        const vram = withMem.length
          ? Math.round(100 * withMem.reduce((a, g) => a + (g.mem_used_mib || 0), 0)
            / withMem.reduce((a, g) => a + g.mem_total_mib, 0))
          : null;
        setGpu({ util: Math.round(util), vram });
      } catch { /* live usage is best-effort */ }
    };
    sample();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') sample();
    }, METRICS_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectId, experimentId, sandboxUid, sandbox?.status]);
  return gpu;
}

/**
 * Home — the supervisor's instrument snapshot: what this project
 * IS (a clamped project.summary — the name's already in the app bar), a
 * one-line standing, a 24h snapshot band, what's live now with real GPU-util
 * telemetry, then a compact Needs-you. One Surface: hairlines
 * only at section breaks, the 3px orange index the sole rupture.
 */
export default function HomeScreen() {
  const px = useProjectHref();
  const project = useProjectStore(selectProject);
  const projectId = useProjectStore(s => s.projectId);
  const stats = useProjectStore(selectStats);
  const lastSyncError = useProjectStore(s => s.lastSyncError);
  const activeExperiments = useProjectStore(selectActiveExperiments);
  const reviewRequests = useProjectStore(selectReviewRequests);
  const sandboxes = useProjectStore(selectSandboxes);
  const experiments = useProjectStore(selectExperiments);
  const needsRef = useRef(null);
  const summaryRef = useRef(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Whether the clamped summary actually truncates — the toggle only
  // appears "if needed" (a short summary that already fits gets no button).
  const [summaryClamped, setSummaryClamped] = useState(false);
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el) { setSummaryClamped(false); return; }
    setSummaryClamped(el.scrollHeight > el.clientHeight + 1);
  }, [project?.summary]);

  // Half-minute tick keeps the standing line and elapsed times honest.
  const now = useNow();

  const running = sandboxes.filter(s => s.status === 'running');
  const liveSandbox = running[0] || null;
  const liveExp = activeExperiments.find(e => e.status === 'running')
    || (liveSandbox ? experiments.find(e => e.id === liveSandbox.experiment_id) : null)
    || null;
  const gpu = useLiveGpu(projectId, liveSandbox);
  // Compute spend from the generations ledger — refetched when the fleet
  // changes shape (the endpoint has no push signal; billing moves with the
  // clock, so the minute tick would over-fetch).
  const [spend] = useAsyncData(
    projectId ? () => api.getComputeCost(projectId) : null,
    [projectId, sandboxes.length, running.length],
  );

  // ── 24h snapshot band (derived client-side; approximate by design) ──
  const tiles = useMemo(() => {
    const in24 = experiments.filter(e => now - Date.parse(e.created_at || '') < DAY_MS).length;
    const prior24 = experiments.filter(e => {
      const age = now - Date.parse(e.created_at || '');
      return age >= DAY_MS && age < 2 * DAY_MS;
    }).length;
    return {
      exps24: in24,
      delta: in24 - prior24,
      gpuHours: gpuHours24(sandboxes, now),
      live: running.length,
      gpuLabel: liveSandbox?.gpu || null,
      reviews: stats.open_reviews ?? 0,
    };
  }, [experiments, sandboxes, running.length, liveSandbox, stats.open_reviews, now]);

  // ── Needs-you items, most urgent first (same derivation as before) ──
  const items = [];
  const expById = Object.fromEntries(experiments.map(e => [e.id, e]));
  for (const s of running) {
    if (!s.expires_at) continue;
    const left = Date.parse(s.expires_at) - now;
    if (Number.isFinite(left) && left <= SOON_MS) {
      const exp = expById[s.experiment_id];
      items.push({
        key: `sbx-${s.sandbox_uid || s.experiment_id}`,
        to: px('/sandboxes'),
        title: `Sandbox · ${exp ? expName(exp) : s.experiment_id || 'unassigned'}`,
        sub: `expiring ${left <= 0 ? 'now' : `in ${fmtDuration(left)}`} · release or extend`,
      });
    }
  }
  for (const e of activeExperiments) {
    if (!REVIEW_STATES.has(e.status)) continue;
    items.push({
      key: `rev-${e.id}`,
      to: px(`/experiments/${e.id}`),
      title: expName(e),
      sub: e.status === 'design_review'
        ? 'design review · approve the plan'
        : 'experiment review · read the outcome',
    });
  }
  for (const r of reviewRequests.filter(r => r.status === 'requested' || r.status === 'started')) {
    const exp = r.target_type === 'experiment' ? expById[r.target_id] : null;
    items.push({
      key: `req-${r.id}`,
      to: exp ? px(`/experiments/${exp.id}`) : px('/reviews'),
      title: exp ? expName(exp) : r.target_id,
      sub: `${(r.role || 'review').replace(/_/g, ' ')} · ${r.status}`,
    });
  }

  if (!project) {
    return <div className="page-stage"><div className="empty-state">Loading project…</div></div>;
  }

  const liveElapsed = liveSandbox?.requested_at
    ? now - Date.parse(liveSandbox.requested_at)
    : (liveExp?.updated_at ? now - Date.parse(liveExp.updated_at) : null);
  return (
    <div className="mhome">
      {lastSyncError && (
        <div className="mbanner">Backend unreachable — showing last known state. {lastSyncError}</div>
      )}

      {project.summary && (
        <div className="mhome-summary-wrap">
          <p
            ref={summaryRef}
            className={`mhome-summary${summaryOpen ? ' mhome-summary--open' : ''}`}
          >
            {project.summary}
            {summaryOpen && summaryClamped && (
              <button type="button" className="mhome-summary-less" onClick={() => setSummaryOpen(false)}>
                less
              </button>
            )}
          </p>
          {/* Overlaid, not appended: line-clamp truncates wherever the browser
              likes, so this fades over the last visible characters rather than
              trying to land a real inline link exactly at the cut. */}
          {!summaryOpen && summaryClamped && (
            <button type="button" className="mhome-summary-more" onClick={() => setSummaryOpen(true)}>
              … more
            </button>
          )}
        </div>
      )}

      <div className="mstand">
        <span className="mstand-date">{fmtStanding(new Date(now))}</span>
        {items.length > 0 && (
          <button
            type="button"
            className="mstand-need"
            onClick={() => needsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {items.length} need{items.length === 1 ? 's' : ''} you →
          </button>
        )}
      </div>

      <div className="mtiles">
        <div className="mtile">
          <div className="mtile-v tabular">
            {tiles.exps24}
            {tiles.delta > 0 && <span className="up">▲{tiles.delta}</span>}
            {tiles.delta < 0 && <span className="down">▼{-tiles.delta}</span>}
          </div>
          <div className="mtile-l">experiments · 24h</div>
        </div>
        <div className="mtile">
          <div className="mtile-v tabular">{tiles.gpuHours}<small>h</small></div>
          <div className="mtile-l">GPU compute · 24h</div>
        </div>
        <div className="mtile">
          <div className="mtile-v tabular">{tiles.live}</div>
          <div className="mtile-l">live now{tiles.gpuLabel ? ` · ${tiles.gpuLabel}` : ''}</div>
        </div>
        <div className="mtile">
          <div className="mtile-v tabular">{tiles.reviews}</div>
          <div className="mtile-l">reviews open</div>
        </div>
      </div>

      <div className="mml" style={{ marginTop: 20 }}>Live now</div>
      {liveExp ? (
        <Link to={px(`/experiments/${liveExp.id}`)} className="mlive">
          <div className="mlivehead">
            <div className="mlive-name">{expName(liveExp)}</div>
            <div className="mlive-sub">running{liveElapsed != null ? ` · ${fmtDuration(liveElapsed)}` : ''}</div>
          </div>
          {gpu && (
            <>
              <div className="mumeter"><i style={{ width: `${Math.min(100, gpu.util)}%` }} /></div>
              <div className="mumlab">
                <span>GPU {gpu.util}%{gpu.vram != null ? ` · VRAM ${gpu.vram}%` : ''}</span>
                {liveSandbox?.gpu && <span>{liveSandbox.gpu}</span>}
              </div>
            </>
          )}
        </Link>
      ) : (
        <div className="mquiet">nothing running</div>
      )}

      <div className="mbreak" />

      <div className="mml" ref={needsRef}>Needs you</div>
      {items.length === 0 ? (
        <div className="mquiet">nothing needs you</div>
      ) : (
        <>
          {items.slice(0, 2).map(it => (
            <Link key={it.key} to={it.to} className="mprow">
              <span className="mprow-ix" aria-hidden="true" />
              <span>
                <span className="mprow-t">{it.title}</span>
                <span className="mprow-s">{it.sub}</span>
              </span>
            </Link>
          ))}
          {items.length > 2 && (
            <Link to={px('/reviews')} className="mprow mprow--more">
              <span className="mprow-ix mprow-ix--faint" aria-hidden="true" />
              <span className="mprow-s">{items.length - 2} more →</span>
            </Link>
          )}
        </>
      )}

      {spend && spend.generations > 0 && (
        <>
          <div className="mbreak" />
          <div className="mml">Compute spend</div>
          <div className="mspend">
            <div className="mspend-head">
              <span className="mspend-total tabular">
                {spend.total_usd > 0 ? fmtUsd(spend.total_usd) : fmtHrs(spend.total_hours)}
              </span>
              {spend.open_generations > 0 && spend.burn_usd_per_hour > 0 && (
                <span className="mspend-burn">{fmtUsd(spend.burn_usd_per_hour)}/hr now</span>
              )}
            </div>
            <MiniBars daily={spend.daily} />
            <div className="mspend-sub">
              {fmtHrs(spend.total_hours)} across {spend.generations} generation{spend.generations === 1 ? '' : 's'}
              {spend.total_usd > 0 && spend.unpriced_hours > 0 && ` · ${fmtHrs(spend.unpriced_hours)} unpriced`}
              {spend.total_usd <= 0 && ' · no provider pricing'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Daily spend strip — sibling of MiniSpark, bars instead of a pulse line.
function MiniBars({ daily }) {
  const days = densifyDaily(daily);
  if (days.length < 2) return null;
  const priced = days.some(d => d.usd > 0);
  const vals = days.map(d => (priced ? d.usd : d.hours));
  const vmax = Math.max(...vals) || 1;
  return (
    <div className="mspend-bars" aria-hidden="true">
      {days.map((d, i) => (
        <span key={d.date} style={{ height: `${Math.max(4, (vals[i] / vmax) * 100)}%` }} />
      ))}
    </div>
  );
}
