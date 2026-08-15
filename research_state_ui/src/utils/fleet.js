// Fleet liveness: read one /sandboxes row the way a watcher does.
//
// Every field here is already on the row (the command snapshot from the last
// transcript read, the usage series from the control-plane heartbeat sweep), so
// a whole fleet renders live without attaching a terminal to anything. Pure and
// dependency-light on purpose — the desktop table and the mobile card share
// these rules rather than each inventing their own.

// Explicit extension: these rules are covered by `node --test`, which does not
// do Vite's extensionless resolution.
import { fmtDuration } from './format.js';

// Tones are behavioural, not lifecycle: a "running" box can be working, idle,
// or sitting on a failure, and those are three different things to a watcher.
export const FLEET_TONES = ['work', 'fail', 'idle', 'quiet'];

/**
 * What this box is doing right now, in the order a watcher cares about:
 * work in flight, then a failure worth acting on, then idle (money burning),
 * then quiet. Returns null when the row has nothing live to say.
 */
export function fleetActivity(sandbox, now = Date.now()) {
  const s = sandbox || {};
  const command = s.last_command || null;
  const heartbeat = s.heartbeat || null;
  // A control plane that predates the liveness projection omits these keys
  // entirely, rather than sending them empty. Say nothing in that case — the UI
  // ships separately from the backend, and claiming a busy box "has no commands
  // yet" would be worse than showing no liveness line at all.
  if (!('heartbeat' in s) && !('last_command' in s)) return null;
  if (s.status !== 'running') {
    // A finished box still answers "what did it last run" — the bars are gone
    // but the verdict is the reason you'd look at a terminated row at all.
    if (!command) return null;
    return { tone: 'quiet', label: 'last', detail: exitLabel(command) || '—' };
  }

  const started = command?.started_at ? Date.parse(command.started_at) : NaN;
  if (command?.status === 'running') {
    return {
      tone: 'work',
      label: 'running',
      detail: Number.isFinite(started) ? fmtDuration(now - started) : null,
    };
  }

  const idleSince = heartbeat?.idle_since ? Date.parse(heartbeat.idle_since) : NaN;
  const failed = command && command.exit_code != null && command.exit_code !== 0;
  if (failed) {
    return { tone: 'fail', label: 'failed', detail: exitLabel(command) };
  }
  if (Number.isFinite(idleSince)) {
    return {
      tone: 'idle',
      label: `idle ${fmtDuration(now - idleSince)}`,
      detail: exitLabel(command),
    };
  }
  if (!command) return { tone: 'quiet', label: 'no commands yet', detail: null };
  return { tone: 'quiet', label: 'done', detail: exitLabel(command) };
}

/**
 * The four utilization gauges in their fixed reading order. Each bar carries
 * its slot so a CPU-only box leaves the GPU / VRAM slots empty rather than
 * sliding RAM into them — the same metric sits in the same place down a table.
 */
export const USAGE_SLOTS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'RAM' },
  { key: 'gpu', label: 'GPU' },
  { key: 'vram', label: 'VRAM' },
];

/**
 * Utilization bars in reading order — CPU, RAM, GPU, VRAM — for whatever the
 * box actually reported. A metric the sampler couldn't read is omitted rather
 * than drawn at zero — a blank is honest, a zero bar reads as an idle box.
 */
export function usageBars(latest) {
  if (!latest) return [];
  return USAGE_SLOTS.flatMap(({ key, label }, slot) => (
    Number.isFinite(latest[key]) ? [{ key, label, slot, pct: latest[key] }] : []
  ));
}

/**
 * The bar the trend follows: the GPU when a card is reporting (that is what a
 * GPU box is for), else the first bar there is. Null when nothing was read.
 */
export function usageLead(bars) {
  const list = bars || [];
  return list.find(bar => bar.key === 'gpu') || list[0] || null;
}

/**
 * The trend series for one metric key. The row tracks its lead bar (see
 * `usageLead`), so the line always has a stated subject rather than being an
 * unlabelled squiggle.
 */
export function usageTrend(series, key) {
  if (!key) return [];
  return (series || [])
    .map(point => (point == null ? null : point[key]))
    .filter(value => Number.isFinite(value));
}

// Human names for the provider ids the control plane stores on a row (the
// backend's capabilities.name). Unknown ids fall back to a readable form of the
// id itself so a new provider never renders as a blank.
const PROVIDER_LABELS = {
  lambda_labs: 'Lambda Labs',
  thunder_compute: 'Thunder Compute',
  hyperstack: 'Hyperstack',
  digitalocean: 'DigitalOcean',
  verda: 'Verda',
  voltage_park: 'Voltage Park',
  tensordock: 'TensorDock',
  aws: 'AWS',
  gcp: 'GCP',
  azure: 'Azure',
  modal: 'Modal',
  fake: 'Fake',
  local: 'Local',
};

export function providerLabel(provider) {
  const key = String(provider || '').trim();
  if (!key) return '';
  return PROVIDER_LABELS[key] || key.replace(/_/g, ' ');
}

// Cards that ship in exactly one memory configuration, so naming the model
// names the VRAM. Deliberately excludes A100 (40/80), H100 (80/94) and V100
// (16/32): for those the row must hear it from the box (heartbeat.gpus) or
// from the label itself ("A100 80GB"), never guess.
const NOMINAL_VRAM_GB = {
  A10: 24, A10G: 24, A30: 24, A40: 48, L4: 24, L40: 48, L40S: 48, T4: 16,
  RTX4090: 24, RTX3090: 24, RTXA6000: 48, RTX6000ADA: 48, H200: 141,
};

/**
 * Per-card VRAM in GB, or null when nothing on the row can say. Sources in
 * order of trust: the live sample (nvidia-smi's total), a size written into
 * the label ("A100 80GB"), then the single-configuration table above.
 */
export function gpuVramGb(sandbox) {
  const s = sandbox || {};
  const live = s.heartbeat?.gpus?.vram_mib;
  if (Number.isFinite(live) && live > 0) return Math.round(live / 1024);
  const label = String(s.gpu || '');
  const inLabel = label.match(/(\d+)\s*GB/i);
  if (inLabel) return Number(inLabel[1]);
  const key = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return NOMINAL_VRAM_GB[key] ?? null;
}

/**
 * How many cards, or null when unknown. The live sample knows; failing that a
 * Lambda-style SKU ("gpu_8x_h100_sxm5") says so in its name.
 */
export function gpuCount(sandbox) {
  const s = sandbox || {};
  const live = s.heartbeat?.gpus?.count;
  if (Number.isFinite(live) && live > 0) return live;
  const sku = String(s.instance_type || '').match(/(?:^|[_-])(\d+)x(?:[_-]|$)/i);
  return sku ? Number(sku[1]) : null;
}

/**
 * The GPU as one phrase: "2× A100 · 80 GB VRAM", "A10 · 24 GB VRAM", "L4",
 * or "" for a CPU-only box. The label is stripped of any size already in it so
 * "A100 80GB" does not read "A100 80GB · 80 GB VRAM".
 */
export function gpuLabel(sandbox) {
  const s = sandbox || {};
  const model = String(s.gpu || '').replace(/\s*\d+\s*GB\b/i, '').trim();
  if (!model) return '';
  const count = gpuCount(s);
  const vram = gpuVramGb(s);
  return [
    `${count > 1 ? `${count}× ` : ''}${model}`,
    vram ? `${vram} GB VRAM` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The machine, in one line: "A10 · 24 GB VRAM · 30 cpu · 200 GiB RAM". Empty
 * when the row carries none of it (a provisioning row before the backend
 * reports back).
 */
export function hardwareLabel(sandbox) {
  const s = sandbox || {};
  return [
    gpuLabel(s),
    s.cpu && `${s.cpu} cpu`,
    s.memory && `${Math.round(s.memory / 1024)} GiB RAM`,
  ].filter(Boolean).join(' · ');
}

/**
 * The liveness line's opening phrase — what the last command is doing and,
 * once it has finished, how long ago: "running · 8m", "idle 22m · exit 0",
 * "failed · exit 1 · 11m ago", "exit 0 · 3h ago", "no commands yet". Idle
 * already carries its clock (idle-since ≈ command-finished), so it does not
 * repeat one as "ago".
 */
export function commandStatus(sandbox, activity, now = Date.now()) {
  if (!activity) return '';
  const command = (sandbox || {}).last_command || null;
  const finished = command?.finished_at ? Date.parse(command.finished_at) : NaN;
  const ago = Number.isFinite(finished) && now >= finished ? `${fmtDuration(now - finished)} ago` : null;
  switch (activity.tone) {
    case 'work':
      return ['running', activity.detail].filter(Boolean).join(' · ');
    case 'idle':
      return [activity.label, activity.detail].filter(Boolean).join(' · ');
    case 'fail':
      return ['failed', activity.detail, ago].filter(Boolean).join(' · ');
    default:
      // A quiet box's verb ("last", "done") adds nothing next to the exit code
      // and its clock; only the no-command case has to say so in words.
      if (!command) return activity.label;
      return [activity.detail, ago].filter(Boolean).join(' · ') || activity.label;
  }
}

/**
 * A command as a fleet row can show it: the leading `cd <dir> &&` hops the
 * agent prefixes to nearly everything are dropped (the row is too narrow to
 * spend on a path it already knows) and whitespace collapses to one line. The
 * full text still travels in the cell's title and in the drawer's transcript.
 */
export function commandGist(command) {
  let text = String(command || '').replace(/\s+/g, ' ').trim();
  const hop = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/;
  while (hop.test(text)) text = text.replace(hop, '');
  return text;
}

function exitLabel(command) {
  if (!command || command.exit_code == null) return null;
  return `exit ${command.exit_code}`;
}
