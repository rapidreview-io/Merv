export function sessionOutcome(session) {
  if (session?.status === 'active') return { label: 'Running', tone: 'live' };
  if (session?.status === 'offered') return { label: 'Starting', tone: 'starting' };
  const reason = String(session?.close_reason || '');
  if (reason === 'lease_expired' && !session?.activated_at) {
    return { label: 'Not started', tone: 'quiet' };
  }
  if (reason === 'dispatch_halted' || reason === 'runner_released') {
    return { label: 'Stopped', tone: 'quiet' };
  }
  if (reason === 'workspace_failed') return { label: 'Workspace failed', tone: 'error' };
  if (reason === 'launch_failed') return { label: 'Could not start', tone: 'error' };
  if (reason === 'host_process_crash_loop') return { label: 'Agent crashed', tone: 'error' };
  if (reason === 'lease_expired') return { label: 'Connection lost', tone: 'error' };
  if (reason === 'hard_deadline') return { label: 'Timed out', tone: 'error' };
  if (reason.includes('failed') || reason.includes('crash')) {
    return { label: 'Failed', tone: 'error' };
  }
  return { label: 'Completed', tone: 'complete' };
}
