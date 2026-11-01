/**
 * A board's history played back where the board is, with nothing to see of the switch. The board's
 * own Excalidraw stays: its toolbars, its camera and the hands on them are the page's as ever, its
 * saving and asking go on, and what others draw lands in it. Between its canvas and its controls
 * comes a second Excalidraw, with no controls and taking no hands, that only ever paints. It starts
 * as a copy of what the board shows, seen only once it has painted that, and follows the board's
 * camera, so the moment it takes over shows nothing. Nothing played is in the board's scene, so
 * nothing played can be saved or undone, and a person can only draw once it has gone.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { flushSync } from 'react-dom';
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardChange, BoardHistory } from '@merv/board/models';
import { call } from '../api';
import { typing } from '../list-filters';
import { BoardFilm } from './board-film';
import { ensureBoardFonts } from './board-fonts';
import { clearView } from './board-player';
import { picturesOf, Projection, restoreOne, type Shape } from './board-projection';
import { Scrubber, whenOf, type ScrubberControl } from './board-scrubber';
import { timelineOf, type Timeline } from './board-timeline';
import { useActorNames } from './people';

/** How long the scrubber stays once now is reached, to be picked up again, and takes to sink. */
const [LINGER_MS, SINK_MS] = [1400, 560];
const SPEEDS = [0.25, 0.5, 1, 2, 4];
/** What a person hears on reaching for the board during a replay. */
const NOT_NOW = "Can't draw on the past";

/** Whether keys here are writing, which a radio or a slider among the tools is not. */
const writing = (el: Element) =>
  typing(el) && !(el instanceof HTMLInputElement && /radio|checkbox|range/.test(el.type));

type Phase = 'off' | 'opening' | 'on' | 'settling' | 'sinking';

export function BoardReplay({
  id,
  live,
  editor,
  free,
  settle,
  revision,
  mode,
}: {
  id: string;
  /** The board's own Excalidraw, which keeps going underneath. */
  live: ExcalidrawImperativeAPI;
  /** How the board's own Excalidraw looks and opens what it holds. */
  editor: ComponentProps<typeof Excalidraw>;
  /** Whether the person is not in the middle of drawing something. */
  free(): boolean;
  /** Saves what is unsaved, so history holds it. */
  settle(): Promise<void>;
  /** The newest revision the board has heard of. */
  revision(): number;
  mode(replaying: boolean): void;
}) {
  const names = useActorNames();
  const [phase, setPhase] = useState<Phase>('off');
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const [screen, setScreen] = useState<ExcalidrawImperativeAPI | null>(null);
  const [line, setLine] = useState<Timeline | null>(null);
  const [, redraw] = useState(0);
  /** What the person is told of something they tried, and whether it comes with the way back. */
  const [said, setSaid] = useState<{ words: string; back?: boolean } | null>(null);
  const saying = useRef<ReturnType<typeof setTimeout>>();
  const ending = useRef<ReturnType<typeof setTimeout>>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const play = useRef<HTMLButtonElement>(null);
  const shown = useRef<Projection | null>(null);
  const place = useRef<ScrubberControl | null>(null);
  const history = useRef<BoardChange[]>([]);
  const selection = useRef<{
    selectedElementIds: Readonly<Record<string, true>>;
    selectedGroupIds: Readonly<Record<string, boolean>>;
  } | null>(null);
  const resume = useRef(false);
  const holding = useRef(false);
  /** Asked for again while it opens: the one being opened is the last asked for. */
  const asked = useRef(0);
  /** A frame after it is there, so that it rises. */
  const [risen, setRisen] = useState(false);

  // What the second Excalidraw opens with: the board's look and camera, and nothing on it yet.
  const opening = phase === 'opening';
  const initial = useMemo(() => {
    const { scrollX, scrollY, zoom, viewBackgroundColor, gridModeEnabled, gridSize, gridStep } =
      live.getAppState();
    return {
      elements: [],
      appState: {
        scrollX,
        scrollY,
        zoom,
        viewBackgroundColor,
        gridModeEnabled,
        gridSize,
        gridStep,
      },
    };
    // Taken as it opens, and only read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, opening]);

  const rootOf = () => play.current?.closest<HTMLElement>('.board-canvas') ?? null;
  const say = useCallback((words: string, back = false) => {
    clearTimeout(saying.current);
    setSaid({ words, back });
    saying.current = setTimeout(() => setSaid(null), 3600);
  }, []);
  useEffect(() => () => clearTimeout(saying.current), []);

  const nameOf = useCallback(
    (hand: number) => {
      const who = shown.current?.line.hands[hand];
      if (!who) return '';
      const name = names(who.actorId);
      if (who.person) return name ?? 'Someone';
      return name ? `${name}'s agent` : 'An agent';
    },
    [names],
  );
  const whenOfStep = useCallback((step: number) => {
    const change = history.current[step];
    return change ? whenOf(change.at) : '';
  }, []);

  /** Lifts the person's selection off the board, and it comes back with the board. */
  const lift = () => {
    const { selectedElementIds, selectedGroupIds } = live.getAppState();
    selection.current = { selectedElementIds, selectedGroupIds };
    live.updateScene({
      appState: {
        selectedElementIds: {},
        selectedGroupIds: {},
        selectedLinearElement: null,
        showHyperlinkPopup: false,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };
  const putBack = () => {
    const held = selection.current;
    selection.current = null;
    if (!held) return;
    const standing = new Set(live.getSceneElements().map((el) => el.id));
    live.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(
          Object.entries(held.selectedElementIds).filter(([el]) => standing.has(el)),
        ) as never,
        selectedGroupIds: held.selectedGroupIds as never,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  const off = useCallback(() => {
    clearTimeout(ending.current);
    shown.current?.stop();
    shown.current = null;
    history.current = [];
    setScreen(null);
    setLine(null);
    setPhase('off');
  }, []);
  const sink = useCallback(() => {
    clearTimeout(ending.current);
    setPhase('sinking');
    ending.current = setTimeout(off, SINK_MS);
  }, [off]);
  /** Back to the board: it is the board again at once, and the scrubber goes after it. */
  const leave = useCallback(
    (linger: boolean) => {
      shown.current?.rest();
      mode(false);
      putBack();
      setSaid(null);
      if (linger) {
        setPhase('settling');
        clearTimeout(ending.current);
        ending.current = setTimeout(sink, LINGER_MS);
      } else sink();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, sink],
  );
  /** Picked up again before it had gone, unless the person has started drawing since. */
  const again = () => {
    if (!free()) {
      say('Finish what you are drawing first');
      return false;
    }
    clearTimeout(ending.current);
    shown.current?.again();
    lift();
    mode(true);
    setPhase('on');
    return true;
  };
  const refused = (words: string) => {
    mode(false);
    putBack();
    setPhase('off');
    setScreen(null);
    say(words);
  };

  const enter = async () => {
    if (!free()) return say('Finish what you are drawing first');
    const attempt = ++asked.current;
    const stale = () => attempt !== asked.current;
    lift();
    mode(true);
    setPhase('opening');
    try {
      await settle();
      const changes: BoardChange[] = [];
      let after: number | undefined;
      do {
        const page: BoardHistory = await call('board.history', {
          id,
          ...(after !== undefined && { after }),
        });
        if (stale()) return;
        changes.push(...page.changes);
        after = page.next;
      } while (after !== undefined);
      if (!changes.length) return refused('No history yet: it starts with the next change.');
      await ensureBoardFonts(changes.flatMap((change) => change.shapes));
      if (stale()) return;
      history.current = changes;
      setLine(timelineOf(changes));
    } catch (error) {
      if (!stale()) refused(`History did not load: ${(error as Error).message}`);
    }
  };
  /** Not after all, while it was still opening. */
  const cancel = () => {
    asked.current++;
    mode(false);
    putBack();
    off();
  };

  // Once the second Excalidraw is up and holds what the board shows, it takes over and runs back.
  const latest = useRef({ nameOf, revision, leave, say });
  latest.current = { nameOf, revision, leave, say };
  useEffect(() => {
    if (phase !== 'opening' || !screen || !line) return;
    let frame = requestAnimationFrame(function ready() {
      if (screen.getAppState().isLoading || !canvas.current) {
        frame = requestAnimationFrame(ready);
        return;
      }
      const projection = new Projection(
        live,
        screen,
        canvas.current,
        line,
        new BoardFilm<Shape>(line, restoreOne),
        picturesOf(history.current),
        {
          place: (at) => place.current?.place(at),
          changed: () => {
            setLine(shown.current?.line ?? null);
            redraw((count) => count + 1);
          },
          ended: () => latest.current.leave(true),
          nameOf: (hand) => latest.current.nameOf(hand),
          refused: () => latest.current.say(NOT_NOW, true),
          below: () => {
            const band = rootOf()?.querySelector('.board-scrub');
            if (!band) return 0;
            const clear = clearView(live);
            const top = band.getBoundingClientRect().top - live.getAppState().offsetTop;
            return Math.max(0, clear.y + clear.height - top);
          },
          more: async () => {
            const had = history.current;
            const after = had.at(-1)?.revision ?? 0;
            if (latest.current.revision() <= after) return null;
            const page = await call<BoardHistory>('board.history', { id, after }).catch(() => null);
            // Left and perhaps opened again meanwhile, it is not this replay's to add to.
            if (!page?.changes.length || history.current !== had) return null;
            history.current = [...had, ...page.changes];
            return history.current;
          },
        },
      );
      shown.current = projection;
      projection.match(live.getFiles());
      // Two frames: one for it to paint what it was given, one for that to reach the screen.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          flushSync(() => setPhase('on'));
          projection.run();
          projection.rewind();
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [phase, screen, line, live, id]);
  useEffect(
    () => () => {
      clearTimeout(ending.current);
      shown.current?.stop();
    },
    [],
  );

  const toggle = () => {
    const projection = shown.current;
    if (phase === 'off') return void enter();
    if (phase === 'opening') return cancel();
    if (!projection) return;
    if (phase !== 'on') {
      if (again()) projection.rewind();
      return;
    }
    if (projection.moving) projection.pause();
    else projection.play();
  };
  const toggling = useRef(toggle);
  toggling.current = toggle;
  const reachNow = () => {
    if (phaseNow.current === 'opening') return cancel();
    shown.current?.pause();
    shown.current?.seek(shown.current.line.length);
    leave(false);
  };
  const reaching = useRef(reachNow);
  reaching.current = reachNow;

  // The keys, wherever they fall on the board: nothing else on it hears them during a replay.
  useEffect(() => {
    if (phase === 'off' || phase === 'sinking') return;
    const press = (event: KeyboardEvent) => {
      const target = event.target as Element;
      if (writing(target) || !(target === document.body || target.closest('.board-canvas'))) return;
      const { openDialog, openMenu, openPopup } = live.getAppState();
      if (openDialog || openMenu || openPopup) return;
      const projection = shown.current;
      const { key } = event;
      if (key === 'Tab') return;
      // A button takes these itself, Play as well, and what it would do is guarded by the click.
      if ((key === 'Enter' || key === ' ') && target.closest('button')) return;
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (!projection) {
        take();
        if (key === 'Escape') toggling.current();
      } else if (key === 'Escape') {
        take();
        if (phase === 'on') leave(false);
        else sink();
      } else if (key === ' ') {
        take();
        toggling.current();
      } else if (phase !== 'on') {
        return;
      } else if (key.startsWith('Arrow')) {
        take();
        const back = key === 'ArrowLeft' || key === 'ArrowDown';
        projection.step((back ? -1 : 1) * (event.shiftKey ? 10 : 1));
      } else if (key === 'Home') {
        take();
        projection.pause();
        projection.seek(0);
        projection.settle();
      } else if (key === 'End') {
        take();
        reaching.current();
      } else {
        // Nothing else reaches the board: not what would draw, paste or undo there.
        event.stopPropagation();
        if (key.length === 1 || key === 'Backspace' || key === 'Delete' || key === 'Enter') {
          if (event.metaKey || event.ctrlKey) event.preventDefault();
          say(NOT_NOW, true);
        }
      }
    };
    addEventListener('keydown', press, true);
    return () => removeEventListener('keydown', press, true);
  }, [phase, live, leave, sink, say]);

  // The hands: what would draw on or change the board stops here, and says the way back to now.
  // The wheel, the zoom buttons and the hand tool go through, so the camera is the person's still.
  useEffect(() => {
    if (phase !== 'on' && phase !== 'opening') return;
    const root = rootOf();
    if (!root) return;
    const ours = '.board-replay-own, .board-status, .board-ask, .board-play, .board-replay-said';
    const stop = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    /** What would change the board at once, unlike a tool, which is only taken up. */
    const changes = '.undo-redo-buttons, .board-add, [data-testid="toolbar-image"]';
    const press = (event: Event) => {
      if ((event.target as Element).closest(changes)) stop(event);
    };
    const hand = (event: PointerEvent) => {
      const target = event.target as Element;
      // What is happening now is on the board, so it goes there.
      const status = target.closest('.board-status');
      if (event.type === 'pointerdown' && status && !target.closest('.board-status-stop'))
        reaching.current();
      if (target.closest(ours) || live.getAppState().openDialog) return;
      const chrome = target.closest('.layer-ui__wrapper');
      if (chrome) {
        if (event.type === 'pointerdown' && target.closest('.zoom-actions'))
          shown.current?.handOn();
        const tool = target.closest('.shapes-section, .App-toolbar, .mobile-misc-tools-container');
        const changing = target.closest(changes);
        if (changing) stop(event);
        if (event.type === 'pointerdown' && (changing || tool)) say(NOT_NOW, true);
        return;
      }
      if (
        live.getAppState().activeTool.type === 'hand' ||
        event.button === 1 ||
        event.buttons === 4
      ) {
        if (event.type === 'pointerdown') shown.current?.handOn();
        return;
      }
      event.stopPropagation();
      if (event.type === 'pointerdown') say(NOT_NOW, true);
    };
    const refuse = (event: Event) => {
      const from = (event.target as Element).closest(`${ours}, .layer-ui__wrapper`);
      // A file dropped anywhere on the board would load in it, its controls too.
      if (!from || event.type === 'drop' || event.type === 'dragover') stop(event);
    };
    const hands = ['pointerdown', 'pointermove', 'pointerup'] as const;
    const others = ['dblclick', 'contextmenu', 'touchstart', 'dragover', 'drop'];
    const onCamera = () => shown.current?.handOn();
    root.addEventListener('wheel', onCamera, { capture: true, passive: true });
    root.addEventListener('gesturestart', onCamera, { capture: true, passive: true });
    root.addEventListener('click', press, true);
    for (const kind of hands) root.addEventListener(kind, hand, true);
    for (const kind of others) root.addEventListener(kind, refuse, true);
    const paste = (event: Event) => {
      if (!writing(event.target as Element)) stop(event);
    };
    for (const kind of ['paste', 'cut']) addEventListener(kind, paste, true);
    return () => {
      root.removeEventListener('wheel', onCamera, true);
      root.removeEventListener('gesturestart', onCamera, true);
      root.removeEventListener('click', press, true);
      for (const kind of hands) root.removeEventListener(kind, hand, true);
      for (const kind of others) root.removeEventListener(kind, refuse, true);
      for (const kind of ['paste', 'cut']) removeEventListener(kind, paste, true);
    };
  }, [phase, live, say]);

  // The scrubber stands between Excalidraw's controls and the row of those at the bottom right.
  const away = phase === 'off';
  useLayoutEffect(() => {
    const root = rootOf();
    if (!root || away) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      const lefts = [...root.querySelectorAll('.layer-ui__wrapper__footer-left > *')];
      const rights = [...root.querySelectorAll('.board-ask, .board-play')];
      const left = Math.max(0, ...lefts.map((el) => el.getBoundingClientRect().right - box.left));
      const right = Math.max(0, ...rights.map((el) => box.right - el.getBoundingClientRect().left));
      root.style.setProperty('--replay-left', `${Math.round(left) + 16}px`);
      root.style.setProperty('--replay-right', `${Math.round(right) + 16}px`);
      root.style.setProperty('--board-paper', live.getAppState().viewBackgroundColor);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    // Ask Pi comes and goes with the dock, which this hears of no other way.
    const every = setInterval(measure, 1000);
    return () => {
      watch.disconnect();
      clearInterval(every);
    };
  }, [away, live]);

  const rising = phase === 'on' || phase === 'settling';
  useEffect(() => {
    if (!rising) return setRisen(false);
    const frame = requestAnimationFrame(() => setRisen(true));
    return () => cancelAnimationFrame(frame);
  }, [rising]);
  const projection = shown.current;
  const moving = phase === 'on' && !!projection?.moving;
  const theme = String(editor.theme);
  return (
    <>
      {phase !== 'off' && (
        <div
          className={`board-replay-layer${phase === 'on' ? ' is-on' : ''}${phase === 'settling' || phase === 'sinking' ? ' is-gone' : ''}`}
        >
          <Excalidraw
            {...editor}
            excalidrawAPI={setScreen}
            viewModeEnabled
            autoFocus={false}
            initialData={initial}
          />
          <canvas ref={canvas} className={`board-reveal is-${theme}`} />
        </div>
      )}
      {!!line && projection && (
        <div className={`board-replay-own${risen ? ' is-in' : ''}`}>
          <div className={`board-floor is-${theme}`} />
          <Scrubber
            line={line}
            theme={theme}
            control={place}
            nameOf={nameOf}
            when={whenOfStep}
            rising={risen}
            seek={(at) => holding.current && shown.current?.seek(at)}
            grabbed={() => {
              holding.current = phaseNow.current === 'on' || again();
              if (!holding.current) return;
              resume.current = !!shown.current?.moving;
              shown.current?.grab();
            }}
            dropped={(now) => {
              if (!holding.current) return;
              holding.current = false;
              if (now) return leave(false);
              shown.current?.drop();
              if (resume.current) shown.current?.play();
            }}
          />
          <div className="board-scrub-ends">
            <div
              className="board-scrub-speed"
              role="group"
              aria-label="Replay speed"
              data-set={projection.speed !== 1 ? '' : undefined}
            >
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-label={`Play at ${speed} times speed`}
                  aria-pressed={speed === projection.speed}
                  onClick={() => projection.setSpeed(speed)}
                >
                  {speed}×
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`board-scrub-now${said?.back ? ' is-called' : ''}`}
              onClick={reachNow}
            >
              Now
            </button>
          </div>
        </div>
      )}
      {said && (
        <p className="board-replay-said" role="status">
          {said.words}
          {said.back && (
            <button type="button" className="btn-text" onClick={reachNow}>
              Back to now
            </button>
          )}
        </p>
      )}
      <button
        ref={play}
        type="button"
        className={`board-play${moving ? ' is-moving' : ''}${opening ? ' is-opening' : ''}`}
        aria-label={moving ? 'Pause the replay' : 'Replay this board'}
        title={
          away
            ? 'Replay. History is on: project members can replay this board, erased work too.'
            : undefined
        }
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" className="board-play-play" aria-hidden="true">
          <path d="M8.5 6.2v11.6L18 12z" />
        </svg>
        <svg viewBox="0 0 24 24" className="board-play-pause" aria-hidden="true">
          <path d="M8 6.5v11M16 6.5v11" />
        </svg>
      </button>
    </>
  );
}
