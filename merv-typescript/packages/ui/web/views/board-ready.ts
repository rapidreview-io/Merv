/**
 * Whether the open board's Excalidraw has finished loading its scene. Until it has, an action run
 * on it (pressing one of its tool buttons) works from the state Excalidraw was born with, and what
 * it sets back includes `isLoading: true`: the board then shows "Loading scene..." for good. So
 * whatever presses Excalidraw's own buttons by itself waits for this.
 *
 * Kept apart from board-canvas so the phone's bar can read it without loading Excalidraw.
 */
const loaded = { now: false, heard: new Set<() => void>() };

export const boardLoaded = () => loaded.now;

/** Said by the canvas: true once Excalidraw first reports a change, false as it goes. */
export function setBoardLoaded(now: boolean) {
  if (loaded.now === now) return;
  loaded.now = now;
  if (now) for (const heard of [...loaded.heard]) heard();
}

/** Runs `then` once the board has loaded, at once if it has; returns how to stop waiting. */
export function whenBoardLoaded(then: () => void): () => void {
  if (loaded.now) {
    then();
    return () => undefined;
  }
  const once = () => {
    loaded.heard.delete(once);
    then();
  };
  loaded.heard.add(once);
  return () => void loaded.heard.delete(once);
}

/** What the watchdog needs of Excalidraw's API. */
type Loading<E, C> = {
  getAppState(): { isLoading: boolean };
  getSceneElements(): readonly unknown[];
  updateScene(scene: {
    elements?: readonly E[];
    appState?: { isLoading: false };
    captureUpdate?: C;
  }): void;
};

/**
 * The board's scene is handed to Excalidraw whole, so it is done loading within a frame or two.
 * If its "Loading scene..." outlives that, nothing is still loading: the flag was left on. This
 * takes it off, and puts the board's shapes in only if Excalidraw's scene is still empty, so no
 * shape is replaced or lost. Says whether it had anything to do.
 */
export function unstick<E, C>(api: Loading<E, C>, shapes: () => readonly E[], never: C): boolean {
  if (!api.getAppState().isLoading) return false;
  const empty = api.getSceneElements().length === 0;
  const elements = empty ? shapes() : [];
  api.updateScene({
    ...(elements.length ? { elements } : {}),
    appState: { isLoading: false },
    captureUpdate: never,
  });
  return true;
}
