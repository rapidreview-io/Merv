import { useMemo } from 'react';
import { api } from '../api';
import { useIntervalPoll, useRecordStatus } from './usePolling';

// A page's own list endpoint: fetched on arrival, re-polled every `pollMs`
// (0 = once), the last-good payload kept behind `error` when a poll fails.
// Returns `[data, error, refetch]`.
function useLedger(fetcher, deps, pollMs, key) {
  const [data, error, refetch] = useRecordStatus(fetcher, deps, key);
  useIntervalPoll(refetch, pollMs, { enabled: pollMs > 0 });
  return [data, error, refetch];
}

export const useReflectionLedger = (projectId, pollMs = 0) =>
  useLedger(() => api.getReflections(projectId), [projectId], pollMs, 'reflections');

// Pending rows are half-born (upload token outstanding); the list shows
// complete artifacts only. Returns `[data, error, artifacts]`.
export function useArtifactLedger(projectId, pollMs = 0) {
  const [data, error] = useLedger(() => api.listArtifacts(projectId), [projectId], pollMs, 'artifacts');
  const artifacts = useMemo(() => (data?.artifacts || []).filter(a => a.status === 'complete'), [data]);
  return [data, error, artifacts];
}
