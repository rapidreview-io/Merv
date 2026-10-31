/**
 * A board's history played back, over the live board, which goes on as it was: read-only Excalidraw
 * of its own and the same player as watching, fed one step at a time. Nothing here can save.
 */
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { CaptureUpdateAction, Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { boardAt, type BoardChange, type BoardHistory } from '@merv/board/models';
import { call } from '../api';
import { Ago } from '../components';
import { Icon } from '../icons';
import { ensureBoardFonts } from './board-fonts';
import { fitView, imageBringer, Player, restored, stageOf } from './board-player';
import { useActorNames } from './people';

/** The rest between steps, and how many steps play at full length before all of them play faster. */
const [REST_MS, STEPS] = [350, 150];

export function BoardReplay({
  id,
  editor,
  close,
}: {
  id: string;
  /** How the board's own Excalidraw looks and opens what it holds. */
  editor: ComponentProps<typeof Excalidraw>;
  close(): void;
}) {
  const nameOf = useActorNames();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [changes, setChanges] = useState<BoardChange[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** How many steps are on the canvas, and whether more are coming. */
  const [view, setView] = useState({ at: 0, playing: false });
  const overlay = useRef<HTMLCanvasElement>(null);
  const control = useRef<{ play(): void; pause(): void; jump(to: number): void }>();
  const bring = useMemo(() => api && imageBringer(api), [api]);
  // A board older than history starts as it stood then, shown as it is and not played.
  const first = changes?.[0]?.kind === 'before' ? 1 : 0;

  useEffect(() => {
    let live = true;
    void (async () => {
      const all: BoardChange[] = [];
      let after: number | undefined;
      do {
        const page: BoardHistory = await call('board.history', {
          id,
          ...(after !== undefined && { after }),
        });
        if (!live) return;
        all.push(...page.changes);
        after = page.next;
      } while (after !== undefined);
      await ensureBoardFonts(all.flatMap((change) => change.shapes));
      if (live) setChanges(all);
    })().catch((error: Error) => live && setProblem(error.message));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (!api || !changes?.length || !overlay.current) return;
    let [at, playing] = [first, true];
    let rest: ReturnType<typeof setTimeout>;
    const rate = Math.max(1, changes.length / STEPS);
    const player = new Player(
      stageOf(api, () => !playing),
      overlay.current,
      Infinity,
      rate,
    );
    const told = () => setView({ at, playing });
    const step = () => {
      playing = at < changes.length;
      if (playing) player.add(changes[at++]!.shapes);
      told();
    };
    player.idle = () => {
      if (playing) rest = setTimeout(step, REST_MS / rate);
    };
    const jump = (to: number) => {
      clearTimeout(rest);
      player.stop();
      [at, playing] = [to, false];
      api.updateScene({
        elements: restored(boardAt(changes.slice(0, to)), true),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      told();
    };
    control.current = {
      jump,
      play() {
        if (at >= changes.length) jump(first);
        playing = true;
        if (player.busy) told();
        else step();
      },
      pause() {
        clearTimeout(rest);
        playing = false;
        told();
      },
    };
    // All it comes to in view, erased work too, so nothing is drawn out of sight.
    const every = new Map(changes.flatMap((change) => change.shapes.map((el) => [el.id, el])));
    const frame = requestAnimationFrame(() => {
      fitView(api, restoreElements([...every.values()] as never, null));
      step();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(rest);
      player.stop();
    };
  }, [api, changes, first]);

  const shown = changes?.[view.at - 1];
  const empty = !problem && changes && !changes.length;
  return (
    <div className="board-replay">
      {!!changes?.length && (
        <>
          <Excalidraw
            {...editor}
            excalidrawAPI={setApi}
            viewModeEnabled
            initialData={{ elements: restored(boardAt(changes.slice(0, first)), true) }}
            onChange={(elements, _, held) => bring?.(elements, held)}
          />
          <canvas ref={overlay} className={`board-reveal is-${editor.theme}`} />
        </>
      )}
      <div className="board-replay-bar">
        {!!changes?.length && (
          <>
            <button
              type="button"
              className="btn btn--quiet"
              aria-label={view.playing ? 'Pause' : 'Play'}
              onClick={() => (view.playing ? control.current?.pause() : control.current?.play())}
            >
              <Icon name={view.playing ? 'pause' : 'play'} size={14} />
            </button>
            <input
              type="range"
              className="board-replay-scrub"
              aria-label="Step"
              min={first}
              max={changes.length}
              value={view.at}
              onChange={(event) => control.current?.jump(Number(event.target.value))}
            />
            <span className="board-replay-where muted">
              {view.at - first} of {changes.length - first}
              {shown && shown.kind !== 'before' && (
                <>
                  {' · '}
                  {nameOf(shown.actorId)} · <Ago at={shown.at} />
                </>
              )}
              {first === 1 && view.at === first && (
                <>
                  {' · '}Kept since <Ago at={changes[0]!.at} />; how it got here was not recorded
                </>
              )}
            </span>
          </>
        )}
        {!changes && !problem && <span className="muted">Reading the history…</span>}
        {empty && <span className="muted">No history yet: it starts with the next change.</span>}
        {problem && <span className="pi-error">{problem}</span>}
        <button type="button" className="btn" onClick={close}>
          Back to now
        </button>
      </div>
    </div>
  );
}
