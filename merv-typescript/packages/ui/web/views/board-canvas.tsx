/**
 * One board's canvas: Excalidraw, kept in step with Board. What the person draws is saved a moment
 * after they stop, as the shapes whose version Board has not seen; what anyone else (a colleague,
 * the agent) drew arrives by asking for what changed after the revision in hand, and is merged in
 * shape by shape as Excalidraw reconciles. An image's bytes reach Board before its shape does, and
 * each page brings in the bytes of what it is handed, under the same project membership.
 * Excalidraw's fonts are served from this app, never a CDN; embeds are off, since a board loads
 * nothing from elsewhere.
 */
import '@excalidraw/excalidraw/index.css';
import {
  useCallback,
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
  MainMenu,
  newElementWith,
  WelcomeScreen,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { MOST_IMAGE_BYTES, stacked, type BoardElement, type BoardScene } from '@merv/board/models';
import { accountRequest, type ApiError, call } from '../api';
import { ensureBoardFonts } from './board-fonts';
import { typing } from '../list-filters';
import { useCurrent } from '../mutations';
import { useRows } from '../navigation';
import { onWorn, worn } from '../theme';
import { placeOf } from './pi-screen';
import { pointWith } from './pi-transport';
import { BoardLinkDetails } from './board-link-details';
import { AddButton, asksToAdd, CardPicker, type CardPick } from './board-add';
import { inView, landing, overlaps, type Rect } from './board-place';
import { fileOf, fitView, imageAt, imageBringer, Player, restored, stageOf } from './board-player';
import { BoardFollow } from './board-follow';
import { BoardPointing } from './board-pointing';
import { BoardPresence } from './board-presence';
import { BoardProposal } from './board-proposal';
import { BoardReplay } from './board-replay';
import { BoardSessions, useAttached } from './board-session';
import { BoardTalk } from './board-talk';
import { useAgent } from './pi';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';

/** The shapes Board keeps; anything else stays on this page only. */
const KEPT = new Set('rectangle ellipse diamond text arrow line freedraw frame image'.split(' '));
const SAVE_MS = 600;
/** How often the page asks what changed, and how often while an agent has lately been drawing. */
const [ASK_MS, ASK_DRAWING_MS] = [1500, 400];
const DRAWING_MS = 20_000;
/** The most what others drew may be shown behind, in milliseconds of playing it. */
const BEHIND_MS = 4000;
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

/** `onOutcomes` hears what each poll says of the board's outcomes. */
type CanvasProps = {
  id: string;
  onOutcomes?(lines: BoardScene['outcomes']): void;
};

function BoardCanvasScene({ id, onOutcomes }: CanvasProps) {
  const navigate = useNavigate();
  const rows = useRows();
  const theme = useSyncExternalStore(onWorn, worn);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [readingReference, setReadingReference] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** Whether anything is drawn here since it opened: with its revision, whether there is a past. */
  const [drawnOn, setDrawnOn] = useState(false);
  /** The card whose popup opened as it was selected, so a closed popup stays closed. */
  const opened = useRef<string | null>(null);
  /** What is being placed, so what is added next lands beside it and not on it. */
  const placing = useRef(Promise.resolve());
  const current = useCurrent();
  /** Asks Board for what changed now, as the poll does. */
  const pull = useRef<() => Promise<void>>();
  const previousZoom = useRef<number>();
  const [first, setFirst] = useState<BoardScene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The version of each shape Board holds, as far as this page knows. */
  const known = useRef(new Map<string, number>());
  const revision = useRef(0);
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
    () => api && imageBringer(api, (fileId) => onBoard.current.add(fileId)),
    [api],
  );
  /** Shows what others drew, as they drew it, on a canvas above the board. */
  const player = useRef<Player>();
  // A hand coming down stops the voice talking over it, as it stops the pen.
  const agent = useAgent();
  const hush = useRef(agent?.voice.hush);
  hush.current = agent?.pi?.active ? agent.voice.hush : undefined;
  const steered = agent?.voice.steered;
  useEffect(() => {
    if (steered) player.current?.hurry();
  }, [steered]);
  const reveal = useRef<HTMLCanvasElement>(null);
  /** Shows where agents are on the board, as Excalidraw shows collaborators. */
  const presence = useRef<BoardPresence>();
  const attached = useAttached();
  /** Keeps what agents draw in view, until the person's hand is on the board. */
  const follow = useRef<BoardFollow>();
  /** What the last poll brought that waits for the person to finish. */
  const waiting = useRef(0);
  /** Gathers what the person points at, to go with what they say to Pi. */
  const pointing = useRef<BoardPointing>();
  /** Whether the person's hand was on the board at the last change, drawing or changing a shape. */
  const handDown = useRef(false);
  const focusBoard = () =>
    reveal.current?.parentElement?.querySelector<HTMLElement>(':scope > .excalidraw')?.focus();

  useEffect(() => {
    let live = true;
    void call<BoardScene>('board.scene', { id })
      .then(async (scene) => {
        await ensureBoardFonts(scene.elements);
        if (!live) return;
        for (const el of scene.elements) known.current.set(el.id, el.version);
        revision.current = scene.board.revision;
        setFirst(scene);
      })
      .catch((error: Error) => live && setProblem(error.message));
    return () => {
      live = false;
    };
  }, [id]);

  const save = useCallback(async () => {
    await saving.current;
    const changed = scene.current.filter(
      (el) =>
        KEPT.has(el.type) &&
        known.current.get(el.id) !== el.version &&
        (el.type !== 'image' || (el.fileId && el.width)),
    );
    if (!changed.length) return;
    const run = (async () => {
      // An image's bytes go first, so nobody is ever handed a shape Board cannot show them.
      const unsent = new Set<FileId | null>();
      for (const fileId of new Set(changed.filter((el) => !el.isDeleted).map(fileOf))) {
        const held = fileId && !onBoard.current.has(fileId) && files.current[fileId];
        if (!held) continue;
        const raw = Uint8Array.from(atob(held.dataURL.split(',')[1]!), (c) => c.charCodeAt(0));
        await accountRequest(imageAt(fileId), { method: 'PUT', raw, scoped: true }).then(
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
        await call('board.save', { id, elements: part });
        for (const el of part) known.current.set(el.id, el.version);
      }
      if (!unsent.size) setProblem(null);
    })().catch((error: Error) => setProblem(`Not saved: ${error.message}`));
    saving.current = run;
    await run;
  }, [id, api]);

  // A board opens with all of it in view, zoomed out as far as that takes and never in; with
  // ?focus=<shape or frame id> it opens on that part, large enough to read.
  const [search] = useSearchParams();
  const focus = search.get('focus');
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => {
      const all = api.getSceneElements();
      const part = focus ? all.filter((el) => el.id === focus) : [];
      fitView(api, part.length ? part : all, part.length ? 2 : 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [api, focus]);

  // Text is measured as it is drawn; drawn before the hand-drawn font arrived, it was measured in
  // another and would be cut short, so it is measured again once the font is in.
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const measure = () => {
      if (disposed || addingImage(api)) return;
      api.updateScene({
        elements: restoreElements(api.getSceneElementsIncludingDeleted(), null, {
          refreshDimensions: true,
          repairBindings: true,
        }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    document.fonts.addEventListener('loadingdone', measure);
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true;
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [api]);

  useEffect(() => {
    if (!api || !reveal.current) return;
    const land = (shapes: BoardElement[]) => {
      for (const el of shapes)
        known.current.set(el.id, Math.max(known.current.get(el.id) ?? 0, el.version));
      pointing.current?.landed(shapes);
      presence.current?.drew();
    };
    const made = new Player(
      stageOf(api, () => busy(api), land),
      reveal.current,
      BEHIND_MS,
    );
    player.current = made;
    const here = new BoardPresence(api);
    presence.current = here;
    made.pen = here.pen;
    const hand = new BoardPointing(api, id);
    hand.landed(first?.elements ?? []);
    pointing.current = hand;
    const board = reveal.current.parentElement!.querySelector(':scope > .excalidraw')!;
    const camera = new BoardFollow(api, board);
    follow.current = camera;
    const unpoint = pointWith({
      note() {
        // Saying something to Pi is watching for its answer, and what Pi was drawing is by the way.
        camera.following = true;
        made.hurry();
        return hand.note();
      },
      said: hand.said,
    });
    const hands = ['pointerdown', 'wheel', 'keydown', 'gesturestart'];
    for (const kind of hands)
      board.addEventListener(kind, camera.release, { capture: true, passive: true });
    return () => {
      made.stop();
      here.stop();
      hand.stop();
      camera.release();
      for (const kind of hands) board.removeEventListener(kind, camera.release, { capture: true });
      unpoint();
    };
  }, [api, id]);
  // Under a replay, what others draw lands as it comes, to be there on return.
  const wasReplaying = useRef(false);
  useEffect(() => {
    if (!player.current) return;
    if (replaying) player.current.finish();
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
    wasReplaying.current = replaying;
  }, [replaying]);

  // What others drew since the revision in hand: played in the order they drew it, around what the
  // person is doing, and all of it after what the page already holds (its own saves, come back).
  useEffect(() => {
    if (!api) return;
    // One ask at a time: a slow answer is never overtaken, so the revision never goes back.
    let [live, asking, heldBack] = [true, false, false];
    const ask = async () => {
      if (asking || document.visibilityState === 'hidden') return;
      asking = true;
      const scene = await call<BoardScene>('board.scene', {
        id,
        since: revision.current,
        steps: attached.seq(),
      }).catch(() => null);
      if (scene) {
        onOutcomes?.(scene.outcomes);
        try {
          await ensureBoardFonts(scene.elements);
        } catch (error) {
          asking = false;
          if (live) setProblem(`Unable to load board fonts: ${String(error)}`);
          return;
        }
      }
      asking = false;
      if (live && scene?.looking) presence.current?.heard(scene.looking);
      if (live && scene?.attached) attached.heard(scene.attached);
      // What waits for the person, once each: a label with its shape, a group of strokes as one.
      waiting.current =
        live && scene && busy(api)
          ? new Set(
              scene.elements
                .filter((el) => known.current.get(el.id) !== el.version && !el.containerId)
                .map((el) => (el.groupIds as string[] | undefined)?.[0] ?? el.id),
            ).size
          : 0;
      if (!live || !scene || !(scene.elements.length || scene.whole)) return;
      if (busy(api)) {
        heldBack = true;
        return;
      }
      revision.current = scene.board.revision;
      const held = api.getSceneElementsIncludingDeleted();
      if (scene.whole) {
        // Told it all (a deletion after the revision in hand was purged): a shape held here as
        // Board last had it, and not among them, is gone.
        player.current!.finish();
        const named = new Set(scene.elements.map((el) => el.id));
        api.updateScene({
          elements: api
            .getSceneElementsIncludingDeleted()
            .filter((el) => named.has(el.id) || known.current.get(el.id) !== el.version),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        player.current!.stage.show(scene.elements, true);
        return;
      }
      const same = new Set(held.map((el) => `${el.id}/${el.version}/${el.versionNonce}`));
      const fresh = stacked(scene.elements).filter(
        (el) => !same.has(`${el.id}/${el.version}/${el.versionNonce}`),
      );
      // The view goes ahead of the ink, so a stroke is watched as it is drawn.
      if (!player.current!.instant && fresh.length && presence.current?.drew())
        follow.current?.expect(fresh);
      player.current!.add(fresh);
      // What came while their hand was down lands now, as what was being played did.
      if (heldBack) player.current!.hurry();
      heldBack = false;
    };
    pull.current = ask;
    // Quicker while an agent draws, so ink starts soon after the shape was made.
    let asked = 0;
    const every = setInterval(() => {
      const drew = (presence.current?.doing().drewMs ?? Infinity) < DRAWING_MS;
      if (Date.now() - asked < (drew || player.current?.waiting ? ASK_DRAWING_MS : ASK_MS)) return;
      asked = Date.now();
      void ask();
    }, ASK_DRAWING_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [api, id]);

  // What is drawn is saved when the page is left or hidden, as well as a moment after it.
  useEffect(() => {
    const flush = () => document.visibilityState === 'hidden' && void save();
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      clearTimeout(timer.current);
      void save();
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
    // A hidden page or a person mid-gesture asks for nothing, which spends no try.
    for (let tries = 0; tries < 20 && current(); tries += document.hidden || busy(api!) ? 0 : 1) {
      await pull.current?.();
      // What the person added is never played back to them.
      player.current?.finish();
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

  // What the replay and the board have in common.
  const editor: ComponentProps<typeof Excalidraw> = {
    theme,
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
      if (!link.startsWith('merv:')) return;
      // A card names a record by id; it opens where a link to that record would.
      event.preventDefault();
      void placeOf({ record: link.slice('merv:'.length) }, rows).then(
        (place) => typeof place !== 'string' && navigate(place.path),
        () => undefined,
      );
    },
  };

  if (problem && !first) return <p className="pi-error board-loading">{problem}</p>;
  if (!first) return <p className="muted board-loading">Opening the board…</p>;
  return (
    <div
      className={`board-canvas${readingReference ? ' board-reading-reference' : ''}${replaying ? ' is-replaying' : ''}`}
    >
      {problem && (
        <p className="pi-error board-problem" role="alert">
          {problem}
        </p>
      )}
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
          elements: restored(first.elements, true),
        }}
        onChange={(elements: readonly OrderedExcalidrawElement[], appState, held) => {
          const zoomChanged =
            previousZoom.current !== undefined && previousZoom.current !== appState.zoom.value;
          previousZoom.current = appState.zoom.value;
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
          bring?.(elements, held);
          setDrawnOn(elements.length > 0);
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
            player.current?.hurry();
            hush.current?.();
            void call('board.hand', { id }).catch(() => undefined);
          }
          handDown.current = down;
          // Only the person's own shapes changing puts off their save: no cursor, camera or other
          // hand's shapes can, however often they move.
          const dirt = elements.reduce(
            (sum, el) => (known.current.get(el.id) === el.version ? sum : sum + el.version),
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
        renderToolbarEnd={() => <AddButton key="merv-add" onClick={openPanel} />}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>
              Sketch an idea, or ask Pi to draw it with you.
            </WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
          <WelcomeScreen.Hints.ToolbarHint />
        </WelcomeScreen>
      </Excalidraw>
      <canvas ref={reveal} className={`board-reveal is-${theme}`} />
      {api && <BoardProposal api={api} />}
      <BoardSessions board={id} sessions={attached.sessions} />
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
