// How one brain runner row reads on the Auto-run page. Pure: everything comes
// from what the runner itself reported on its last heartbeat and from the
// owner's saved settings; the browser never dials the machine.

export const RUNNER_LIVE_MS = 45_000;
export const RUNNER_STALE_MS = 5 * 60_000;

function systemName(value) {
  if (value === 'Darwin') return 'macOS';
  return value || '';
}

export function runnerPresentation(runner, now = Date.now()) {
  const machine = runner?.machine || {};
  const seenAt = Date.parse(runner?.last_seen_at || '');
  const age = Number.isFinite(seenAt) ? Math.max(now - seenAt, 0) : Number.POSITIVE_INFINITY;
  const live = runner?.live === true || age <= RUNNER_LIVE_MS;

  let state = 'Offline';
  let tone = 'error';
  if (!runner) {
    state = 'Not connected';
    tone = 'off';
  } else if (live) {
    state = 'Live';
    tone = 'live';
  } else if (age <= RUNNER_STALE_MS) {
    state = 'Stale';
    tone = 'warning';
  }

  const inventory = runner?.inventory || {};
  const desired = Number(runner?.desired_version || 0);
  const applied = Number(runner?.applied_version || 0);
  const settingsError = String(inventory.settings_error || '');
  const pendingReason = String(inventory.pending?.reason || '');
  let settings = '';
  let settingsTone = '';
  if (runner && settingsError) {
    settings = `Settings rejected: ${settingsError}`;
    settingsTone = 'error';
  } else if (runner && desired > applied) {
    settings = pendingReason
      ? `Settings pending — ${pendingReason}`
      : (live ? 'Settings pending' : 'Settings pending — applies when the runner reconnects');
    settingsTone = 'warning';
  }

  return {
    live,
    state,
    tone,
    machineName: machine.hostname || 'Runner',
    machineDetails: [systemName(machine.system), machine.architecture].filter(Boolean).join(' · '),
    settings,
    settingsTone,
    ageMs: Number.isFinite(age) ? age : null,
  };
}
