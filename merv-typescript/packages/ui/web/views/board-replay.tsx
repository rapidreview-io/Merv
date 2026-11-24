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
import { recordClip } from './board-clip';
import { BoardFilm } from './board-film';
import { ensureBoardFonts } from './board-fonts';
import { clearView } from './board-player';
import { picturesOf, Projection, restoreOne, type Camera, type Shape } from './board-projection';
import { Scrubber, whenOf, type ScrubberControl } from './board-scrubber';
import { SPEEDS, storedPace, storePace, Subtitles, type Pace } from './board-subtitles';
import {
  linesAt,
  QUICK_LENGTH,
  speakerOf,
  timelineOf,
  type Line,
  type Timeline,
} from './board-timeline';
import { useActorNames } from './people';
import { useActor } from '../session';
import { speech } from '../speech';

/** How long the scrubber stays once now is reached, to be picked up again, and takes to sink. */
const [LINGER_MS, SINK_MS] = [1400, 560];
/** How far round the drawing a line was said with its highlight stands. */
const MARK_ROOM = 8;
/** How fast a demo's pen goes: at a person's writing pace a board of words takes ten minutes. */
const DEMO_SPEED = 1.5;
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
  readHistory,
  demo = false,
  speak,
}: {
  id: string;
  /** Starts at once and from nothing, with no way to stop it: the landing page. */
  demo?: boolean;
  /** Takes the lines said as it plays, in place of the replay's own caption. */
  speak?(line: string, playing: { pause(): void; play(): void }): void;
  readHistory?(after?: number): Promise<BoardHistory>;
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
  const me = useActor()?.id;
  const recording = useRef<ReturnType<typeof recordClip>>();
  const [clipping, setClipping] = useState(false);
  const finishClip = () => {
    recording.current?.();
    recording.current = undefined;
    setClipping(false);
  };
  useEffect(() => () => recording.current?.(false), []);
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
  /** The lines under the playhead: the one being read, and the one before it. */
  const [words, setWords] = useState<{ now?: Line; before?: Line }>({});
  const wordsNow = useRef(words);
  const mark = useRef<HTMLDivElement>(null);
  const marked = useRef('');
  const pace = useRef<Pace>(1);

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
      return speech.agent;
    },
    [names],
  );
  /** The person who said a line: you, or whoever else in the project it was. */
  const personOf = useCallback(
    (line: Line) => (line.actorId === me ? undefined : names(line.actorId)) ?? 'You',
    [names, me],
  );
  /** The words for this moment, taken from the playhead and nothing else. */
  const tell = (at: number) => {
    const projection = shown.current;
    const next = projection && !speak && !projection.back ? linesAt(projection.line, at) : {};
    const had = wordsNow.current;
    if (next.now === had.now && next.before === had.before) return;
    wordsNow.current = next;
    setWords(next);
  };
  /** The highlight on what the line being read was said with, wherever the camera has it. */
  const point = (camera: Camera) => {
    const unit = wordsNow.current.now?.unit;
    const reach = unit === undefined ? undefined : shown.current?.line.units[unit]?.reach;
    const on = !!reach && phaseNow.current === 'on';
    const [x, y, right, bottom] = reach ?? [0, 0, 0, 0];
    const { zoom, scrollX, scrollY } = camera;
    const box = [x + scrollX, y + scrollY, right - x, bottom - y].map((side) => side * zoom);
    const said = on ? box.map(Math.round).join() : '';
    if (said === marked.current || !mark.current) return;
    marked.current = said;
    mark.current.classList.toggle('is-on', on);
    if (!on) return;
    const [left, top, width, height] = box as [number, number, number, number];
    mark.current.style.transform = `translate3d(${left - MARK_ROOM}px,${top - MARK_ROOM}px,0)`;
    mark.current.style.width = `${width + 2 * MARK_ROOM}px`;
    mark.current.style.height = `${height + 2 * MARK_ROOM}px`;
  };
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
    setWords((wordsNow.current = {}));
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
      finishClip();
      // A demo was never anyone's board to go back to: it ends where the drawing ended.
      shown.current?.rest(demo);
      mode(false);
      putBack();
      setSaid(null);
      setWords((wordsNow.current = {}));
      // The ring goes with the words, at once: the board under it is the person's again.
      mark.current?.classList.remove('is-on');
      marked.current = '';
      if (linger) {
        setPhase('settling');
        clearTimeout(ending.current);
        ending.current = setTimeout(sink, LINGER_MS);
      } else sink();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, mode, sink],
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
        const page: BoardHistory = readHistory
          ? await readHistory(after)
          : await call('board.history', {
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
      pace.current = storedPace();
      setLine(timelineOf(changes, pace.current === 'quick'));
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
  const latest = useRef({ nameOf, revision, leave, say, tell, point });
  latest.current = { nameOf, revision, leave, say, tell, point };
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
          place: (at) => {
            place.current?.place(at);
            latest.current.tell(at);
          },
          changed: () => {
            setLine(shown.current?.line ?? null);
            redraw((count) => count + 1);
          },
          // The last frame and the last line stay until the person leaves; a demo has nobody to.
          ended: () => {
            if (demo) return latest.current.leave(true);
            finishClip();
            redraw((count) => count + 1);
          },
          say: (line) => speak?.(line, shown.current!),
          view: (camera) => latest.current.point(camera),
          nameOf: (hand) => latest.current.nameOf(hand),
          refused: () => latest.current.say(NOT_NOW, true),
          below: () => {
            // Where the app says its words over the canvas, a drawing stands clear of those instead.
            const band =
              document.querySelector('.board-landing-spoken') ??
              rootOf()?.querySelector('.board-subtitle-room') ??
              rootOf()?.querySelector('.board-scrub');
            if (!band) return 0;
            const clear = clearView(live);
            const top = band.getBoundingClientRect().top - live.getAppState().offsetTop;
            return Math.max(0, clear.y + clear.height - top);
          },
          more: async () => {
            if (readHistory) return null;
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
      projection.quick = pace.current === 'quick';
      if (!demo && pace.current !== 'quick') projection.setSpeed(pace.current);
      projection.match(live.getFiles());
      // A demo is drawn from nothing: it must not show its end, even for the frame before it rewinds.
      if (demo) projection.seek(0);
      // Two frames: one for it to paint what it was given, one for that to reach the screen.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          flushSync(() => setPhase('on'));
          projection.run();
          if (demo) {
            projection.closeIn();
            projection.seek(0);
            projection.setSpeed(DEMO_SPEED);
            projection.play();
          } else projection.rewind();
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [phase, screen, line, live, id]);
  useEffect(
    () => () => {
      asked.current++;
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
  // A demo starts as it opens.
  useEffect(() => {
    if (demo) toggling.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  /** Plays at this pace from here on, in this browser's replays after this one too. */
  const setPace = (next: Pace) => {
    if (!projection) return;
    storePace((pace.current = next));
    projection.quick = next === 'quick';
    if (projection.quick !== projection.line.quick)
      projection.retime(timelineOf(history.current, projection.quick));
    projection.setSpeed(next === 'quick' ? 1 : next);
  };
  const subtitled = phase === 'on' && !!(words.now || words.before);
  const notice = said && (
    <p className="board-replay-said" role="status">
      {said.words}
      {said.back && (
        <button type="button" className="btn-text" onClick={reachNow}>
          Back to now
        </button>
      )}
    </p>
  );
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
            <button
              type="button"
              aria-label={clipping ? 'Finish clip' : 'Export replay from here'}
              onClick={() => {
                if (clipping) return finishClip();
                const layer = rootOf()?.querySelector<HTMLElement>('.board-replay-layer');
                if (!layer || phase !== 'on') return say('Start the replay to export a clip');
                try {
                  // The words of the clip are the words on the page: one rule picks both.
                  recording.current = recordClip(layer, () => {
                    const { now } = linesAt(projection.line, projection.at);
                    return now ? `${speakerOf(now, personOf(now)).name}: ${now.words}` : '';
                  });
                  setClipping(true);
                  if (!projection.moving) projection.play();
                } catch (error) {
                  say((error as Error).message);
                }
              }}
            >
              {clipping ? 'Finish clip' : 'Clip'}
            </button>
            <div className="board-scrub-speed" role="group" aria-label="Replay speed">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-label={`Play at ${speed} times speed`}
                  aria-pressed={!line.quick && speed === projection.speed}
                  onClick={() => setPace(speed)}
                >
                  {speed}×
                </button>
              ))}
              {(line.quick || line.length > QUICK_LENGTH) && (
                <button
                  type="button"
                  aria-label="Play a quick overview, in a minute"
                  aria-pressed={line.quick}
                  onClick={() => setPace('quick')}
                >
                  Quick
                </button>
              )}
            </div>
            <button
              type="button"
              className={`board-scrub-now${said?.back ? ' is-called' : ''}`}
              onClick={reachNow}
            >
              Now
            </button>
          </div>
          {!!line.lines.length && !speak && <div className="board-subtitle-room" />}
          <div className="board-subtitle-marks">
            <div
              ref={mark}
              className="board-subtitle-mark"
              data-voice={words.now && speakerOf(words.now).voice}
            />
          </div>
          {subtitled && (
            <Subtitles {...words} theme={theme} person={personOf}>
              {notice}
            </Subtitles>
          )}
        </div>
      )}
      {!subtitled && notice}
      <button
        ref={play}
        type="button"
        className={`board-play${moving ? ' is-moving' : ''}${opening ? ' is-opening' : ''}`}
        aria-label={moving ? 'Pause the replay' : 'Replay this board'}
        title={away ? 'Replay' : undefined}
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
