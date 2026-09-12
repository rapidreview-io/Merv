import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useIntervalPoll } from './usePolling';

const POLL_MS = 60000;

// Whether this backend serves /storage at all, asked once per project (the
// answer, or the one probe in flight). Unknown reads as supported until the
// first answer lands.
const supported = new Map();
const remember = (projectId, err) => supported.set(projectId, !err || err.status !== 404);

export function useStorageSupported(projectId) {
  const known = supported.get(projectId);
  const [ok, setOk] = useState(typeof known === 'boolean' ? known : true);
  useEffect(() => {
    if (!projectId) return;
    if (!supported.has(projectId)) {
      supported.set(projectId, api.listStorage(projectId).then(() => remember(projectId), err => remember(projectId, err)));
    }
    Promise.resolve(supported.get(projectId)).then(() => setOk(supported.get(projectId)));
  }, [projectId]);
  return ok;
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
      remember(projectId);
      setObjects(data?.objects || []);
      setUnsupported(false);
    } catch (err) {
      remember(projectId, err);
      if (err.status === 404) { setUnsupported(true); setObjects([]); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useIntervalPoll(reload, POLL_MS);

  return { objects, loading, error, unsupported, reload };
}
