import { lazy, Suspense } from 'react';
import type { CanvasProps } from '../views/board-canvas';

// Loaded with a canvas, never with the boards list or the sign-in page.
const Pages = lazy(() =>
  import('../views/board-pages').then((module) => ({ default: module.BoardPages })),
);
const PageTool = lazy(() =>
  import('../views/board-pages').then((module) => ({ default: module.PageTool })),
);
const Handoff = lazy(() =>
  import('../views/board-handoff').then((module) => ({ default: module.BoardHandoff })),
);

function BoardOverlays({
  api,
  board,
}: {
  api: Parameters<NonNullable<CanvasProps['overlays']>>[0];
  board: Parameters<NonNullable<CanvasProps['overlays']>>[1];
}) {
  return (
    <Suspense fallback={null}>
      <Pages api={api} board={board.id} />
      <Handoff api={api} board={board.id} title={board.title} />
    </Suspense>
  );
}

/** Both board entry points opt in; the canvas knows neither the Mac bridge nor the demo. */
export const boardOverlays: NonNullable<CanvasProps['overlays']> = (api, board) => (
  <BoardOverlays api={api} board={board} />
);
export const boardToolbar: NonNullable<CanvasProps['toolbar']> = (api) => (
  <Suspense fallback={null}>
    <PageTool api={api} />
  </Suspense>
);
