/**
 * A board task's mark: one small pill where the work came from, saying in a word how each run
 * stands (working, done, failed, stopped, needs you). It sits on the board: it moves and scales with
 * it. Pressing a run opens its session; a run that is done opens at the answer that finished it.
 * No result card lands (docs/units.md). Keep is in the mark's menu; a revision is a reply in the session.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ProviderMark } from '../panel/marks';
import { accountRequest, call } from '../api';
import { useBoardView } from '../board-app/board-view';
import { openSession } from '../board-app/open-session';
import { agentName } from '../board-app/sessions';
import './board-marks.css';

type RunState = 'queued' | 'not sent' | 'working' | 'needs you' | 'done' | 'failed' | 'stopped';
type Run = {
  run: number;
  provider: 'claude' | 'codex';
  state: RunState;
  thread?: string;
  kept?: boolean;
};
type TaskMark = {
  unit: string;
  device: string;
  title: string;
  frame?: string;
  note?: string;
  root?: { x: number; y: number; width: number; height: number; shapes: string[] };
  stale: boolean;
  keeps: boolean;
  runs: Run[];
};
type Shape = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
};
type Box = { x1: number; y1: number; x2: number; y2: number };

/** While a run is under way the board asks often; a board at rest, seldom. */
const [BUSY_MS, REST_MS] = [2500, 8000];
const WORDS: Record<RunState, string> = {
  queued: 'Queued',
  'not sent': 'Not sent',
  working: 'Working',
  'needs you': 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};
const ended = (run: Run) => ['done', 'failed', 'stopped', 'not sent'].includes(run.state);
const word = (run: Run) => (run.kept ? 'Kept' : WORDS[run.state]);
/** A finished run opens where it finished, not at whatever was said in its session since. */
const finished = (run: Run) => run.state === 'done';
const opens = (run: Run) =>
  finished(run) ? 'Open its session where it finished' : 'Open its session';

/** Where a task's mark sits: its frame or note as it stands now, else what is left of the selection
 *  it came from. A task whose material is gone from the board has no mark. */
export function anchorOf(
  mark: TaskMark,
  shapes: Map<string, Shape>,
): { key: string; box: Box } | undefined {
  const around = (found: Shape[]) => ({
    x1: Math.min(...found.map((el) => el.x)),
    y1: Math.min(...found.map((el) => el.y)),
    x2: Math.max(...found.map((el) => el.x + el.width)),
    y2: Math.max(...found.map((el) => el.y + el.height)),
  });
  const one = (mark.note && shapes.get(mark.note)) || (mark.frame && shapes.get(mark.frame));
  if (one) return { key: one.id, box: around([one]) };
  if (!mark.root || mark.frame) return undefined;
  if (!mark.root.shapes.length)
    return {
      key: `${mark.root.x},${mark.root.y},${mark.root.width},${mark.root.height}`,
      box: {
        x1: mark.root.x,
        y1: mark.root.y,
        x2: mark.root.x + mark.root.width,
        y2: mark.root.y + mark.root.height,
      },
    };
  const left = mark.root.shapes.flatMap((id) => shapes.get(id) ?? []);
  return left.length ? { key: [...mark.root.shapes].sort().join(), box: around(left) } : undefined;
}

/** One mark per place: sent again from the same frame or selection, the newest task is the one shown. */
export function placed(marks: TaskMark[], elements: readonly Shape[]) {
  const shapes = new Map(elements.filter((el) => !el.isDeleted).map((el) => [el.id, el]));
  const seen = new Set<string>();
  return marks.flatMap((mark) => {
    const anchor = anchorOf(mark, shapes);
    if (!anchor || seen.has(anchor.key)) return [];
    seen.add(anchor.key);
    return [{ mark, box: anchor.box }];
  });
}

export function BoardMarks({ api, board }: { api: ExcalidrawImperativeAPI; board: string }) {
  const { elements, state } = useBoardView(api);
  const [marks, setMarks] = useState<TaskMark[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const again = useRef<() => void>(() => {});

  useEffect(() => {
    let over = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      clearTimeout(timer);
      const got = document.hidden
        ? null
        : await accountRequest<{ marks: TaskMark[] }>(
            `/desk/marks?board=${encodeURIComponent(board)}`,
            { scoped: true },
          ).catch(() => null);
      if (over) return;
      if (got)
        setMarks((was) => (JSON.stringify(was) === JSON.stringify(got.marks) ? was : got.marks));
      const busy = (got?.marks ?? []).some((mark) => mark.runs.some((run) => !ended(run)));
      timer = setTimeout(() => void look(), busy ? BUSY_MS : REST_MS);
    };
    again.current = () => void look();
    setMarks([]);
    void look();
    const seen = () => {
      if (!document.hidden) void look();
    };
    document.addEventListener('visibilitychange', seen);
    return () => {
      over = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [board]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('.task-mark')) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  const zoom = state.zoom.value;
  return (
    <div className="task-marks">
      {placed(marks, elements as readonly Shape[]).map(({ mark, box }) => (
        // The pill sits on the task's top right corner and scales with the board, as ink does.
        <Pill
          key={mark.unit}
          mark={mark}
          left={(box.x2 + state.scrollX) * zoom + state.offsetLeft}
          top={(box.y1 + state.scrollY) * zoom + state.offsetTop}
          zoom={zoom}
          open={menu === mark.unit}
          onMenu={(open) => setMenu(open ? mark.unit : null)}
          onChanged={() => again.current()}
        />
      ))}
    </div>
  );
}

function Pill({
  mark,
  left,
  top,
  zoom,
  open,
  onMenu,
  onChanged,
}: {
  mark: TaskMark;
  left: number;
  top: number;
  zoom: number;
  open: boolean;
  onMenu(open: boolean): void;
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const several = mark.runs.length > 1;
  const keeps = mark.keeps ? mark.runs.filter((run) => run.state === 'done' && !run.kept) : [];
  const act = async (name: string, input: Record<string, unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await call(name, input);
      onMenu(false);
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) setProblem('');
  }, [open]);
  return (
    <div
      className={`task-mark${mark.stale ? ' is-stale' : ''}`}
      style={{ left, top, '--zoom': zoom } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      title={mark.stale ? 'The task changed on the board after this ran' : undefined}
    >
      {mark.runs.map((run) => {
        const who = agentName(run.provider);
        const says = run.kept
          ? `${who}'s run was kept`
          : run.state === 'done'
            ? `${who} is done`
            : run.state === 'working'
              ? `${who} is working`
              : run.state === 'needs you'
                ? `${who} needs you`
                : run.state === 'failed'
                  ? `${who} failed`
                  : run.state === 'stopped'
                    ? `${who} was stopped`
                    : run.state === 'queued'
                      ? `${who} is queued`
                      : `Not sent to ${who}`;
        return (
          <button
            key={run.run}
            type="button"
            className={`task-run is-${run.state.replace(' ', '-')}`}
            disabled={!run.thread}
            aria-label={run.thread ? `${says}. ${opens(run)}` : says}
            title={
              run.thread
                ? `${says}. ${opens(run)}`
                : `${says}. Its session is not open on your Mac yet`
            }
            onClick={() =>
              run.thread &&
              openSession({
                device: mark.device,
                thread: run.thread,
                ...(finished(run) && { done: true }),
              })
            }
          >
            {several && <ProviderMark provider={run.provider} size={12} />}
            <Glyph state={run.state} />
            <span>{word(run)}</span>
          </button>
        );
      })}
      {keeps.length > 0 && (
        <button
          type="button"
          className="task-more"
          aria-label="More for this task"
          title="More"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onMenu(!open)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="2.5" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="9.5" cy="6" r="1" fill="currentColor" />
          </svg>
        </button>
      )}
      {open && (
        <div className="task-menu" role="menu">
          {keeps.map((run) => (
            <button
              key={run.run}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void act('desk.write:keep', { unit: mark.unit, run: run.run })}
            >
              {several ? `Keep ${agentName(run.provider)}’s run` : 'Keep this run'}
            </button>
          ))}
          {problem && <p role="alert">{problem}</p>}
        </div>
      )}
    </div>
  );
}

/** One distinct shape per state, the sessions panel's own (desk-ui marks.tsx), so a glance tells them apart without colour. */
function Glyph({ state }: { state: RunState }) {
  return (
    <svg className="task-glyph" width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      {state === 'working' && (
        <path
          className="task-spin"
          d="M7 1.5A5.5 5.5 0 1 1 1.5 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {state === 'needs you' && <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="currentColor" />}
      {state === 'done' && (
        <path
          d="M2.5 7.4 5.6 10.5 11.5 3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {state === 'failed' && (
        <>
          <circle cx="7" cy="7" r="5.6" fill="currentColor" />
          <path
            d="M7 4v3.6M7 9.8v.1"
            stroke="var(--bg-elev, #fff)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'stopped' && (
        <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      )}
      {state === 'queued' && (
        <circle
          cx="7"
          cy="7"
          r="4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="2.4 2.4"
        />
      )}
      {state === 'not sent' && (
        <path d="M3 7h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}
