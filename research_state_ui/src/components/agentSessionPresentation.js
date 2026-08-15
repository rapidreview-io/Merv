import { projectPath } from '../store/useProjectStore';
export { sessionOutcome } from './agentSessionOutcome.js';

export function isLiveSession(session) {
  return session?.status === 'offered' || session?.status === 'active';
}

export function assignmentFor(session) {
  const assignment = session?.assignment;
  if (assignment && typeof assignment === 'object') return assignment;
  return {
    title: session?.kind === 'review' ? 'Review work' : 'Run experiment',
    subtitle: 'Experiment',
    packet: {},
  };
}

export function friendlyPacket(session) {
  const packet = assignmentFor(session).packet;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return {};
  return Object.fromEntries(Object.entries(packet).filter(([key]) => (
    key !== 'id' && key !== 'instruction' && !key.endsWith('_id')
  )));
}

export function sessionAgent(session) {
  const setup = session?.agent_setup || {};
  const platform = String(setup.platform || session?.platform || 'Agent');
  const parts = [platform, setup.model, setup.effort].filter(Boolean);
  return parts.join(' · ');
}

export function sessionDurationMs(session, now = Date.now()) {
  const start = Date.parse(session?.activated_at || session?.created_at || '');
  const end = isLiveSession(session)
    ? now
    : Date.parse(session?.closed_at || session?.last_activity_at || '');
  if (!Number.isFinite(start)) return 0;
  return Math.max((Number.isFinite(end) ? end : now) - start, 0);
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(Math.floor(Number(milliseconds || 0) / 1000), 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function formatTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(count));
}

export function sessionDestination(projectId, session) {
  const navigation = assignmentFor(session).navigation || {};
  const targetId = String(navigation.target_id || '');
  if (!targetId) return null;
  if (navigation.type === 'experiment') {
    const section = navigation.section ? `#${navigation.section}` : '';
    return {
      label: 'Open experiment',
      to: projectPath(projectId, `/experiments/${targetId}${section}`),
    };
  }
  if (navigation.type === 'reflection') {
    return {
      label: 'Open reflection',
      to: projectPath(projectId, `/reflection/${targetId}`),
    };
  }
  const artifactId = String(navigation.artifact_id || '');
  return artifactId
    ? { label: 'Open artifact', to: projectPath(projectId, `/artifacts/${artifactId}`) }
    : null;
}
