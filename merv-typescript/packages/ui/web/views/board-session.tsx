/**
 * A Claude Code session attached to this board, as a line that keeps moving: the run along time, as
 * a transcript's overview draws it, and what it is doing now. Kept only in this page, as the server
 * keeps it only in memory; Pin alone turns it into marks on the board.
 */
import { useCallback, useRef, useState } from 'react';
import type { AttachedSession, AttachedStep, BoardAttached } from '@merv/board/models';
import { FORMAT, overview, type Transcript } from '@merv/board/transcript';
import { call } from '../api';

export interface LiveSession extends AttachedSession {
  steps: AttachedStep[];
}

/** What the page has been told of sessions here, merged as each answer comes. */
export function useAttached() {
  const seq = useRef(0);
  const steps = useRef(new Map<string, AttachedStep>());
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const heard = useCallback((told: BoardAttached) => {
    seq.current = told.seq;
    for (const step of told.steps) steps.current.set(`${step.session}:${step.id}`, step);
    setSessions(
      told.sessions.map((session) => ({
        ...session,
        steps: [...steps.current.values()].filter((step) => step.session === session.id),
      })),
    );
  }, []);
  return { sessions, heard, seq: useCallback(() => seq.current, []) };
}

const along = (steps: AttachedStep[]) => {
  const transcript: Transcript = {
    format: FORMAT,
    source: 'claude-code',
    versions: [],
    steps,
    gaps: { hiddenReasoning: 0, notRead: {}, unreadable: 0, orphanResults: 0 },
    redacted: {},
  };
  return overview(transcript).along as {
    pace?: string;
    marks: { x: number; kind: string; said?: string; tool?: string }[];
  };
};

/** Only because the person pressed it: the run, as a stroke and its turning points. */
const pin = async (board: string, { name, steps }: LiveSession) => {
  const { pace, marks } = along(steps);
  const calls = steps.filter((step) => step.kind === 'call').length;
  const turns = marks.flatMap(({ kind, said, tool }) =>
    kind === 'person' || kind === 'failure' ? [`${kind === 'failure' ? tool : '›'} ${said}`] : [],
  );
  await call('board.write', {
    action: 'draw',
    draw: {
      board,
      ops: [
        { op: 'text', key: 'run', text: `${name}: ${calls} calls`, size: 'm' },
        ...(pace
          ? [
              {
                op: 'sketch',
                key: 'pace',
                near: 'run',
                side: 'below',
                size: 'native',
                strokes: [{ path: pace, width: 'medium' }],
              },
            ]
          : []),
        ...(turns.length
          ? [{ op: 'note', near: pace ? 'pace' : 'run', side: 'below', text: turns.join('\n') }]
          : []),
      ],
    },
  });
};

export function BoardSessions({ board, sessions }: { board: string; sessions: LiveSession[] }) {
  if (!sessions.length) return null;
  return (
    <div className="board-sessions">
      {sessions.map((session) => {
        const { pace, marks } = along(session.steps);
        const now = session.steps.at(-1);
        return (
          <section key={session.id} className="board-session" aria-label={session.name}>
            <strong>{session.name}</strong>
            <button type="button" onClick={() => void pin(board, session).catch(() => undefined)}>
              Pin
            </button>
            <button
              type="button"
              aria-label={`Detach ${session.name}`}
              onClick={() => void call('board.detach', { session: session.id })}
            >
              ×
            </button>
            <svg viewBox="-10 -10 1220 120" preserveAspectRatio="none" aria-hidden>
              {pace && (
                <path
                  d={pace}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {marks.map(({ x, kind }, at) =>
                kind === 'failure' || kind === 'person' ? (
                  <line
                    key={at}
                    x1={x}
                    x2={x}
                    y1={0}
                    y2={100}
                    stroke={kind === 'failure' ? '#e03131' : '#1971c2'}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </svg>
            <p>{now ? [now.tool, now.text].filter(Boolean).join(': ') : 'Attached'}</p>
          </section>
        );
      })}
    </div>
  );
}
