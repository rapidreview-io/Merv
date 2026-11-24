import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
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
const Marks = lazy(() =>
  import('../views/board-marks').then((module) => ({ default: module.BoardMarks })),
);
const Demo = lazy(() =>
  import('../views/ideation-flow').then((module) => ({ default: module.IdeationFlow })),
);

function BoardOverlays({
  api,
  board,
}: {
  api: Parameters<NonNullable<CanvasProps['overlays']>>[0];
  board: Parameters<NonNullable<CanvasProps['overlays']>>[1];
}) {
  const [search] = useSearchParams();
  return (
    <Suspense fallback={null}>
      <Pages api={api} board={board.id} />
      <Handoff api={api} board={board.id} title={board.title} />
      <Marks api={api} board={board.id} />
      {search.has('demo') && !!(window as { mervApp?: unknown }).mervApp && (
        <Demo api={api} board={board.title} />
      )}
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
