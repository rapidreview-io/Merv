function shortId(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-5)}` : text;
}

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
    machine.runner_id ? `runner ${shortId(machine.runner_id)}` : '',
  ].filter(Boolean);

  return {
    active,
    machineName: machine.hostname || (reachable ? 'Unknown machine' : 'No runner paired'),
    machineDetails: details.join(' · '),
    project: active
      ? (projectMatches ? 'This project' : shortId(status?.project_id || 'Unknown project'))
      : '',
    projectMatches,
    reachable,
    state,
    tone,
  };
}
