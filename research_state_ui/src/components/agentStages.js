// The setup ladder for one agent on one machine, as stages with a state each:
// installed → signed in → Merv skills → test call. Pure over what the runner
// reported (harness readiness: static probe + evidence + last test call), so
// the drawer can show what is being tested and what has held so far.
//
// States: 'ok' (green, done) · 'running' (amber, in progress) · 'fail' (red,
// with the fix in words) · 'unknown' (neutral: not proven either way) ·
// 'pending' (not reached yet).

const AUTH_STATUS_LABEL = {
  present: 'signal found',
  unknown: 'not proven yet',
  'n/a': 'not applicable',
};

function ago(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * @param {object} args
 * @param {object|null} args.entry       harness.platforms[name] from the runner
 * @param {object} args.readiness        readinessFor() result (tag/tone/details/problems)
 * @param {boolean} args.enabled         the draft's enabled flag
 * @param {number} args.now
 * @returns {Array<{key:string,label:string,state:string,detail:string,hint?:string}>}
 */
export function agentStages({ entry = null, readiness, enabled = true, now = Date.now() }) {
  const stages = [];
  const missing = readiness?.tone === 'missing';

  // 1. Installed — the executable resolved on the machine, or the runner
  // said why not ("'gemini' is not on PATH"). Only presence proves it.
  const staticProblems = Array.isArray(entry?.problems) ? entry.problems.filter(Boolean) : [];
  const notInstalled = missing || (entry && !entry.executable);
  if (notInstalled) {
    stages.push({ key: 'installed', label: 'Installed', state: 'fail', detail: staticProblems[0] || readiness?.problems?.[0] || 'not found on this machine' });
  } else if (entry?.executable) {
    const bits = [entry.version ? `v${String(entry.version).replace(/^v/i, '')}` : '', entry.executable].filter(Boolean);
    stages.push({ key: 'installed', label: 'Installed', state: 'ok', detail: bits.join(' · ') });
  } else if (readiness?.tone === 'ok') {
    stages.push({ key: 'installed', label: 'Installed', state: 'ok', detail: 'found on the machine' });
  } else {
    stages.push({ key: 'installed', label: 'Installed', state: 'unknown', detail: 'the machine has not reported yet' });
  }

  // 2. Signed in to the provider. A passed test call is the strongest proof
  // (credentials may live where no signal is looked for, e.g. a keychain).
  const auth = entry?.auth || null;
  const smokeOk = entry?.smoke?.status === 'ok';
  if (auth?.status === 'failed') {
    stages.push({ key: 'auth', label: 'Signed in', state: 'fail', detail: auth.line || 'the provider refused', hint: auth.detail || '' });
  } else if (smokeOk) {
    stages.push({ key: 'auth', label: 'Signed in', state: 'ok', detail: auth?.status === 'present' && auth.via ? `proven by the test call · signal: ${auth.via}` : 'proven by the test call' });
  } else if (auth?.status === 'present') {
    stages.push({ key: 'auth', label: 'Signed in', state: 'ok', detail: auth.via ? `signal: ${auth.via}` : AUTH_STATUS_LABEL.present });
  } else if (auth?.status === 'n/a') {
    stages.push({ key: 'auth', label: 'Signed in', state: 'ok', detail: 'not needed for a custom command' });
  } else if (notInstalled) {
    stages.push({ key: 'auth', label: 'Signed in', state: 'pending', detail: '' });
  } else {
    stages.push({ key: 'auth', label: 'Signed in', state: 'unknown', detail: 'no sign-in signal found — the test call will tell' });
  }
  if (entry?.quota?.status === 'failed') {
    stages.push({ key: 'quota', label: 'Provider quota', state: 'fail', detail: entry.quota.line || 'refused', hint: entry.quota.detail || '' });
  }

  // 3. Merv skills / MCP — judged from the machine's own static probe
  // (entry.problems), never from sign-in evidence, which has its own rung.
  if (notInstalled) {
    stages.push({ key: 'skills', label: 'Merv skills', state: 'pending', detail: '' });
  } else if (entry && entry.ok === false && staticProblems.length) {
    stages.push({ key: 'skills', label: 'Merv skills', state: 'fail', detail: staticProblems[0] });
  } else if (entry) {
    const how = entry.skills === 'mounted' ? 'mounted' : entry.skills === 'instruction' ? 'by instruction' : '';
    const mcp = entry.merv_mcp === 'native' ? 'MCP native' : entry.merv_mcp === 'merv-client' ? 'MCP via merv-client' : '';
    stages.push({ key: 'skills', label: 'Merv skills', state: 'ok', detail: [how, mcp].filter(Boolean).join(' · ') });
  } else {
    stages.push({ key: 'skills', label: 'Merv skills', state: 'unknown', detail: '' });
  }

  // 4. Test call
  const smoke = entry?.smoke || null;
  if (smoke?.status === 'running') {
    stages.push({ key: 'smoke', label: 'Test call', state: 'running', detail: `running${smoke.why ? ` (${smoke.why})` : ''}…` });
  } else if (smoke?.status === 'queued') {
    stages.push({ key: 'smoke', label: 'Test call', state: 'running', detail: 'queued on the machine…' });
  } else if (smoke?.status === 'ok') {
    const secs = smoke.duration_ms ? ` in ${(smoke.duration_ms / 1000).toFixed(1)} s` : '';
    stages.push({ key: 'smoke', label: 'Test call', state: 'ok', detail: `passed ${ago(smoke.at, now)}${secs}` });
  } else if (smoke?.status === 'failed') {
    stages.push({ key: 'smoke', label: 'Test call', state: 'fail', detail: `failed ${ago(smoke.at, now)}`, hint: smoke.detail || '' });
  } else if (notInstalled || !enabled) {
    stages.push({ key: 'smoke', label: 'Test call', state: 'pending', detail: enabled ? '' : 'enable the agent to test it' });
  } else {
    stages.push({ key: 'smoke', label: 'Test call', state: 'unknown', detail: 'not run yet' });
  }
  return stages;
}

/** One word for the whole ladder: fail > running > unknown > ok. */
export function stagesSummary(stages) {
  if (stages.some((stage) => stage.state === 'fail')) return 'fail';
  if (stages.some((stage) => stage.state === 'running')) return 'running';
  if (stages.some((stage) => stage.state === 'unknown' || stage.state === 'pending')) return 'unknown';
  return 'ok';
}
