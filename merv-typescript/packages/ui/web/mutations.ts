import { useEffect, useRef, useState } from 'react';
import { ApiError, call, scopeVersion, useScopeVersion } from './api';

/** Keep the original command through an uncertain response, including refused retries. */
export function useCommand<T>(options: {
  tool: string;
  validate: (value: T) => boolean;
  onSuccess: (value: T) => void;
  conflictCode?: string;
  onConflict?: () => void;
}) {
  const epoch = useScopeVersion();
  const mounted = useRef(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  const uncertain = useRef(false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async (input: Record<string, unknown>) => {
    if (inFlight.current || epoch !== scopeVersion()) return;
    const current = () => mounted.current && epoch === scopeVersion();
    const command = pending.current ?? Object.freeze({ ...input, requestId: crypto.randomUUID() });
    pending.current = command;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await call<T>(options.tool, command);
      if (!options.validate(result))
        throw new ApiError('invalid_response', 'The server did not confirm the saved change.', 200);
      if (!current()) return;
      pending.current = null;
      uncertain.current = false;
      setRetry(false);
      options.onSuccess(result);
    } catch (failure) {
      if (!current()) return;
      uncertain.current ||=
        !(failure instanceof ApiError) ||
        failure.status === 0 ||
        failure.status >= 500 ||
        failure.code === 'invalid_response';
      setRetry(uncertain.current);
      if (!uncertain.current) pending.current = null;
      if (
        !uncertain.current &&
        failure instanceof ApiError &&
        failure.code === options.conflictCode
      ) {
        options.onConflict?.();
        return;
      }
      setError(
        uncertain.current
          ? `The original result is still unknown. ${failure instanceof Error ? failure.message : 'The request could not be confirmed.'} Retry the same request to confirm whether it was saved. Your submitted values are kept unchanged.`
          : failure instanceof Error
            ? failure.message
            : 'The change could not be saved.',
      );
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };
  return { submit, busy, retry, error, locked: busy || retry };
}
