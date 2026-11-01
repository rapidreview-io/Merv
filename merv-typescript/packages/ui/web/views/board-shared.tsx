/** A shared board opens outside the account and project page, with only its drawing and replay. */
import '@excalidraw/excalidraw/index.css';
import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { Excalidraw, getDataURL, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardElement, BoardHistory } from '@merv/board/models';
import { BoardReplay } from './board-replay';
import { restored } from './board-player';
import { ensureBoardFonts } from './board-fonts';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';
const token = window.location.hash.slice(1);
const request = async (path: string) => {
  const response = await fetch(`/board-share/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('This share is unavailable');
  return response;
};
type Scene = { title: string; revision: number; elements: BoardElement[] };
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
export default function SharedBoard() {
  const [scene, setScene] = useState<Scene>();
  const [error, setError] = useState('');
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const data: Scene = await (await request('scene')).json();
        await ensureBoardFonts(data.elements);
        if (alive)
          setScene((previous) =>
            previous?.revision === data.revision && previous.title === data.title ? previous : data,
          );
      } catch {
        if (alive) {
          setScene(undefined);
          setError('This share is unavailable');
        }
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const images = useCallback(
    async (elements: BoardElement[]) => {
      if (!api) return;
      for (const file of new Set(elements.map((el) => el.fileId))) {
        if (typeof file !== 'string' || api.getFiles()[file]) continue;
        const blob = await (await request(`images/${encodeURIComponent(file)}`)).blob();
        api.addFiles([
          {
            id: file as never,
            dataURL: await getDataURL(blob),
            mimeType: blob.type as never,
            created: Date.now(),
          },
        ]);
      }
    },
    [api],
  );
  useEffect(() => {
    if (!api || !scene) return;
    void images(scene.elements)
      .then(() => {
        api.updateScene({ elements: restored(scene.elements, true) });
        api.scrollToContent(undefined, { fitToContent: true });
      })
      .catch(() => setError('This share is unavailable'));
  }, [api, scene, images]);
  const history = useCallback(
    async (after?: number): Promise<BoardHistory> => {
      const page: BoardHistory = await (await request(`history?after=${after ?? 0}`)).json();
      await images(page.changes.flatMap((change) => change.shapes));
      return page;
    },
    [images],
  );
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
