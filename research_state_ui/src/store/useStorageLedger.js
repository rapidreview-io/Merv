import { useCallback, useState } from 'react';
import { api } from '../api';
import { useAsyncData, useIntervalPoll } from './usePolling';

const POLL_MS = 60000;

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
  const [objects, setObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unsupported, setUnsupported] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const data = await api.listStorage(projectId);
      setObjects(data?.objects || []);
      setUnsupported(false);
    } catch (err) {
      if (err.status === 404) { setUnsupported(true); setObjects([]); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useIntervalPoll(reload, POLL_MS);

  return { objects, loading, error, unsupported, reload };
}
