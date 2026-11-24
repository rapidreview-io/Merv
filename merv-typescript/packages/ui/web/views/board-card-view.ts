/** Keeps the canvas view across the change between the small card and full board. */
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardCard } from './board-card';
import { fitView } from './board-player';

/** How long the canvas is left to settle at a new size before its view is set. */
const SETTLE_MS = 120;

export function boardCardOf(api: ExcalidrawImperativeAPI): BoardCard {
  const view = () => {
    const { scrollX, scrollY, zoom, width, height } = api.getAppState();
    return { scrollX, scrollY, zoom: zoom.value as number, width, height };
  };
  const show = ({ zoom, scrollX, scrollY }: { zoom: number; scrollX: number; scrollY: number }) =>
    api.updateScene({
      appState: { zoom: { value: zoom as never }, scrollX, scrollY },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  const fit = () => fitView(api, api.getSceneElements(), 1);
  let kept: ReturnType<typeof view> | undefined,
    waiting = 0,
    settling = 0;
  /** Runs once the canvas has taken its new size and settled there (Excalidraw hears its own resize, then lays itself
   *  out again: a view set in that same moment is lost), or after a moment if it never changes. */
  const resized = (then: () => void) => {
    cancelAnimationFrame(waiting);
    clearTimeout(settling);
    const was = view();
    let frames = 0;
    const look = () => {
      const now = view();
      if (now.width !== was.width || now.height !== was.height || ++frames > 40)
        settling = window.setTimeout(then, SETTLE_MS);
      else waiting = requestAnimationFrame(look);
    };
    waiting = requestAnimationFrame(look);
  };
  return {
    small(on) {
      if (on) {
        kept = view();
        resized(fit);
        return;
      }
      const back = kept;
      kept = undefined;
      if (back) resized(() => show(back));
    },
  };
}
