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
import { useRows } from '../navigation';
import { onWorn, worn } from '../theme';
import { placeOf } from './pi-screen';
import { BoardLinkDetails } from './board-link-details';
import { AddButton, CardPicker, type CardPick } from './board-add';
import { fileOf, fitView, imageAt, imageBringer, Player, restored, stageOf } from './board-player';
import { BoardReplay } from './board-replay';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';

/** The shapes Board keeps; anything else stays on this page only. */
const KEPT = new Set('rectangle ellipse diamond text arrow line freedraw frame image'.split(' '));
const SAVE_MS = 600;
const ASK_MS = 1500;
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

function BoardCanvasScene({ id }: { id: string }) {
  const navigate = useNavigate();
  const rows = useRows();
  const theme = useSyncExternalStore(onWorn, worn);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [readingReference, setReadingReference] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** The card whose popup opened as it was selected, so a closed popup stays closed. */
  const opened = useRef<string | null>(null);
  /** Asks Board for what changed now, as the poll does. */
  const pull = useRef<() => Promise<void>>();
  const previousZoom = useRef<number>();
  const [first, setFirst] = useState<BoardScene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The version of each shape Board holds, as far as this page knows. */
  const known = useRef(new Map<string, number>());
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
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
  const reveal = useRef<HTMLCanvasElement>(null);

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
    };
    const made = new Player(
      stageOf(api, () => busy(api), land),
      reveal.current,
      BEHIND_MS,
    );
    player.current = made;
    return () => made.stop();
  }, [api]);
  // Under a replay, what others draw lands as it comes, to be there on return.
  useEffect(() => {
    if (!player.current) return;
    if (replaying) player.current.finish();
    player.current.instant = replaying;
    // Back from one, the focus is on the board again, as a paste needs it.
    if (!replaying)
      reveal.current?.parentElement?.querySelector<HTMLElement>(':scope > .excalidraw')?.focus();
  }, [replaying]);

  // What others drew since the revision in hand: played in the order they drew it, around what the
  // person is doing, and all of it after what the page already holds (its own saves, come back).
  useEffect(() => {
    if (!api) return;
    // One ask at a time: a slow answer is never overtaken, so the revision never goes back.
    let [live, asking] = [true, false];
    const ask = async () => {
      if (asking || document.visibilityState === 'hidden') return;
      asking = true;
      const scene = await call<BoardScene>('board.scene', { id, since: revision.current }).catch(
        () => null,
      );
      if (scene) {
        try {
          await ensureBoardFonts(scene.elements);
        } catch (error) {
          asking = false;
          if (live) setProblem(`Unable to load board fonts: ${String(error)}`);
          return;
        }
      }
      asking = false;
      if (!live || !scene || !(scene.elements.length || scene.whole)) return;
      if (busy(api)) return;
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
      player.current!.add(
        stacked(scene.elements).filter(
          (el) => !same.has(`${el.id}/${el.version}/${el.versionNonce}`),
        ),
      );
    };
    pull.current = ask;
    const every = setInterval(() => void ask(), ASK_MS);
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

  // A card lands in the middle of what is in view, chosen, so it can be moved from there at once.
  const addCard = async (picks: CardPick[], name: string) => {
    setAdding(false);
    if (!api) return;
    const { scrollX, scrollY, zoom, width, height } = api.getAppState();
    const one = picks.length === 1 ? picks[0]! : undefined;
    // Below whatever already stands there, so a card never lands on another.
    const x = Math.round(width / 2 / zoom.value - scrollX - 140);
    let y = Math.round(height / 2 / zoom.value - scrollY - 50);
    const standing = api.getSceneElements();
    const covered = (top: number) =>
      standing.some(
        (el) => el.x < x + 280 && x < el.x + el.width && el.y < top + 110 && top < el.y + el.height,
      );
    for (let step = 0; step < 20 && covered(y); step++) y += 130;
    const drawn = await call<{ created: Record<string, string> }>('board.write:draw', {
      board: id,
      ops: [
        {
          op: 'link',
          key: 'card',
          target: one ? one.target : picks.map((pick) => pick.target),
          text: one ? one.text : name,
          ...(one?.fact && { fact: one.fact }),
          at: [x, y],
        },
      ],
    }).catch((error: Error) => void setProblem(`Not added: ${error.message}`));
    const card = drawn?.created.card;
    for (let tries = 0; card && tries < 20; tries++) {
      await pull.current?.();
      // The person's own card is never played back to them.
      player.current?.finish();
      const scene = api.getSceneElements();
      const group = scene.find((el) => el.id === card)?.groupIds[0];
      if (group) {
        api.updateScene({
          appState: {
            selectedElementIds: Object.fromEntries(
              scene.filter((el) => el.groupIds[0] === group).map((el) => [el.id, true]),
            ),
            selectedGroupIds: { [group]: true },
          },
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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
          close={() => setAdding(false)}
          add={(picks, name) => void addCard(picks, name)}
        />
      )}
      <Excalidraw
        {...editor}
        excalidrawAPI={setApi}
        // Excalidraw takes a paste only with the focus inside it: the page is the board, so at once.
        autoFocus
        generateIdForFile={nameImage}
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
                  Boolean(element.link || element.customData?.card) ||
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
          if (!elements.some((el) => known.current.get(el.id) !== el.version)) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), SAVE_MS);
        }}
        renderToolbarEnd={() => <AddButton key="merv-add" onClick={() => setAdding(true)} />}
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
      {replaying ? (
        <BoardReplay id={id} editor={editor} close={() => setReplaying(false)} />
      ) : (
        <p
          className="board-history muted"
          title="Project members can replay this board. What is drawn here is kept for that, erased work too."
        >
          History on
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              clearTimeout(timer.current);
              // Excalidraw hears some keys from anywhere, and acts on what is selected.
              api?.updateScene({
                appState: {
                  selectedElementIds: {},
                  selectedGroupIds: {},
                  selectedLinearElement: null,
                },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
              void save().then(() => setReplaying(true));
            }}
          >
            Replay
          </button>
        </p>
      )}
    </div>
  );
}

/** A different board gets separate refs, pending saves, and first-scene state. */
export default function BoardCanvas({ id }: { id: string }) {
  return <BoardCanvasScene key={id} id={id} />;
}
