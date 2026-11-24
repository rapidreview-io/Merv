/**
 * A person's first visit to a project: one card over the page asking what they want to learn
 * (welcome.tsx, `LearnWelcome`). What they ask goes to the Agent in Merv's panel, which opens to
 * answer it once its conversation has begun. Seen once per person on this browser; Settings › Session shows it again.
 */
import { useEffect, useState } from 'react';
import { safely } from '../api';
import { askMerv } from './merv-panel';
import { LearnWelcome } from './welcome';

const AGAIN = 'merv:welcome';
/** Opens the welcome again, from wherever the person asks for it. */
export const showWelcome = () => window.dispatchEvent(new Event(AGAIN));

export function FirstRun({ who }: { who: string }) {
  const seen = `merv:welcome-seen:${who}`;
  const [open, setOpen] = useState(() => !safely(() => localStorage.getItem(seen), null));
  useEffect(() => {
    const again = () => setOpen(true);
    window.addEventListener(AGAIN, again);
    return () => window.removeEventListener(AGAIN, again);
  }, []);
  if (!open) return null;
  return (
    <LearnWelcome
      onDone={(ask) => {
        safely(() => localStorage.setItem(seen, new Date().toISOString()));
        setOpen(false);
        if (ask) askMerv(ask);
      }}
    />
  );
}
