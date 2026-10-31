/**
 * Talking with an agent from a board: the way to Pi from any board, and a line that appears only
 * while something is happening, naming who and what, which takes the view there when pressed.
 */
import { useEffect, useState } from 'react';
import { readOnly } from '../api';
import { useRoomy } from '../theme';
import { useAgent } from './pi';
import { docked } from './pi-dock';

/** How long the last ink still counts as drawing, and how long a line says when it was. */
const [DRAWING_MS, DREW_MS] = [1_500, 30_000];

export interface Doing {
  /** Who drew or looked last, and how long ago they drew; nothing yet when no agent has. */
  name?: string;
  drewMs?: number;
  /** Who is looking, if anyone. */
  looking?: string;
  /** What is held back while the person is in the middle of something. */
  waiting: number;
  /** Whether what an agent drew is still being played. */
  playing: boolean;
  /** Whether Pi is on a turn nothing else on the page says so of. */
  thinking: boolean;
}

/** The line for this moment, or nothing when nothing is happening. */
export function statusLine({
  name,
  drewMs = Infinity,
  looking,
  waiting,
  playing,
  thinking,
}: Doing) {
  if (waiting) return name ? `${waiting} waiting from ${name}` : `${waiting} waiting`;
  if (name && (playing || drewMs < DRAWING_MS)) return `${name} is drawing`;
  if (looking) return `${looking} is looking`;
  if (thinking) return 'Pi is thinking';
  if (name && drewMs < DREW_MS) return `${name} drew ${Math.round(drewMs / 1000)} s ago`;
  return null;
}

export function BoardTalk({
  doing,
  following,
  jump,
}: {
  doing(): Omit<Doing, 'thinking'>;
  following(): boolean;
  jump(): void;
}) {
  const agent = useAgent();
  const roomy = useRoomy();
  const [, beat] = useState(0);
  useEffect(() => {
    const beating = setInterval(() => beat((count) => count + 1), 500);
    return () => clearInterval(beating);
  }, []);
  const open = docked(agent, roomy);
  const line = statusLine({ ...doing(), thinking: !!agent?.pi?.active && !open });
  return (
    <>
      {line && (
        <button type="button" className="board-status" onClick={jump}>
          {line}
          {!following() && <span className="board-status-follow">Follow</span>}
        </button>
      )}
      {agent && !open && !readOnly() && (
        <button type="button" className="board-ask" onClick={agent.ask}>
          Ask Pi
        </button>
      )}
    </>
  );
}
