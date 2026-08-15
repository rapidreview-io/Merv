function systemName(value) {
  if (value === 'Darwin') return 'macOS';
  return value || '';
}

export function runnerPresentation({ connection, status, projectId }) {
  const reachable = connection === 'connected' || connection === 'applying';
  const remembered = Boolean(status);
  const active = reachable && status?.runner_active === true;
  const projectMatches = active && String(status?.project_id || '') === String(projectId || '');
  const machine = status?.machine || {};

  let state = 'Not connected';
  let tone = 'off';
  if (connection === 'connecting') {
    state = 'Connecting';
    tone = 'checking';
  } else if (connection === 'unreachable' && remembered) {
    state = 'Offline';
    tone = 'error';
  } else if (active && projectMatches) {
    state = 'Live';
    tone = 'live';
  } else if (active) {
    state = 'Wrong project';
    tone = 'warning';
  } else if (reachable) {
    state = 'Paired · stopped';
    tone = 'warning';
  }

  const details = [
    systemName(machine.system),
    machine.architecture,
  ].filter(Boolean);

  return {
    active,
    machineName: machine.hostname || 'Runner',
    machineDetails: details.join(' · '),
    project: active && !projectMatches ? 'Different project' : '',
    projectMatches,
    reachable,
    state,
    tone,
  };
}
