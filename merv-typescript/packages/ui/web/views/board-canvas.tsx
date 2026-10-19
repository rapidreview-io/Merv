/**
 * One board's canvas: Excalidraw, kept in step with Board. What the person draws is saved a moment
 * after they stop, as the shapes whose version Board has not seen; what anyone else (a colleague,
 * the agent) drew arrives by asking for what changed after the revision in hand, and is merged in
 * shape by shape as Excalidraw reconciles. Excalidraw's fonts are served from this app, never a
 * CDN; images and embeds are off, since a board keeps no files and loads nothing from elsewhere.
 */
import '@excalidraw/excalidraw/index.css';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CaptureUpdateAction,
  Excalidraw,
  getCommonBounds,
  MainMenu,
  WelcomeScreen,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import { stacked, type BoardScene } from '@merv/board/models';
import { call } from '../api';
import { ensureBoardFonts } from './board-fonts';
import { useRows } from '../navigation';
import { onWorn, worn } from '../theme';
import { placeOf } from './pi-screen';
import { BoardLinkDetails } from './board-link-details';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';

/** The shapes Board keeps; anything else stays on this page only. */
const KEPT = new Set('rectangle ellipse diamond text arrow line freedraw frame'.split(' '));
const SAVE_MS = 600;
const ASK_MS = 1500;

function BoardCanvasScene({ id }: { id: string }) {
  const navigate = useNavigate();
  const rows = useRows();
  const theme = useSyncExternalStore(onWorn, worn);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [readingReference, setReadingReference] = useState(false);
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
      (el) => KEPT.has(el.type) && known.current.get(el.id) !== el.version,
    );
    if (!changed.length) return;
    const run = (async () => {
      for (let at = 0; at < changed.length; at += 500) {
        const part = changed.slice(at, at + 500);
        await call('board.save', { id, elements: part });
        for (const el of part) known.current.set(el.id, el.version);
      }
      setProblem(null);
    })().catch((error: Error) => setProblem(`Not saved: ${error.message}`));
    saving.current = run;
    await run;
  }, [id]);

  // A board opens with all of it in view, zoomed out as far as that takes and never in; with
  // ?focus=<shape or frame id> it opens on that part, large enough to read.
  const [search] = useSearchParams();
  const focus = search.get('focus');
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => {
      const all = api.getSceneElements();
      const part = focus ? all.filter((el) => el.id === focus) : [];
      const shown = part.length ? part : all;
      if (!shown.length) return;
      const [x1, y1, x2, y2] = getCommonBounds(shown);
      const { width, height } = api.getAppState();
      const fit =
        Math.min(width / (x2 - x1 || 1), height / (y2 - y1 || 1)) * (part.length ? 0.8 : 0.9);
      const zoom = Math.max(0.1, Math.min(part.length ? 2 : 1, fit));
      api.updateScene({
        appState: {
          zoom: { value: zoom as never },
          scrollX: width / (2 * zoom) - (x1 + x2) / 2,
          scrollY: height / (2 * zoom) - (y1 + y2) / 2,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, focus]);

  // Text is measured as it is drawn; drawn before the hand-drawn font arrived, it was measured in
  // another and would be cut short, so it is measured again once the font is in.
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
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

  // What others drew since the revision in hand, merged in without disturbing what is held.
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
      revision.current = scene.board.revision;
      // Never repair bindings here: these are only the shapes that changed, and a box whose text
      // did not change would lose it.
      const remote = restoreElements(stacked(scene.elements) as never, null, {
        refreshDimensions: true,
      }) as unknown as RemoteExcalidrawElement[];
      for (const el of scene.elements)
        known.current.set(el.id, Math.max(known.current.get(el.id) ?? 0, el.version));
      // Told it all (a deletion after the revision in hand was purged): a shape held here as Board
      // last had it, and not among them, is gone.
      const named = new Set(scene.elements.map((el) => el.id));
      const held = api
        .getSceneElementsIncludingDeleted()
        .filter(
          (el) => !scene.whole || named.has(el.id) || known.current.get(el.id) !== el.version,
        );
      api.updateScene({
        // Repair and measure only after merging: a delta alone may omit a bound label.
        elements: restoreElements(reconcileElements(held, remote, api.getAppState()), null, {
          refreshDimensions: true,
          repairBindings: true,
        }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
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

  if (problem && !first) return <p className="pi-error board-loading">{problem}</p>;
  if (!first) return <p className="muted board-loading">Opening the board…</p>;
  return (
    <div className={`board-canvas${readingReference ? ' board-reading-reference' : ''}`}>
      {problem && (
        <p className="pi-error board-problem" role="alert">
          {problem}
        </p>
      )}
      <Excalidraw
        excalidrawAPI={setApi}
        theme={theme}
        aiEnabled={false}
        validateEmbeddable={false}
        UIOptions={{
          tools: { image: false },
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: false,
          },
        }}
        initialData={{
          elements: restoreElements(stacked(first.elements) as never, null, {
            refreshDimensions: true,
            repairBindings: true,
          }),
        }}
        onChange={(elements: readonly OrderedExcalidrawElement[], appState) => {
          const zoomChanged =
            previousZoom.current !== undefined && previousZoom.current !== appState.zoom.value;
          previousZoom.current = appState.zoom.value;
          // Reading a linked card should not open the shape styling controls.
          const selected = elements.filter((element) => appState.selectedElementIds[element.id]);
          setReadingReference(
            selected.length > 0 &&
              selected.every(
                (element) =>
                  Boolean(element.link) ||
                  (element.type === 'text' &&
                    Boolean(
                      elements.find((container) => container.id === element.containerId)?.link,
                    )),
              ),
          );
          if (zoomChanged && appState.showHyperlinkPopup) {
            api?.updateScene({ appState: { showHyperlinkPopup: false } });
          }
          scene.current = elements;
          if (!elements.some((el) => known.current.get(el.id) !== el.version)) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), SAVE_MS);
        }}
        renderHyperlinkDetails={(element, close) => (
          <BoardLinkDetails key={element.id} element={element} close={close} theme={theme} />
        )}
        onLinkOpen={(element, event) => {
          const link = element.link ?? '';
          if (!link.startsWith('merv:')) return;
          // A card names a record by id; it opens where a link to that record would.
          event.preventDefault();
          void placeOf({ record: link.slice('merv:'.length) }, rows).then(
            (place) => typeof place !== 'string' && navigate(place.path),
            () => undefined,
          );
        }}
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
    </div>
  );
}

/** A different board gets separate refs, pending saves, and first-scene state. */
export default function BoardCanvas({ id }: { id: string }) {
  return <BoardCanvasScene key={id} id={id} />;
}
