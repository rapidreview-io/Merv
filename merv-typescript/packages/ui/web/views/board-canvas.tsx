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
  MainMenu,
  WelcomeScreen,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type { BoardScene } from '@merv/board/models';
import { call } from '../api';
import { useRows } from '../navigation';
import { onWorn, worn } from '../theme';
import { placeOf } from './pi-screen';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';

/** The shapes Board keeps; anything else stays on this page only. */
const KEPT = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'frame',
]);
const SAVE_MS = 600;
const ASK_MS = 1500;

export default function BoardCanvas({ id }: { id: string }) {
  const navigate = useNavigate();
  const rows = useRows();
  const theme = useSyncExternalStore(onWorn, worn);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [first, setFirst] = useState<BoardScene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The version of each shape Board holds, as far as this page knows. */
  const known = useRef(new Map<string, number>());
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let live = true;
    void call<BoardScene>('board.scene', { id }).then(
      (scene) => {
        if (!live) return;
        for (const el of scene.elements) known.current.set(el.id, el.version);
        revision.current = scene.board.revision;
        setFirst(scene);
      },
      (error: Error) => live && setProblem(error.message),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const save = useCallback(async () => {
    if (!api) return;
    await saving.current;
    const changed = api
      .getSceneElementsIncludingDeleted()
      .filter((el) => KEPT.has(el.type) && known.current.get(el.id) !== el.version);
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
  }, [api, id]);

  // A board opens with all of it in view, zoomed out as far as that takes and never in; with
  // ?focus=<shape or frame id> it opens on that part, large enough to read.
  const [search] = useSearchParams();
  const focus = search.get('focus');
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => {
      const part = focus && api.getSceneElements().find((el) => el.id === focus);
      api.scrollToContent(part || undefined, {
        fitToViewport: true,
        viewportZoomFactor: part ? 0.8 : 0.9,
        animate: false,
      });
      const most = part ? 2 : 1;
      if (api.getAppState().zoom.value <= most) return;
      api.updateScene({ appState: { zoom: { value: most as never } } });
      api.scrollToContent(part || undefined, { animate: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, focus]);

  // Text is measured as it is drawn; drawn before the hand-drawn font arrived, it was measured in
  // another and would be cut short, so it is measured again once the font is in.
  useEffect(() => {
    if (!api) return;
    const measure = () =>
      api.updateScene({
        elements: restoreElements(api.getSceneElementsIncludingDeleted(), null, {
          refreshDimensions: true,
        }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    document.fonts.addEventListener('loadingdone', measure);
    return () => document.fonts.removeEventListener('loadingdone', measure);
  }, [api]);

  // What others drew since the revision in hand, merged in without disturbing what is held.
  useEffect(() => {
    if (!api) return;
    let live = true;
    const ask = async () => {
      if (document.visibilityState === 'hidden') return;
      const scene = await call<BoardScene>('board.scene', { id, since: revision.current }).catch(
        () => null,
      );
      if (!live || !scene || !scene.elements.length) return;
      revision.current = scene.board.revision;
      const remote = restoreElements(scene.elements as never, null, {
        refreshDimensions: true,
        repairBindings: true,
      }) as unknown as RemoteExcalidrawElement[];
      for (const el of scene.elements)
        known.current.set(el.id, Math.max(known.current.get(el.id) ?? 0, el.version));
      api.updateScene({
        elements: reconcileElements(
          api.getSceneElementsIncludingDeleted(),
          remote,
          api.getAppState(),
        ),
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
    <div className="board-canvas">
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
          elements: restoreElements(first.elements as never, null, {
            refreshDimensions: true,
            repairBindings: true,
          }),
        }}
        onChange={(elements: readonly OrderedExcalidrawElement[]) => {
          if (!elements.some((el) => known.current.get(el.id) !== el.version)) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), SAVE_MS);
        }}
        onLinkOpen={(element, event) => {
          const link = element.link ?? '';
          if (!link.startsWith('merv:')) return;
          // A card names a record by id; it opens where a link to that record would.
          event.preventDefault();
          void placeOf({ record: link.slice('merv:'.length) }, rows).then((place) => {
            if (typeof place !== 'string') navigate(place.path);
          });
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
