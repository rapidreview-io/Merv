import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjectHref } from '../store/useProjectStore';
import ProviderIcon from './ProviderIcon';
import SandboxTerminal from './SandboxTerminal';
import StatusPill from './StatusPill';
import { expName } from '../utils/experiment';
import { fmtDuration } from '../utils/format';
import { PARACHUTE_CHIPS, latestParachute } from '../utils/parachute';
import {
  commandGist,
  commandStatus,
  fleetActivity,
  gpuLabel,
  hardwareLabel,
  providerLabel,
  usageBars,
} from '../utils/fleet';

// Column template (chevron · status · experiment · hardware · uptime · expires
// · links) lives in CSS as --sbxt-cols so the head, every identity line AND
// every liveness line share one source of truth and stay aligned.

const rank = (st) => (st === 'running' ? 0 : st === 'provisioning' ? 1 : 2);
const sandboxRowId = (s) => s.sandbox_uid || s.sandbox_id || s.experiment_id;
const primaryExperimentId = (s) => (
  s.experiment_id
  || (Array.isArray(s.active_experiment_ids) ? s.active_experiment_ids[0] : '')
  || ''
);

/**
 * SandboxTable — the compute fleet as an infra table.
 *
 * One row per sandbox; experiment relationships come from the attachments
 * ledger. Status, hardware and lifetime stay per row, with an expand-to-
 * terminal drawer (the live terminal UI is unchanged — see SandboxTerminal;
 * the SSH endpoint lives there, not on the row). Shared between the Sandboxes
 * index (full fleet, with its own status-filter tabs) and Home (current
 * project at a glance) so both surfaces render the identical row UI over the
 * same /sandboxes payload.
 *
 * Every row is two lines on one grid. The identity line answers "which box":
 * status, experiment, the machine (provider mark, GPU with its VRAM, cpu, RAM,
 * SKU and region), uptime, expiry. The liveness line underneath answers "doing
 * what, how hard": the last command with its clock spans the Status and
 * Experiment columns, and the CPU · RAM · GPU · VRAM gauges take the rest.
 * That second line costs no extra request: the control-plane heartbeat sweep
 * already samples every running box, and /sandboxes projects the result (see
 * `_live_snapshot`). The drawer stays the detail tier, for when the transcript
 * is the answer.
 *
 * Rows are sorted running → provisioning → terminated, then newest first; the
 * caller passes whatever subset it wants shown. Live uptime / "expires in"
 * labels tick at 1Hz only while something is actually running.
 */
export default function SandboxTable({ sandboxes, experiments, events, projectId, empty = null }) {
  const [expanded, setExpanded] = useState(null);
  const [now, setNow] = useState(Date.now());

  const rows = useMemo(() => (
    (sandboxes || []).slice().sort((a, b) => {
      const ar = rank(a.status);
      const br = rank(b.status);
      if (ar !== br) return ar - br;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    })
  ), [sandboxes]);

  const anyLive = rows.some(s => s.status === 'running' || s.status === 'provisioning');
  useEffect(() => {
    if (!anyLive) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const expById = useMemo(
    () => Object.fromEntries((experiments || []).map(e => [e.id, e])),
    [experiments],
  );

  if (rows.length === 0) return empty;

  return (
    <div className="sbxt-scroll">
      <div className="sbxt">
        <div className="sbxt-head con-head">
          <span aria-hidden="true" />
          <span className="th th--con">Status</span>
          <span className="th th--con">Experiment</span>
          <span className="th th--con">Hardware</span>
          <span className="th th--con th--r">Uptime</span>
          <span className="th th--con th--r">Expires</span>
          <span className="th th--con th--r">Links</span>
        </div>
        {rows.map(s => {
          const rowId = sandboxRowId(s);
          const experimentId = primaryExperimentId(s);
          return (
            <SandboxRow
              key={rowId}
              sandbox={s}
              experiment={expById[experimentId]}
              experimentId={experimentId}
              projectId={projectId}
              now={now}
              parachute={latestParachute(events, experimentId, s.sandbox_id)}
              open={expanded === rowId}
              onToggle={() => setExpanded(expanded === rowId ? null : rowId)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SandboxRow({ sandbox, experiment, experimentId, projectId, now, parachute, open, onToggle }) {
  const px = useProjectHref();
  const s = sandbox;
  const live = s.status === 'running';
  const chip = parachute ? PARACHUTE_CHIPS[parachute] : null;
  const title = experiment ? expName(experiment) : experimentId || s.sandbox_uid || s.sandbox_id;

  const expiresMs = live && s.expires_at ? Date.parse(s.expires_at) - now : null;
  const expiresCls = expiresMs == null ? '' : expiresMs < 120000 ? ' sbxt-warn--hot' : expiresMs < 600000 ? ' sbxt-warn' : '';

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  const activity = fleetActivity(s, now) || provisioningActivity(s);

  return (
    <div className={`sbxt-rowgroup${open ? ' open' : ''}`}>
      <div
        className="sbxt-rowhead"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKey}
      >
        <div className="sbxt-row">
          <span className={`twist${open ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span className="sbxt-status">
            <span className={`sbxt-dot sbxt-dot--${s.status}`} />
            <span className="sbxt-status-label">{s.status}</span>
            {chip && <span className={`parachute-chip parachute-chip--${chip.variant}`}>{chip.short}</span>}
          </span>
          <span className="sbxt-exp">
            <span className="sbxt-exp-title">{title}</span>
          </span>
          <SandboxMachine sandbox={s} />
          <span className="sbxt-num" title="Uptime">
            {live && s.requested_at ? fmtDuration(now - Date.parse(s.requested_at)) : <span className="sbxt-none">—</span>}
          </span>
          <span className={`sbxt-num${expiresCls}`} title="Expires in">
            {expiresMs == null ? <span className="sbxt-none">—</span> : fmtDuration(Math.max(0, expiresMs))}
          </span>
          <span className="sbxt-links" onClick={(e) => e.stopPropagation()}>
            {experimentId && (
              <Link to={px(`/experiments/${experimentId}#execution`)} className="sbxt-link">open ↗</Link>
            )}
          </span>
        </div>
        {activity && <SandboxLiveStrip activity={activity} sandbox={s} now={now} />}
      </div>
      {open && (
        <div className="sbxt-drawer">
          <SandboxDrawerBar title={title} experiment={experiment} experimentId={experimentId} />
          <SandboxTerminal projectId={projectId} experimentId={experimentId} sandboxUid={s.sandbox_uid} />
        </div>
      )}
    </div>
  );
}

/**
 * The Hardware cell — everything the row knows about the machine, in the order
 * you would ask: whose (provider mark), which card (model, count, VRAM), how
 * big (cpu, RAM), then the SKU and datacenter underneath in a quieter voice.
 * The GPU phrase leads in the text colour because it is what the box was
 * procured for; the tooltip carries the long form (provider name, nvidia-smi's
 * card name) for the hover.
 */
function SandboxMachine({ sandbox: s }) {
  const provider = providerLabel(s.provider);
  const gpu = gpuLabel(s);
  const size = [
    s.cpu && `${s.cpu} cpu`,
    s.memory && `${Math.round(s.memory / 1024)} GiB RAM`,
  ].filter(Boolean).join(' · ');
  const sku = [s.instance_type, s.region].filter(Boolean).join(' · ');
  const title = [provider, hardwareLabel(s), s.heartbeat?.gpus?.name, sku].filter(Boolean).join(' · ');
  return (
    <span className="sbxt-hw" title={title}>
      <span className="sbxt-hw-spec">
        {s.provider && (
          <span className="sbxt-hw-provider" aria-label={provider}>
            <ProviderIcon provider={s.provider} size={16} inset={4} />
          </span>
        )}
        <span className="sbxt-hw-text mono">
          {gpu && <span className="sbxt-hw-gpu">{gpu}</span>}
          {gpu && size ? <span className="sbxt-hw-sep"> · </span> : null}
          {size}
          {!gpu && !size && <span className="sbxt-none">—</span>}
        </span>
      </span>
      {sku && <span className="sbxt-hw-sku mono">{sku}</span>}
    </span>
  );
}

// A provisioning box has no command to report yet, but it does have a phase
// ("starting", "connecting"…) and a detail line — the same slot the activity
// state uses, so a booting box says what it is doing instead of going quiet.
function provisioningActivity(s) {
  if (s.status !== 'provisioning') return null;
  return { tone: 'idle', label: s.phase || 'starting', detail: s.detail || null, provisioning: true };
}

/**
 * The row's liveness line, on the same grid as the identity line above it.
 * The last command spans the Status and Experiment columns — the command's
 * gist first, then its clock pinned to the right edge of that span so the
 * "running · 8m" / "exit 0 · 3h ago" phrases line up down the table — and the
 * CPU · RAM · GPU · VRAM gauges take everything from Hardware to the edge.
 */
function SandboxLiveStrip({ activity, sandbox, now }) {
  const heartbeat = sandbox.heartbeat || null;
  const command = sandbox.last_command?.command || '';
  const gist = commandGist(command);
  const bars = usageBars(heartbeat?.latest);
  const status = activity.provisioning
    ? activity.label
    : commandStatus(sandbox, activity, now);

  return (
    <div className={`sbxt-live sbxt-live--${activity.tone}`}>
      <span className="sbxt-live-cmdline">
        {activity.provisioning ? (
          <>
            <span className="sbxt-live-state">{status}</span>
            <span className="sbxt-live-note">{activity.detail || 'setting up…'}</span>
          </>
        ) : gist ? (
          <>
            <span className="sbxt-live-prompt" aria-hidden="true">$</span>
            <span className="sbxt-live-cmd mono" title={command}>{gist}</span>
            <span className="sbxt-live-state sbxt-live-state--end">{status}</span>
          </>
        ) : (
          <span className="sbxt-live-state">{status}</span>
        )}
      </span>
      {/* Always rendered, even empty: a terminated row holding its column keeps
          the fleet scannable down the table. Each gauge sits in its own slot
          (CPU · RAM · GPU · VRAM) so the same metric aligns down the fleet. */}
      <span className="sbxt-live-gauges">
        {bars.map(bar => <SandboxGauge key={bar.key} label={bar.label} pct={bar.pct} slot={bar.slot} />)}
      </span>
    </div>
  );
}

function SandboxGauge({ label, pct, slot }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="sbxt-gauge" style={{ gridColumn: slot + 1 }}>
      <span className="sbxt-gauge-label">{label}</span>
      <span className="sbxt-gauge-val">{Math.round(pct)}%</span>
      <span className="sbxt-gauge-track">
        <span className="sbxt-gauge-fill" style={{ width: `${clamped}%` }} />
      </span>
    </span>
  );
}

/**
 * The drawer's first line: which experiment this box serves. The name is the
 * link — the row above only toggles the drawer, so the jump to the experiment
 * lives here, where a click can mean exactly one thing. The box's own facts
 * (id, provider, resources, ssh) are the terminal panel's meta rows just below.
 */
function SandboxDrawerBar({ title, experiment, experimentId }) {
  const px = useProjectHref();
  return (
    <div className="sbxt-drawer-bar">
      <span className="sbxt-drawer-exp">
        <span className="sbxt-drawer-key">experiment</span>
        {experimentId ? (
          <Link to={px(`/experiments/${experimentId}`)} className="sbxt-drawer-link" title="Open experiment">
            {title}
            <span className="sbxt-drawer-arrow" aria-hidden="true">→</span>
          </Link>
        ) : (
          <span className="sbxt-drawer-title">{title}</span>
        )}
        {experiment?.status && <StatusPill value={experiment.status} />}
      </span>
    </div>
  );
}
