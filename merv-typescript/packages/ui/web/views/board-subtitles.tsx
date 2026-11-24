/**
 * What a replay says, as a film's subtitles: a band in the middle of the foot of the board, the line
 * being read under the one before it, each with who said it in their colour. It shows only what the
 * timeline picked for the playhead (linesAt, board-timeline.ts) and keeps no clock of its own, so a
 * pause holds the words and a scrub finds them.
 */
import type { ReactNode } from 'react';
import { speakerOf, type Line } from './board-timeline';

export const SPEEDS = [0.25, 0.5, 1, 2, 4];
/** How fast a replay plays: a speed, or a long board squeezed into a quick overview. */
export type Pace = number | 'quick';
const PACE_KEY = 'board:replay-pace';
/** The pace this browser last chose. */
export const storedPace = (): Pace => {
  try {
    const kept = localStorage.getItem(PACE_KEY);
    if (kept === 'quick') return kept;
    return SPEEDS.includes(Number(kept)) ? Number(kept) : 1;
  } catch {
    return 1;
  }
};
export const storePace = (pace: Pace) => {
  try {
    localStorage.setItem(PACE_KEY, String(pace));
  } catch {
    // A browser that keeps nothing plays at the pace it was given for now.
  }
};

export function Subtitles({
  now,
  before,
  theme,
  person,
  children,
}: {
  now?: Line;
  before?: Line;
  theme: string;
  /** What to call the person who said a line. */
  person(line: Line): string;
  /** What the person is told of something they tried, over the words. */
  children?: ReactNode;
}) {
  return (
    <div className={`board-subtitles is-${theme}`}>
      {children}
      {(now || before) && (
        <div className="board-subtitle-lines" role="status">
          {[before, now].map((line) => {
            if (!line) return null;
            const { voice, name } = speakerOf(line, person(line));
            return (
              <p
                key={`${line.step}:${line.unit ?? ''}`}
                className={`board-subtitle${line === now ? '' : ' is-before'}`}
                data-voice={voice}
              >
                <span className="board-subtitle-who">{name}</span> {line.words}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
