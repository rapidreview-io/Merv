import { useSyncExternalStore } from 'react';
import { hashElementsVersion } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/** One scene scan and subscription for the overlays; pointer motion alone changes neither. */
const views = new WeakMap<ExcalidrawImperativeAPI, ReturnType<typeof viewOf>>();
function viewOf(api: ExcalidrawImperativeAPI) {
  const read = (
    elements: readonly ExcalidrawElement[] = api.getSceneElements?.() ?? [],
    state = api.getAppState(),
  ) => ({
    elements,
    state,
    selected: elements.filter((el) => !el.isDeleted && state.selectedElementIds?.[el.id]),
    moving: !!(
      state.selectedElementsAreBeingDragged ||
      state.isResizing ||
      state.isRotating ||
      state.editingTextElement ||
      state.newElement
    ),
  });
  let value = read(),
    key = '',
    off: (() => void) | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (hear: () => void) => {
      if (!off) {
        value = read();
        key = '';
      }
      listeners.add(hear);
      off ??= api.onChange((elements, state) => {
        // Freehand ink changes no page, tile or selection overlay. Publish on lift.
        const previous = value.state;
        if (
          state.newElement?.type === 'freedraw' &&
          state.scrollX === previous.scrollX &&
          state.scrollY === previous.scrollY &&
          state.zoom.value === previous.zoom.value &&
          state.width === previous.width &&
          state.height === previous.height &&
          state.offsetLeft === previous.offsetLeft &&
          state.offsetTop === previous.offsetTop
        )
          return;
        const next = `${hashElementsVersion(elements)}|${state.scrollX},${state.scrollY},${state.zoom.value},${state.offsetLeft},${state.offsetTop},${state.width},${state.height}|${JSON.stringify(state.selectedElementIds)}|${!!state.selectedElementsAreBeingDragged},${!!state.isResizing},${!!state.isRotating},${!!state.editingTextElement},${!!state.newElement}`;
        if (next === key) return;
        key = next;
        const got = read(elements, state);
        if (
          got.selected.length === value.selected.length &&
          got.selected.every(
            (el, i) => el.id === value.selected[i]?.id && el.version === value.selected[i]?.version,
          )
        )
          got.selected = value.selected;
        value = got;
        for (const listener of listeners) listener();
      });
      return () => {
        listeners.delete(hear);
        if (!listeners.size) {
          off?.();
          off = undefined;
        }
      };
    },
  };
}
export function useBoardView(api: ExcalidrawImperativeAPI) {
  if (!views.has(api)) views.set(api, viewOf(api));
  const view = views.get(api)!;
  return useSyncExternalStore(view.subscribe, view.get);
}
