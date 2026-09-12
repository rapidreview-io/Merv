import { useCallback, useRef, useState } from 'react';
import { useProjectStore } from './useProjectStore';

// Fire a transition through `apply(transition, evidence)`, then refetch the
// record and the home snapshot. `busy` holds the transitions in flight and
// `error` the last failure. Resolves true once the transition landed — even
// when only the follow-up refresh failed, since an irreversible edge must
// not be offered again; stream/poll reconciliation refreshes the page.
export function useWorkflowAction(apply, refetch) {
  const refreshHome = useProjectStore(s => s.refreshHome);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [busy, setBusy] = useState(new Set());
  const [error, setError] = useState(null);
  const act = useCallback(async (transition, evidence) => {
    setBusy(prev => new Set(prev).add(transition));
    setError(null);
    let applied = false;
    try {
      await applyRef.current(transition, evidence);
      applied = true;
      await Promise.all([refetch(), refreshHome()]);
      return true;
    } catch (err) {
      setError(`${transition}: ${err.message}`);
      return applied;
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(transition); return n; });
    }
  }, [refetch, refreshHome]);
  return { act, busy, error, setError };
}
