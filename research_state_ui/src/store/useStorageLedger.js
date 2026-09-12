import { api } from '../api';
import { useAsyncData, useIntervalPoll, useRecordStatus } from './usePolling';

const POLL_MS = 60000;
const NONE = [];

// Whether this backend serves /storage at all, probed once per project.
// Unknown reads as supported until the first answer lands.
const probes = new Map();
export function useStorageSupported(projectId) {
  if (projectId && !probes.has(projectId)) {
    probes.set(projectId, api.listStorage(projectId).then(() => true, err => err.status !== 404));
  }
  const [known] = useAsyncData(projectId ? () => probes.get(projectId) : null, [projectId]);
  return known ?? true;
}

/**
 * Self-contained loader for the long-term storage ledger.
 *
 * Deliberately NOT part of the project store: storage is an architecturally
 * separate feature, so its page owns its own fetch and degrades gracefully when
 * the backend storage API isn't present yet (a 404 → `unsupported`, not an error
 * banner). Expired objects are always fetched — the page renders them as ghosts
 * instead of hiding them behind a filter. Re-polls quietly once a minute while
 * the tab is visible; there is no refresh chrome.
 */
export function useStorageLedger(projectId) {
  const [data, error, reload] = useRecordStatus(() => api.listStorage(projectId), [projectId]);
  useIntervalPoll(reload, POLL_MS);
  const unsupported = error?.status === 404;
  return {
    objects: (!unsupported && data?.objects) || NONE,
    loading: !data && !error,
    error: error && !unsupported ? error.message : null,
    unsupported,
    reload,
  };
}
