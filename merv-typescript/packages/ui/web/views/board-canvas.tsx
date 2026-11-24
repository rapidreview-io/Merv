/**
 * One board's canvas: Excalidraw, kept in step with Board. What the person draws is saved a moment
 * after they stop, as the shapes whose version Board has not seen; what anyone else (a colleague,
 * the agent) drew arrives by asking for what changed after the revision in hand, and is merged in
 * shape by shape as Excalidraw reconciles. An image's bytes reach Board before its shape does, and
 * each page brings in the bytes of what it is handed, under the same project membership.
 * Excalidraw's fonts are served from this app, never a CDN; embeds are off, since a board loads
 * nothing from elsewhere.
 */
import { holdStaleBuild, reloadWhenSafe } from '../stale-build';
import type { ReactNode } from 'react';
import '@excalidraw/excalidraw/index.css';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CaptureUpdateAction,
  Excalidraw,
  getCommonBounds,
  hashElementsVersion,
  MainMenu,
  newElementWith,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { MOST_IMAGE_BYTES, stacked, type BoardElement, type BoardScene } from '@merv/board/models';
import { isDark, boardAppearance } from '@merv/protocol/looks';
import { accountRequest, type ApiError, call } from '../api';
import { SessionContext } from '../session';
import { ensureBoardFonts } from './board-fonts';
import { boardInput } from './board-input';
import { needsSave, sameStamp, stampOf, type ShapeStamp } from './board-stamps';
import { typing } from '../list-filters';
import { useCurrent } from '../mutations';
import { useRows } from '../navigation';
import { onWorn, worn } from '../theme';
import { placeOf } from './pi-screen';
import { pointWith } from './pi-transport';
import { BoardLinkDetails, PAGE_LINK } from './board-link-details';
import { BoardTools } from './board-tools';
import { AddButton, asksToAdd, CardPicker, type CardPick } from './board-add';
import { boardScale, inView, landing, overlaps, type Rect } from './board-place';
import { fileOf, fitView, imageAt, imageBringer, Player, restored, stageOf } from './board-player';
import { BoardPenSize } from './board-pen-size';
import { lendBoardCard } from './board-card';
import { boardCardOf } from './board-card-view';
import { BoardFollow } from './board-follow';
import { BoardPointing, markOn } from './board-pointing';
import { BoardPresence } from './board-presence';
import { BoardSelection } from './board-selection';
import { BoardTiles } from './board-tiles';
import { BoardItems } from './board-items';
import { BoardReplay } from './board-replay';
import { BoardTalk } from './board-talk';
import { setBoardLoaded, unstick } from './board-ready';
import { tapOpens } from './board-tap-open';
import { useAgent } from './pi';
import { sayer } from './voice-backend';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';

const SAVE_MS = 600;
/** How often the page asks what changed, and how often while an agent has lately been drawing. */
const [ASK_MS, ASK_DRAWING_MS, ASK_VOICE_MS] = [10000, 400, 1500];
const DRAWING_MS = 20_000;
/** The most what others drew may be shown behind, in milliseconds of playing it. */
const BEHIND_MS = 4000;
/** How far behind an agent's pen keeps a hand's pace: Board answers it while it still has this one call to draw. */
const PEN_BEHIND_MS = 45_000;
/** How long after Pi's turn ends its last ink may still be on its way to this page, with its lines. */
const LAST_INK_MS = 3_000;
/** How long the board's fonts may hold up opening it; past this it opens with what has loaded. */
const FONTS_MS = 4000;
/** The longest one look at the board waits for Board's answer: past it the look is given up, so the
 *  next one asks again and the page never stops taking in what is drawn. */
const LOOK_MS = 20_000;
/** The longest the voice holds the pen for the lines it has still to say; past it the ink lands. */
const VOICE_HOLD_MS = 60_000;
/** How many looks in a row may fail to take in Board's answer before the page loads the new build. */
const MOST_FAILED_LOOKS = 2;
/** What `promise` gives, or `otherwise` once `ms` have passed without it. */
const within = <T,>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  new Promise<T>((done) => {
    const timer = setTimeout(() => done(otherwise), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      () => {
        clearTimeout(timer);
        done(otherwise);
      },
    );
  });
/** Past this, opening says it is taking long and offers to try again, while it goes on trying. */
const SLOW_MS = 12_000;
/** Excalidraw is handed the whole scene, so past this its "Loading scene..." is a flag left on. */
const STUCK_MS = 5000;
/** Told on the window once the page has drawn as Merv: the lines on that ink go to the voice. */
export const VOICE_PEN = 'board:voice-pen';

import { holdSlot } from './orb-slot';
export { useOrbSlot } from './orb-slot';
/** What part of the board the person is looking at now, in board units, while a board is open. */
export let boardInView: (() => { x: number; y: number; width: number; height: number }) | undefined;
/** What a person may add, told at once; Board checks the bytes again. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/**
 * Excalidraw asks for a file's name before it reads the file, and shows what is thrown as its own
 * error. Answering nothing leaves it to name the file by its hash, as it does by default.
 */
const nameImage = (file: File): string => {
  if (!IMAGE_TYPES.has(file.type))
    throw new Error('A board takes PNG, JPEG, WebP and GIF images, and this is none of them.');
  if (file.size > MOST_IMAGE_BYTES)
    throw new Error(
      `This image is ${(file.size / 1024 / 1024).toFixed(1)} MiB; a board takes up to 10 MiB.`,
    );
  return undefined as never;
};
/**
 * Whether Excalidraw is adding an image: it holds that very shape, and restoring the scene now
 * would replace it, or drop it as too small to see, so what others drew waits until it is placed.
 */
const addingImage = (api: ExcalidrawImperativeAPI) => {
  const { pendingImageElementId, newElement } = api.getAppState();
  return (
    !!pendingImageElementId ||
    newElement?.type === 'image' ||
    api.getSceneElements().some((el) => el.type === 'image' && !el.fileId)
  );
};
/** Whether the person is in the middle of something, which what others drew then waits for. */
const busy = (api: ExcalidrawImperativeAPI) => {
  const state = api.getAppState();
  return (
    addingImage(api) ||
    !!state.resizingElement ||
    state.isResizing ||
    state.isRotating ||
    state.selectedElementsAreBeingDragged ||
    !!state.selectedLinearElement?.isDragging ||
    !!(
      state.newElement ||
      state.multiElement ||
      state.selectionElement ||
      state.editingTextElement ||
      state.editingLinearElement
    )
  );
};
/** The card a selection is, as the link popup reads it: one linked shape, or a card's group. */
const cardOf = (selected: readonly OrderedExcalidrawElement[]) => {
  const card = selected.find((el) => el.link);
  return card &&
    selected.every(
      (el) => el === card || (el.customData?.card && el.groupIds[0] === card.groupIds[0]),
    )
    ? card
    : undefined;
};
/** Where shapes stand together. */
const rectOf = (shapes: readonly OrderedExcalidrawElement[]): Rect => {
  const [x, y, right, bottom] = getCommonBounds(shapes);
  return { x, y, width: right - x, height: bottom - y };
};
/** The width a picture lands at, unless it would not fit the view at this zoom. */
const PICTURE_WIDTH = 640;
/** A card's size, and a picture's shape, before Board has drawn it. */
const CARD = { width: 280, height: 110 };
const PICTURE_SHAPE = 0.75;

/** `onSummary` hears what each poll says of the board itself: its title, revision and paper. */
export type CanvasProps = {
  id: string;
  onSummary?(board: BoardScene['board']): void;
  /** What the board's menu holds, where the app has its own. */
  menu?: ReactNode;
  overlays?(api: ExcalidrawImperativeAPI, board: BoardScene['board']): ReactNode;
  toolbar?(api: ExcalidrawImperativeAPI | null): ReactNode;
};

function AgentBridge({
  voice,
  turning,
  voiced,
  player,
}: {
  voice: React.MutableRefObject<NonNullable<ReturnType<typeof useAgent>>['voice'] | undefined>;
  turning: React.MutableRefObject<boolean>;
  voiced: React.MutableRefObject<boolean>;
  player: React.MutableRefObject<Player | undefined>;
}) {
  const agent = useAgent();
  voice.current = agent?.voice;
  turning.current = !!agent?.pi?.active;
  voiced.current ||= turning.current;
  const steered = agent?.voice.steered;
  useEffect(() => {
    if (steered) player.current?.hurry();
  }, [steered]);
  const halted = agent?.voice.halted;
  useEffect(() => {
    if (halted) player.current?.hurry();
  }, [halted]);
  return null;
}

function BoardCanvasScene({ id, onSummary, menu, overlays, toolbar }: CanvasProps) {
  const session = useContext(SessionContext);
  // Cleanup and queued saves retain the project that rendered this canvas.
  const [owner] = useState(() => session?.owner ?? null);
  const navigate = useNavigate();
  const rows = useRows();
  const theme = useSyncExternalStore(onWorn, worn);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  useEffect(() => {
    if (!api) return;
    const seen = () => {
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      return { x: -scrollX, y: -scrollY, width: width / zoom.value, height: height / zoom.value };
    };
    boardInView = seen;
    return () => {
      if (boardInView === seen) boardInView = undefined;
    };
  }, [api]);
  const [readingReference, setReadingReference] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** Whether anything is drawn here since it opened: with its revision, whether there is a past. */
  const [drawnOn, setDrawnOn] = useState(false);
  /** The pen's width while the pen is in hand; nothing otherwise. */
  const [pen, setPen] = useState<number>();
  /** The card whose popup opened as it was selected, so a closed popup stays closed. */
  const opened = useRef<string | null>(null);
  /** What is being placed, so what is added next lands beside it and not on it. */
  const placing = useRef(Promise.resolve());
  const current = useCurrent();
  /** Asks Board for what changed now, as the poll does. */
  const pull = useRef<() => Promise<void>>();
  const previousZoom = useRef<number>();
  const previousElements = useRef<number>();
  const previousImageView = useRef<string>();
  /** A save that failed is tried again at the next move of any kind, not only the next edit. */
  const unsavedAfterFailure = useRef(false);
  const [first, setFirst] = useState<BoardScene | null>(null);
  /** Authored paper belongs to the board; style preferences are only agent context. */
  const [paper, setPaper] = useState('#ffffff');
  const [problem, setProblem] = useState<string | null>(null);
  /** Each try at opening the board; trying again only reads it once more. */
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  /** Each shape's identity as Board last sent it or acknowledged its save. */
  const known = useRef(new Map<string, ShapeStamp>());
  const revision = useRef(0);
  /**
   * The next look reads all of the board, not what changed after the revision in hand, and lands it
   * at once: after a change that did not apply, a lost connection, or a replay. `force` lands it even
   * with a hand down, as on leaving a replay, where nothing can have been being drawn.
   */
  const resync = useRef<{ force: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** The person's unsaved shapes as they last stood, whose change alone puts off their save. */
  const unsaved = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  /** The shapes as Excalidraw last drew them, read after it unmounts and empties its own scene. */
  const scene = useRef<readonly OrderedExcalidrawElement[]>([]);
  const files = useRef<BinaryFiles>({});
  /** The files Board holds, as far as this page knows, and those asked of it, once each. */
  const onBoard = useRef(new Set<string>());
  const bring = useMemo(
    () => api && imageBringer(api, (fileId) => onBoard.current.add(fileId), true),
    [api],
  );
  useEffect(() => {
    bring?.resume();
    return () => bring?.dispose();
  }, [bring]);
  /** Shows what others drew, as they drew it, on a canvas above the board. */
  const player = useRef<Player>();
  // A hand coming down stops the voice talking over it, as it stops the pen.
  const voice = useRef<NonNullable<ReturnType<typeof useAgent>>['voice']>();
  // Only Pi's turn has the voice, up to the last of the ink it left the pen when the turn ended:
  // what another agent says is for the line on the board.
  const turning = useRef(false);
  const turned = useRef(0);
  const voiced = useRef(false);
  // The agent on the Mac the voice is connected to says its own lines as its pen reaches them, while its
  // turn runs and a while after; its backend keeps that window. Who drew each line is kept as it lands.
  const drawers = useRef(new Map<string, string>());
  // Where a voice says the lines, each look tells the board how many it has still to hand to it:
  // the drawer's next call waits on that, so the model is never far ahead of what has been heard.
  const telling = useRef<() => { unsaid?: number }>(() => ({}));
  /** Whether a voice is on, and so says every line drawn here. */
  const speaks = () =>
    !!voice.current && voice.current.state !== 'off' && voice.current.state !== 'closing';
  telling.current = () =>
    speaks() ? { unsaid: (player.current?.unsaid ?? 0) + (voice.current!.behind() ? 1 : 0) } : {};
  /** New ink was fetched: a moment of the timing record. */
  const inked = useRef(() => {});
  inked.current = () => voice.current?.mark('ink');
  // What the page draws in Merv's name, its greeting, is heard as Pi's own ink is.
  useEffect(() => {
    const voicing = () => {
      voiced.current = true;
      turned.current = Date.now();
      void pull.current?.();
    };
    addEventListener(VOICE_PEN, voicing);
    return () => removeEventListener(VOICE_PEN, voicing);
  }, []);
  const reveal = useRef<HTMLCanvasElement>(null);
  const input = useRef<ReturnType<typeof boardInput>>();
  useEffect(() => {
    const root = reveal.current?.parentElement;
    if (!api || !root) return;
    const handle = boardInput(root, api);
    input.current = handle;
    return () => {
      handle();
      input.current = undefined;
    };
  }, [api]);
  /** Shows where agents are on the board, as Excalidraw shows collaborators. */
  const presence = useRef<BoardPresence>();
  /** Keeps what agents draw in view, until the person's hand is on the board. */
  const follow = useRef<BoardFollow>();
  /** What the last poll brought that waits for the person to finish. */
  const waiting = useRef(0);
  /** Gathers what the person points at, to go with what they say to Pi. */
  const pointing = useRef<BoardPointing>();
  /** Whether the person's hand was on the board at the last change, drawing or changing a shape,
   *  and since when. */
  const handDown = useRef(false);
  const handDownAt = useRef(0);
  const focusBoard = () =>
    reveal.current?.parentElement?.querySelector<HTMLElement>(':scope > .excalidraw')?.focus();

  useEffect(() => {
    let live = true;
    setProblem(null);
    setSlow(false);
    const slowly = setTimeout(() => live && setSlow(true), SLOW_MS);
    void call<BoardScene>('board.scene', { id, appearance: worn() })
      .then(async (scene) => {
        // Fonts measure text right, but a font that fails or crawls in never keeps the board shut:
        // Excalidraw loads them again itself and redraws the text once they come.
        await Promise.race([
          ensureBoardFonts(scene.elements).catch(() => undefined),
          new Promise((done) => setTimeout(done, FONTS_MS)),
        ]);
        if (!live) return;
        for (const el of scene.elements) known.current.set(el.id, stampOf(el));
        revision.current = scene.board.revision;
        setPaper(scene.board.paper ?? '#ffffff');
        setFirst(scene);
      })
      .catch((error: Error) => live && setProblem(error.message))
      .finally(() => clearTimeout(slowly));
    return () => {
      live = false;
      clearTimeout(slowly);
    };
  }, [id, attempt]);

  // Whatever presses Excalidraw's own buttons by itself waits until it has loaded (board-ready.ts).
  useEffect(() => () => setBoardLoaded(false), []);
  // Should "Loading scene..." outlive loading anyway, it is taken off, the board's shapes kept.
  useEffect(() => {
    if (!api || !first) return;
    const watch = setTimeout(() => {
      try {
        if (unstick(api, () => restored(first.elements, true), CaptureUpdateAction.NEVER))
          console.warn('Excalidraw was left loading the board; it is shown now.');
      } catch (error) {
        setProblem(`The board could not be shown: ${(error as Error).message}`);
      }
    }, STUCK_MS);
    return () => clearTimeout(watch);
  }, [api, first]);

  const save = useCallback(async () => {
    const previous = saving.current;
    // Reserve this request before yielding, so later requests see its acknowledgments.
    const run = (async () => {
      await previous;
      const changed = scene.current.filter((el) => needsSave(known.current.get(el.id), el));
      if (!changed.length) return;
      // An image's bytes go first, so nobody is ever handed a shape Board cannot show them.
      const unsent = new Set<FileId | null>();
      for (const fileId of new Set(changed.filter((el) => !el.isDeleted).map(fileOf))) {
        const held = fileId && !onBoard.current.has(fileId) && files.current[fileId];
        if (!held) continue;
        const blob = await (await fetch(held.dataURL)).blob();
        const raw = await blob.arrayBuffer();
        await accountRequest(imageAt(fileId), { method: 'PUT', raw, scoped: true, owner }).then(
          () => onBoard.current.add(fileId),
          (error: ApiError) => {
            unsent.add(fileId);
            // Board will not take it, so its shape goes; anything else is tried at the next save.
            if (error.status === 413 || error.status === 415)
              api?.updateScene({
                elements: scene.current.map((el) =>
                  fileOf(el) === fileId ? newElementWith(el, { isDeleted: true }) : el,
                ),
                appState: { errorMessage: error.message },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            else setProblem(`Image not added: ${error.message}`);
          },
        );
      }
      const ready = changed.filter((el) => !unsent.has(fileOf(el)));
      for (let at = 0; at < ready.length; at += 500) {
        const part = ready.slice(at, at + 500);
        // Excalidraw mutates these objects while the request is in flight. Remember only what
        // this call sends, and leave any observation that lands after it alone.
        const sent = part.map((el) => ({
          id: el.id,
          stamp: stampOf(el),
          before: known.current.get(el.id),
        }));
        await call('board.save', { id, elements: part }, owner);
        for (const item of sent)
          if (known.current.get(item.id) === item.before) known.current.set(item.id, item.stamp);
      }
      if (unsent.size) unsavedAfterFailure.current = true;
      else setProblem(null);
    })().catch((error: Error) => {
      unsavedAfterFailure.current = true;
      setProblem(`Not saved: ${error.message}`);
    });
    saving.current = run;
    await run;
    if (saving.current === run) saving.current = null;
  }, [id, api, owner]);

  // While the chat has the window the board is a small live card beside it: its zoom row and its change of size ask here.
  useEffect(() => (api ? lendBoardCard(boardCardOf(api)) : undefined), [api]);

  // A board opens with all of it in view, zoomed out as far as that takes and never in; with
  // ?focus=<shape or frame id> it opens on that part, large enough to read.
  const [search] = useSearchParams();
  const focus = search.get('focus');
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => {
      const all = api.getSceneElements();
      const part = focus ? all.filter((el) => el.id === focus) : [];
      const scale = boardScale();
      if (part.length) fitView(api, part, 2 * scale);
      else fitView(api, all, scale, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [api, focus]);

  // Text is measured as it is drawn; drawn before the hand-drawn font arrived, it was measured in
  // another and would be cut short, so it is measured again once the font is in.
  useEffect(() => {
    if (!api) return;
    let disposed = false,
      pending = false;
    const measure = () => {
      if (disposed) return;
      if (busy(api)) {
        pending = true;
        return;
      }
      pending = false;
      api.updateScene({
        elements: restoreElements(api.getSceneElementsIncludingDeleted(), null, {
          refreshDimensions: true,
          repairBindings: true,
        }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    const off = api.onChange(() => {
      if (pending && !busy(api)) measure();
    });
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true;
      document.fonts.removeEventListener('loadingdone', measure);
      off();
    };
  }, [api]);

  useEffect(() => {
    if (!api || !reveal.current) return;
    const land = (shapes: BoardElement[]) => {
      for (const el of shapes) known.current.set(el.id, stampOf(el));
      pointing.current?.landed(shapes);
      presence.current?.drew();
    };
    // The pen waits for the voice to catch up, but never for good: a voice left with lines it will
    // not say (its turn lost, its session gone quiet) must not keep ink off the board.
    let voiceHeld = 0;
    const voiceHolds = () => {
      if (!speaks() || !voice.current?.behind()) return ((voiceHeld = 0), false);
      voiceHeld ||= Date.now();
      return Date.now() - voiceHeld < VOICE_HOLD_MS;
    };
    const made = new Player(
      stageOf(api, () => busy(api) || voiceHolds(), land, bring!),
      reveal.current,
      PEN_BEHIND_MS,
    );
    player.current = made;
    const here = new BoardPresence(api);
    presence.current = here;
    made.pen = (tip) => {
      if (tip) voice.current?.mark('pen');
      here.pen(tip);
    };
    made.say = (line, shapes) => {
      here.said(line);
      const by = shapes.map((shape) => drawers.current.get(shape.id)).find(Boolean);
      for (const shape of shapes) drawers.current.delete(shape.id);
      // With the voice on, every line drawn on this board is heard, whoever drew it.
      const who = sayer(voice.current?.state, !!voice.current?.route);
      if (who === 'pi') voice.current?.speak(line, true);
      else if (who === 'agent') voice.current?.agentSaid(line, by ?? 'agent');
    };
    const pen = voice.current?.drawing;
    if (pen) pen.current = () => made.waiting > 0;
    const hand = new BoardPointing(api, id);
    hand.landed(first?.elements ?? []);
    pointing.current = hand;
    const board = reveal.current.parentElement!.querySelector(':scope > .excalidraw')!;
    const camera = new BoardFollow(api, board, () => busy(api));
    follow.current = camera;
    const unpoint = pointWith({
      note() {
        // Saying something to Pi is watching for its answer, and what Pi was drawing is by the way;
        // what they point at stays in view beside it.
        camera.following = true;
        const chosen = hand.selection();
        if (chosen) camera.anchor(chosen);
        made.hurry();
        return hand.note();
      },
      said: hand.said,
    });
    const lifts = ['pointerup', 'pointercancel', 'keyup', 'gestureend'];
    for (const kind of lifts)
      window.addEventListener(kind, camera.rest, { capture: true, passive: true });
    const hands = ['pointerdown', 'wheel', 'keydown', 'gesturestart'];
    for (const kind of hands)
      board.addEventListener(kind, camera.release, { capture: true, passive: true });
    return () => {
      if (pen) pen.current = () => false;
      made.stop();
      here.stop();
      hand.stop();
      camera.release();
      for (const kind of lifts) window.removeEventListener(kind, camera.rest, { capture: true });
      for (const kind of hands) board.removeEventListener(kind, camera.release, { capture: true });
      unpoint();
    };
  }, [api, id]);
  // Under a replay, what others draw lands as it comes, to be there on return.
  const wasReplaying = useRef(false);
  useEffect(() => {
    if (!player.current) return;
    if (replaying) {
      if (!busy(api!)) player.current.finish();
      else player.current.hurry();
    }
    // Pressing Play is a hand on the board: the view is no longer the agent's to move.
    if (replaying) follow.current?.release();
    player.current.instant = replaying;
    // Back from one, the focus is on the board again, as a paste needs it, unless it has moved on.
    const focused = document.activeElement;
    if (
      !replaying &&
      wasReplaying.current &&
      (!focused || focused === document.body || focused.closest('.board-canvas'))
    )
      focusBoard();
    // Back at now, the board is Board's latest, read again, whatever this page had taken in before.
    if (!replaying && wasReplaying.current) {
      resync.current = { force: true };
      void pull.current?.();
    }
    wasReplaying.current = replaying;
  }, [replaying]);

  // What others drew since the revision in hand: played in the order they drew it, around what the
  // person is doing, and all of it after what the page already holds (its own saves, come back).
  useEffect(() => {
    if (!api) return;
    // One ask at a time: a slow answer is never overtaken, so the revision never goes back. Every
    // wait in a look is bounded, so a look that hangs can never keep the next ones from asking.
    let [live, asking, heldBack] = [true, false, false];
    let catchUp = false;
    /** Looks in a row whose answer did not apply. */
    let failed = 0;
    const ask = async () => {
      if (!live || document.hidden) return;
      if (asking) {
        catchUp = true;
        return;
      }
      asking = true;
      // Read all of it again, as asked, or what changed after the revision in hand.
      const again = resync.current;
      try {
        const scene = await within(
          call<BoardScene>('board.scene', {
            id,
            ...(!again && { since: revision.current }),
            appearance: worn(),
            ...telling.current(),
          }),
          LOOK_MS,
          null,
        );
        if (!live || document.hidden) return;
        if (scene) {
          onSummary?.(scene.board);
          setPaper(scene.board.paper ?? '#ffffff');
          // A font that fails or crawls never holds the board back: text is measured again once
          // the font comes (the fonts effect above).
          await within(ensureBoardFonts(scene.elements), FONTS_MS, undefined);
        }
        if (!live || document.hidden) return;
        if (scene?.looking) presence.current?.heard(scene.looking);
        // What waits for the person, once each: a label with its shape, a group of strokes as one.
        waiting.current =
          live && scene && busy(api)
            ? new Set(
                scene.elements
                  .filter((el) => !sameStamp(known.current.get(el.id), el) && !el.containerId)
                  .map((el) => (el.groupIds as string[] | undefined)?.[0] ?? el.id),
              ).size
            : 0;
        if (!live || !scene) return;
        const whole = !!again || !!scene.whole;
        if (!scene.elements.length && !whole) {
          revision.current = Math.max(revision.current, scene.board.revision);
          return;
        }
        if (input.current?.active() || (busy(api) && !again?.force)) {
          heldBack = true;
          return;
        }
        try {
          if (whole) {
            // Told it all (a deletion after the revision in hand was purged, or read again): a shape
            // held here as Board last had it, and not among them, is gone.
            player.current!.finish();
            const named = new Set(scene.elements.map((el) => el.id));
            api.updateScene({
              elements: api
                .getSceneElementsIncludingDeleted()
                .filter((el) => named.has(el.id) || !sameStamp(known.current.get(el.id), el)),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            player.current!.stage.show(scene.elements, true);
          } else {
            const held = api.getSceneElementsIncludingDeleted();
            const same = new Set(held.map((el) => `${el.id}/${el.version}/${el.versionNonce}`));
            const fresh = stacked(scene.elements).filter(
              (el) => !same.has(`${el.id}/${el.version}/${el.versionNonce}`),
            );
            const drew = !!fresh.length && !!presence.current?.drew();
            // Who drew a line it brings, as far as the page knows: the agent heard of just now.
            const by = drew ? presence.current?.doing().name : undefined;
            if (drawers.current.size > 1000) drawers.current.clear();
            if (by)
              for (const el of fresh)
                if (typeof (el.customData as { say?: unknown } | undefined)?.say === 'string')
                  drawers.current.set(el.id, by);
            // The view goes ahead of the ink, so a stroke is watched as it is drawn.
            if (
              fresh.length &&
              (drew ||
                fresh.some(
                  (el) =>
                    el.customData &&
                    typeof el.customData === 'object' &&
                    !Array.isArray(el.customData) &&
                    el.customData.by === 'agent',
                ))
            )
              follow.current?.expect(fresh, held);
            if (drew) inked.current();
            player.current!.add(fresh);
            // What came while their hand was down lands now, as what was being played did.
            if (heldBack) player.current!.hurry();
          }
        } catch (error) {
          // Not taken in: the revision stays, so nothing after it is skipped, and the next look reads
          // all of the board again. Twice in a row, this page's code is too old for what Board sends.
          console.warn('A board change did not apply; reading all of the board again.', error);
          resync.current = { force: !!again?.force };
          if (++failed >= MOST_FAILED_LOOKS) reloadWhenSafe();
          else catchUp = true;
          return;
        }
        // Taken in: only now does the page hold this revision.
        revision.current = whole
          ? scene.board.revision
          : Math.max(revision.current, scene.board.revision);
        if (resync.current === again) resync.current = null;
        heldBack = false;
        failed = 0;
      } finally {
        asking = false;
        // A look requested during this one gets a fresh poll as soon as it settles.
        if (catchUp && live) {
          catchUp = false;
          void ask();
        }
      }
    };
    pull.current = ask;
    const visible = () => {
      if (document.hidden) {
        // Reconcile protects an active gesture: retain queued ink until it can actually land.
        if (!busy(api)) player.current?.finish();
      } else {
        follow.current?.visible();
        void ask();
      }
    };
    document.addEventListener('visibilitychange', visible);
    // Quicker while an agent draws, so ink starts soon after the shape was made.
    let asked = Date.now();
    let told = telling.current().unsaid;
    const every = setInterval(() => {
      if (document.hidden) return;
      if (turning.current) turned.current = Date.now();
      else if (!player.current?.waiting && Date.now() - turned.current > LAST_INK_MS)
        voiced.current = false;
      const drew = (presence.current?.doing().drewMs ?? Infinity) < DRAWING_MS;
      const unsaid = telling.current().unsaid;
      // A live voice keeps its telling fresh even between drawings.
      const gap =
        drew || player.current?.waiting || told !== unsaid
          ? ASK_DRAWING_MS
          : unsaid !== undefined
            ? ASK_VOICE_MS
            : ASK_MS;
      if (Date.now() - asked < gap) return;
      told = unsaid;
      asked = Date.now();
      void ask();
    }, ASK_DRAWING_MS);
    return () => {
      live = false;
      clearInterval(every);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [api, id]);

  // New ink is fetched as it lands: the page waits for committed board changes, and
  // looks the moment it is told. The periodic look above is a safety net.
  useEffect(() => {
    if (!api) return;
    let live = true;
    let past = 0;
    /** The last wait had no answer: the connection was lost, or Board was being replaced. */
    let lost = false;
    const idle = (ms: number) => new Promise((done) => setTimeout(done, ms));
    void (async () => {
      while (live) {
        if (document.hidden) {
          await idle(1000);
          continue;
        }
        const before = revision.current;
        const told = await call<{ revision: number }>('board.wait', {
          id,
          since: Math.max(before, past),
        }).catch(() => null);
        if (!live) return;
        // Back after a lost connection: what came meanwhile is read whole, not trusted to deltas.
        if (told && lost) {
          resync.current ??= { force: false };
          await pull.current?.();
        } else if (told && told.revision > revision.current) await pull.current?.();
        lost = !told;
        // Not moved on (a hand is down, a look was already under way, or no answer): never a tight loop.
        if (told && revision.current === before) past = told.revision;
        if (!told || revision.current === before) await idle(told ? 300 : 3000);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, id]);

  // A theme switch must reach task exports without waiting for the next periodic read.
  useEffect(() => {
    void pull.current?.();
  }, [theme]);

  // Native shells need their own navigation confirmation policy before enabling this guard.
  useEffect(() => {
    if (/\b(MervDesk|Electron|MervAndroid|MerviOS)\//.test(navigator.userAgent)) return;
    const leaving = (event: BeforeUnloadEvent) => {
      if (!scene.current.some((el) => needsSave(known.current.get(el.id), el))) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);

  // What is drawn is saved when the page is left or hidden, as well as a moment after it.
  useEffect(() => {
    const release = holdStaleBuild(
      () => !!saving.current || scene.current.some((el) => needsSave(known.current.get(el.id), el)),
    );
    const flush = () => document.visibilityState === 'hidden' && void save();
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      clearTimeout(timer.current);
      void save().finally(release);
    };
  }, [save]);

  // The panel takes ⌘K ahead of Excalidraw, whose own use of it opens the link editor (still on the
  // chosen shape's Link button): wherever the board has the keys, and never from something being
  // written in, a dialog of Excalidraw's or a replay.
  const openPanel = () => {
    follow.current?.release();
    api?.updateScene({ appState: { showHyperlinkPopup: false } });
    setAdding(true);
  };
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const target = event.target as Element;
      if (
        !asksToAdd(event) ||
        typing(target) ||
        !(target === document.body || target.closest('.board-canvas')) ||
        replaying ||
        !api ||
        api.getAppState().openDialog
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, [api, replaying]);

  const draw = async (op: Record<string, unknown>) =>
    (
      await call<{ created: Record<string, string> }>('board.write:draw', {
        board: id,
        ops: [{ key: 'item', ...op }],
      })
    ).created.item!;
  /** Asks Board for what it just drew until the scene holds it, and answers its shapes. */
  const landed = async (drawn: string) => {
    const until = Date.now() + 30_000;
    // A gesture or hidden tab can wait, but never keep fetching indefinitely.
    for (
      let tries = 0;
      tries < 20 && current() && Date.now() < until;
      tries += busy(api!) || document.hidden ? 0 : 1
    ) {
      await pull.current?.();
      // What the person added is never played back to them.
      if (!busy(api!)) player.current?.finish();
      const scene = api!.getSceneElements();
      const shape = scene.find((el) => el.id === drawn);
      if (shape) {
        const group = shape.groupIds[0];
        return group ? scene.filter((el) => el.groupIds[0] === group) : [shape];
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return [];
  };
  // What is added lands beside what is chosen, or in the middle of the view, and each next to the
  // one before, and ends up chosen, so it can be moved from there at once.
  const place = async (items: CardPick[]) => {
    if (!api) return;
    const { selectedElementIds, scrollX, scrollY, zoom, width, height } = api.getAppState();
    const view = {
      x: -scrollX,
      y: -scrollY,
      width: width / zoom.value,
      height: height / zoom.value,
    };
    const chosen = api.getSceneElements().filter((el) => selectedElementIds[el.id]);
    const added = new Set<string>();
    const shapesOf = (ids: Set<string>) => api.getSceneElements().filter((el) => ids.has(el.id));
    const besideWhat = () => {
      const beside = added.size ? shapesOf(added) : chosen;
      return beside.length ? rectOf(beside) : undefined;
    };
    const rests = (shapes: readonly OrderedExcalidrawElement[]) =>
      api
        .getSceneElements()
        .filter((el) => !shapes.includes(el))
        .map((el) => rectOf([el]));
    for (const { target, text, fact, picture } of items) {
      if (!current()) return;
      const wide = Math.max(20, Math.min(PICTURE_WIDTH, view.width * 0.6));
      const size = picture ? { width: wide, height: wide * PICTURE_SHAPE } : CARD;
      const at = landing(size, rests([]), besideWhat(), view);
      const card = { op: 'link', target, text, ...(fact && { fact }), at };
      const drawing = picture
        ? draw({
            op: 'image',
            artifactId: target,
            at,
            ...(wide < PICTURE_WIDTH && { width: wide }),
          }).catch((error: ApiError) => {
            // Refused, it stays a card; with no answer it may be there, and a card would be a second.
            if (!error.status || error.code.startsWith('http_')) throw error;
            return draw(card);
          })
        : draw(card);
      const drawn = await drawing.catch(
        (error: Error) => void setProblem(`Not added: ${error.message}`),
      );
      const shapes = drawn ? await landed(drawn) : [];
      if (!shapes.length) continue;
      // Only now is its true height known: one taller than was allowed for moves off what it covers.
      const rect = rectOf(shapes);
      const others = rests(shapes);
      if (others.some((other) => overlaps(other, rect))) {
        const [x, y] = landing(rect, others, besideWhat(), view);
        const moved = new Set(shapes.map((el) => el.id));
        api.updateScene({
          elements: api
            .getSceneElementsIncludingDeleted()
            .map((el) =>
              moved.has(el.id)
                ? newElementWith(el, { x: el.x + x - rect.x, y: el.y + y - rect.y })
                : el,
            ),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      for (const el of shapes) added.add(el.id);
    }
    const shapes = shapesOf(added);
    if (!shapes.length) return;
    if (!inView(rectOf(shapes), view)) fitView(api, shapes, zoom.value);
    api.setActiveTool({ type: 'selection' });
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(shapes.map((el) => [el.id, true])),
        selectedGroupIds: Object.fromEntries(
          shapes.flatMap((el) => (el.groupIds[0] ? [[el.groupIds[0], true]] : [])),
        ),
      },
    });
  };

  // Paper and ink must use the same rendering transform. In particular, Khan's bright ink
  // belongs on its authored black paper even when the surrounding app changes appearance.
  const canvasAppearance = boardAppearance(paper, theme);
  const defaultInk = isDark(paper) ? '#f5f5f5' : '#1e1e1e';
  // With the palm in hand (a phone's start), a tap on a card still opens it.
  useEffect(() => {
    const surface = api && document.querySelector<HTMLElement>('.excalidraw');
    return api && surface ? tapOpens(api, surface) : undefined;
  }, [api]);
  useEffect(() => {
    if (!api) return;
    api.updateScene({
      appState: { viewBackgroundColor: canvasAppearance.viewBackgroundColor },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, canvasAppearance.viewBackgroundColor]);
  useEffect(() => {
    if (!api) return;
    api.updateScene({
      appState: { currentItemStrokeColor: defaultInk },
      // Appearance changes must not reset a person's chosen pen or create undo steps.
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, defaultInk]);
  // What the replay and the board have in common.
  const editor: ComponentProps<typeof Excalidraw> = {
    theme: canvasAppearance.theme,
    aiEnabled: false,
    validateEmbeddable: false,
    UIOptions: {
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
        export: false,
        toggleTheme: false,
      },
    },
    renderHyperlinkDetails: (element, close) => (
      <BoardLinkDetails key={element.id} element={element} close={close} theme={theme} />
    ),
    onLinkOpen: (element, event) => {
      const link = element.link ?? '';
      if (!link.startsWith('merv:') || link === PAGE_LINK) return;
      // A card names a record by id; it opens where a link to that record would.
      event.preventDefault();
      void placeOf({ record: link.slice('merv:'.length) }, rows).then(
        (place) => typeof place !== 'string' && navigate(place.path),
        () => undefined,
      );
    },
  };

  const initialElements = useMemo(() => (first ? restored(first.elements, true) : []), [first]);
  const again = (
    <button type="button" className="board-loading-retry" onClick={() => setAttempt((n) => n + 1)}>
      Try again
    </button>
  );
  if (problem && !first)
    return (
      <div className="board-loading" role="alert">
        <p className="pi-error">{problem}</p>
        {again}
      </div>
    );
  if (!first)
    return (
      <div className="board-loading" aria-live="polite">
        <p className="muted">{slow ? 'Still opening the board…' : 'Opening the board…'}</p>
        {slow && again}
      </div>
    );
  return (
    <div
      className={`board-canvas${readingReference ? ' board-reading-reference' : ''}${replaying ? ' is-replaying' : ''}`}
    >
      <AgentBridge voice={voice} turning={turning} voiced={voiced} player={player} />
      {problem && (
        <p className="pi-error board-problem" role="alert">
          {problem}
        </p>
      )}
      <BoardPenSize
        pen={pen}
        onChange={(width) =>
          api?.updateScene({
            appState: { currentItemStrokeWidth: width },
            captureUpdate: CaptureUpdateAction.NEVER,
          })
        }
      />
      {adding && (
        <CardPicker
          board={id}
          close={() => {
            setAdding(false);
            focusBoard();
          }}
          add={(items) => {
            placing.current = placing.current
              .then(() => place(items))
              .catch((error: Error) => setProblem(`Not added: ${error.message}`));
          }}
        />
      )}
      <Excalidraw
        {...editor}
        excalidrawAPI={setApi}
        // Excalidraw takes a paste only with the focus inside it: the page is the board, so at once.
        autoFocus
        generateIdForFile={nameImage}
        onPointerUpdate={({ pointer, button }) => pointing.current?.moved(pointer, button)}
        initialData={{
          elements: initialElements,
          appState: { ...canvasAppearance, currentItemStrokeColor: defaultInk },
        }}
        onChange={(elements: readonly OrderedExcalidrawElement[], appState, held) => {
          // Excalidraw reports changes only once its scene has loaded.
          setBoardLoaded(true);
          const zoomChanged =
            previousZoom.current !== undefined && previousZoom.current !== appState.zoom.value;
          previousZoom.current = appState.zoom.value;
          setPen(
            appState.activeTool.type === 'freedraw' ? appState.currentItemStrokeWidth : undefined,
          );
          // No laser, by shortcut either: the mouse is enough.
          if (appState.activeTool.type === 'laser') api?.setActiveTool({ type: 'selection' });
          scene.current = elements;
          files.current = held;
          // Excalidraw draws ink itself. Overlay, image and save scans wait for lift;
          // refs still retain every point for a visibility/unmount flush.
          if (appState.newElement?.type === 'freedraw') {
            if (!handDown.current) {
              handDown.current = true;
              handDownAt.current = Date.now();
              player.current?.hurry();
              if (speaks()) voice.current?.hush();
              void call('board.hand', { id }).catch(() => undefined);
            }
            clearTimeout(timer.current);
            timer.current = undefined;
            return;
          }
          // Reading a linked card should not open the shape styling controls.
          const selected = elements.filter((element) => appState.selectedElementIds[element.id]);
          setReadingReference(
            selected.length > 0 &&
              selected.every(
                (element) =>
                  Boolean(
                    element.link || element.customData?.card || element.customData?.proposed,
                  ) ||
                  (element.type === 'text' &&
                    Boolean(
                      elements.find((container) => container.id === element.containerId)?.link,
                    )),
              ),
          );
          if (zoomChanged && appState.showHyperlinkPopup) {
            api?.updateScene({ appState: { showHyperlinkPopup: false } });
          }
          // A card opens what it holds as it is chosen; the pointer need not find its edge first.
          const card = cardOf(selected);
          if (card && opened.current !== card.id && !appState.showHyperlinkPopup)
            api?.updateScene({ appState: { showHyperlinkPopup: 'info' } });
          opened.current = card?.id ?? null;
          scene.current = elements;
          files.current = held;
          const version = hashElementsVersion(elements);
          const changed = version !== previousElements.current;
          const imageView = [
            appState.scrollX,
            appState.scrollY,
            appState.zoom.value,
            appState.width,
            appState.height,
          ].join(',');
          // Lazy images become visible on a pan, zoom or resize without any shape changing.
          if (bring && (changed || imageView !== previousImageView.current)) {
            previousElements.current = version;
            previousImageView.current = imageView;
            bring(elements, held);
          }
          if (changed) {
            setDrawnOn(elements.length > 0);
          }
          // The person has taken up the pen: an agent drawing hears it now, and what it had drawn
          // stops being played, so the board they are working on is as it stands.
          const down = !!(
            appState.newElement ||
            appState.multiElement ||
            appState.editingTextElement ||
            appState.editingLinearElement ||
            appState.isResizing ||
            appState.isRotating ||
            appState.selectedElementsAreBeingDragged
          );
          if (down && !handDown.current) {
            handDownAt.current = Date.now();
            player.current?.hurry();
            if (speaks()) voice.current?.hush();
            void call('board.hand', { id }).catch(() => undefined);
          }
          // A mark on an agent's drawing asks it to answer there: the view waits on that spot.
          if (!down && handDown.current) {
            const mark = markOn(elements as never, handDownAt.current);
            if (mark) follow.current?.anchor(mark);
            if (waiting.current) void pull.current?.();
          }
          handDown.current = down;
          // Only the person's own shapes changing puts off their save: no cursor, camera or other
          // hand's shapes can, however often they move.
          if (!changed && !unsavedAfterFailure.current) return;
          unsavedAfterFailure.current = false;
          const dirt = elements.reduce(
            (sum, el) => (sameStamp(known.current.get(el.id), el) ? sum : sum + el.version),
            0,
          );
          if (!dirt) return;
          if (dirt === unsaved.current && timer.current) return;
          unsaved.current = dirt;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            void save();
          }, SAVE_MS);
        }}
        renderToolbarEnd={() => (
          <>
            <AddButton key="merv-add" onClick={openPanel} />
            {toolbar?.(api)}
            <BoardTools key="merv-tools" api={api} />
            <span key="merv-orb" className="board-orb-slot" ref={holdSlot} />
          </>
        )}
      >
        <MainMenu>
          {menu ?? (
            <>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.Help />
            </>
          )}
        </MainMenu>
      </Excalidraw>
      <canvas ref={reveal} className={`board-reveal is-${canvasAppearance.theme}`} />
      {api && <BoardSelection api={api} />}
      {api && <BoardTiles api={api} dark={theme === 'dark'} />}
      {api && <BoardItems api={api} />}
      {api && overlays?.(api, first.board)}
      <BoardTalk
        doing={() => {
          const said = presence.current?.doing();
          return {
            ...said,
            playing: !!player.current?.waiting && (said?.drewMs ?? Infinity) < BEHIND_MS,
            waiting: api && busy(api) ? waiting.current + (player.current?.waiting ?? 0) : 0,
          };
        }}
        following={() => !!follow.current?.following}
        jump={() => {
          follow.current?.resume(presence.current?.doing().region);
          focusBoard();
        }}
        stepIn={() => player.current?.hurry()}
      />
      {api && (drawnOn || first.board.revision > 0) && (
        <BoardReplay
          id={id}
          live={api}
          editor={editor}
          free={() => !busy(api)}
          settle={save}
          revision={() => revision.current}
          mode={setReplaying}
        />
      )}
    </div>
  );
}

/** A different board gets separate refs, pending saves, and first-scene state. */
export default function BoardCanvas(props: CanvasProps) {
  return <BoardCanvasScene key={props.id} {...props} />;
}
