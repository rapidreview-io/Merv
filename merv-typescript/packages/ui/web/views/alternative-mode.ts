import { useEffect, useState } from 'react';
import { useTool } from '../api';
import { alternativeSelected, type VoiceOptions } from './voice-preference';
// Stable persisted alpha-mode key, independent of the currently served upstream model.
export const ALTERNATIVE_MODEL = 'kimi-k3';
export function useAlternativeModeEnabled() {
  const options = useTool<VoiceOptions>('pi.voice.options');
  const [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh((n) => n + 1);
    addEventListener('merv:voice-preference', changed);
    addEventListener('storage', changed);
    return () => {
      removeEventListener('merv:voice-preference', changed);
      removeEventListener('storage', changed);
    };
  }, []);
  return !!options.data?.alternative && alternativeSelected(options.data);
}
