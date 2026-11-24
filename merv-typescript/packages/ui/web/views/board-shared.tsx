import { type LookName } from '@merv/protocol/looks';
import { useLocation } from 'react-router-dom';
/** A shared board opens outside the account and project page, with only its drawing and replay. */
import '@excalidraw/excalidraw/index.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
  type ComponentProps,
} from 'react';
import {
  CaptureUpdateAction,
  Excalidraw,
  getDataURL,
  MainMenu,
  WelcomeScreen,
} from '@excalidraw/excalidraw';
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardElement, BoardHistory } from '@merv/board/models';
import { BoardReplay } from './board-replay';
import { restored } from './board-player';
import { ensureBoardFonts } from './board-fonts';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';
const shareOf = (token: string) => async (path: string) => {
  const response = await fetch(`/board-share/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('This share is unavailable');
  return response;
};
type Scene = {
  title: string;
  revision: number;
  look?: LookName;
  paper?: string;
  elements: BoardElement[];
};
const noop = () => {};
const free = () => true;
const settle = async () => {};
const editor: ComponentProps<typeof Excalidraw> = {
  theme: 'light',
  aiEnabled: false,
  viewModeEnabled: true,
  validateEmbeddable: false,
  onLinkOpen: (_: unknown, event: CustomEvent) => event.preventDefault(),
  UIOptions: {
    canvasActions: {
      loadScene: false,
      saveToActiveFile: false,
      export: false,
      clearCanvas: false,
      changeViewBackgroundColor: false,
    },
  },
  children: (
    <>
      <MainMenu />
      <WelcomeScreen />
    </>
  ),
};
/** A board read through a share: what it holds now, and its history, its pictures brought along. */
type ShareRequest = ReturnType<typeof shareOf>;
type ShareLife = {
  request: ShareRequest;
  files: Map<string, BinaryFileData>;
  started: number;
  accepted: number;
  fonted?: number;
};
type Snapshot =
  | { request: ShareRequest; scene: Scene; files: BinaryFileData[] }
  | { request: ShareRequest; error: string };
const unavailable = () => new Error('This share is unavailable');
const addImages = (api: ExcalidrawImperativeAPI, files: BinaryFileData[]) => {
  const held = api.getFiles();
  // Consumers remount the canvas when the share changes; Excalidraw files are immutable by id.
  const missing = files.filter((file) => !held[file.id]);
  if (missing.length) api.addFiles(missing);
};
export function useSharedBoard(token: string, api: ExcalidrawImperativeAPI | null) {
  const request = useMemo(() => shareOf(token), [token]);
  const [state, setState] = useState<Snapshot>();
  const snapshot = state?.request === request ? state : undefined;
  const ready = snapshot && 'scene' in snapshot ? snapshot : undefined;
  const life = useRef<ShareLife | null>(null);
  const target = useRef<{ api: ExcalidrawImperativeAPI; request: ShareRequest } | null>(null);

  const images = useCallback(async (own: ShareLife, elements: BoardElement[]) => {
    const files: BinaryFileData[] = [];
    for (const file of new Set(elements.map((el) => el.fileId))) {
      if (typeof file !== 'string') continue;
      if (life.current !== own) throw unavailable();
      let data = own.files.get(file);
      if (!data) {
        const response = await own.request(`images/${encodeURIComponent(file)}`);
        if (life.current !== own) throw unavailable();
        const blob = await response.blob();
        if (life.current !== own) throw unavailable();
        const dataURL = await getDataURL(blob);
        if (life.current !== own) throw unavailable();
        // Cache fulfilled data only: a hung older fetch must not hold later polls behind it.
        data = own.files.get(file) ?? {
          id: file as never,
          dataURL,
          mimeType: blob.type as never,
          created: Date.now(),
        };
        own.files.set(file, data);
      }
      files.push(data);
    }
    return files;
  }, []);

  useLayoutEffect(() => {
    const own: ShareLife = { request, files: new Map(), started: 0, accepted: 0 };
    life.current = own;
    const read = async () => {
      const attempt = ++own.started;
      const accept = () => {
        if (life.current !== own || attempt < own.accepted) return false;
        own.accepted = attempt;
        return true;
      };
      try {
        const response = await request('scene');
        if (life.current !== own) return;
        const scene: Scene = await response.json();
        if (life.current !== own) return;
        // Every live element change increments revision; loaded font faces remain in the page.
        if (own.fonted !== scene.revision) await ensureBoardFonts(scene.elements);
        if (life.current !== own) return;
        const files = await images(own, scene.elements);
        // A later pending read does not starve this one; a later accepted result does supersede it.
        if (!accept()) return;
        own.fonted = scene.revision;
        setState((previous) =>
          previous?.request === request &&
          'scene' in previous &&
          previous.scene.revision === scene.revision &&
          previous.scene.title === scene.title &&
          previous.scene.look === scene.look &&
          previous.scene.paper === scene.paper
            ? previous
            : { request, scene, files },
        );
      } catch {
        if (!accept()) return;
        setState((previous) =>
          previous?.request === request && 'error' in previous
            ? previous
            : { request, error: unavailable().message },
        );
      }
    };
    void read();
    const visible = () => {
      if (!document.hidden) void read();
    };
    const timer = setInterval(visible, 15000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      if (life.current === own) life.current = null;
      own.files.clear();
    };
  }, [request, images]);

  useLayoutEffect(() => {
    const own = api ? { api, request } : null;
    target.current = own;
    return () => {
      if (target.current === own) target.current = null;
    };
  }, [api, request]);

  useEffect(() => {
    if (!api || !ready || target.current?.api !== api || target.current.request !== request) return;
    const canvas = target.current;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const apply = () => {
      if (!active || target.current !== canvas) return;
      unsubscribe?.();
      unsubscribe = undefined;
      try {
        addImages(api, ready.files);
        api.updateScene({
          elements: restored(ready.scene.elements, true),
          appState: {
            viewBackgroundColor: ready.scene.paper ?? '#ffffff',
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.scrollToContent(undefined, { fitToContent: true });
      } catch {
        setState((previous) =>
          previous === ready ? { request, error: unavailable().message } : previous,
        );
      }
    };
    // Excalidraw emits its API before its asynchronous initial scene restoration finishes.
    if (api.getAppState().isLoading) {
      unsubscribe = api.onChange((_elements, appState) => {
        if (!appState.isLoading) apply();
      });
    } else apply();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api, ready, request]);

  const history = useCallback(
    async (after?: number): Promise<BoardHistory> => {
      const own = life.current,
        canvas = target.current;
      if (
        !own ||
        own.request !== request ||
        !canvas ||
        canvas.request !== request ||
        canvas.api !== api
      )
        throw unavailable();
      const response = await request(`history?after=${after ?? 0}`);
      if (life.current !== own || target.current !== canvas) throw unavailable();
      const page: BoardHistory = await response.json();
      if (life.current !== own || target.current !== canvas) throw unavailable();
      const files = await images(
        own,
        page.changes.flatMap((change) => change.shapes),
      );
      if (life.current !== own || target.current !== canvas) throw unavailable();
      // Replay copies pictures from the live canvas, so a stale history call must reject, not return a partial page.
      addImages(canvas.api, files);
      return page;
    },
    [api, request, images],
  );
  return {
    scene: ready?.scene,
    error: snapshot && 'error' in snapshot ? snapshot.error : '',
    history,
  };
}

export default function SharedBoard() {
  const { hash } = useLocation();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const { scene, error, history } = useSharedBoard(hash.slice(1), api);
  if (!scene && api) setApi(null);
  if (error)
    return (
      <p className="muted board-loading" role="status">
        {error}
      </p>
    );
  if (!scene) return <p className="muted board-loading">Opening the board…</p>;
  return (
    <div className="board-page board-shared">
      <div className="board-main">
        <header className="file-page-head board-page-head">
          <h1 className="file-page-title">{scene.title}</h1>
        </header>
        <div className="board-canvas">
          <Excalidraw {...editor} excalidrawAPI={setApi} />
          {api && (
            <BoardReplay
              id="shared"
              live={api}
              editor={editor}
              free={free}
              settle={settle}
              revision={() => scene.revision}
              mode={noop}
              readHistory={history}
            />
          )}
        </div>
      </div>
    </div>
  );
}
