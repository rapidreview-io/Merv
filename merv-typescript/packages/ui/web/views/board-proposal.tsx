/**
 * The person's answer to what an agent proposed: while a proposal is selected, a keep and a dismiss
 * above it. Keeping makes its shapes ordinary, and dismissing deletes them, each a change of theirs
 * like any other: saved, in history and undoable.
 */
import { useEffect, useState } from 'react';
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Icon } from '../icons';

const isProposed = (el: ExcalidrawElement) => !!el.customData?.proposed;

export function BoardProposal({ api }: { api: ExcalidrawImperativeAPI }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(
    () =>
      api.onChange((elements, state) => {
        const chosen = elements.filter((el) => state.selectedElementIds[el.id] && !el.isDeleted);
        if (
          !chosen.length ||
          !chosen.every(isProposed) ||
          state.selectedElementsAreBeingDragged ||
          state.isResizing ||
          state.isRotating
        )
          return setAt(null);
        const [x1, y1, x2] = getCommonBounds(chosen);
        const { scrollX, scrollY, zoom, width } = state;
        const [left, top] = [
          Math.round(Math.min(width - 40, Math.max(40, ((x1 + x2) / 2 + scrollX) * zoom.value))),
          Math.round(Math.max(44, (y1 + scrollY) * zoom.value - 10)),
        ];
        setAt((held) => (held?.left === left && held.top === top ? held : { left, top }));
      }),
    [api],
  );
  if (!at) return null;
  /** Makes this of the proposals selected, every part of each, as one step the person can undo. */
  const answer = (
    made: (el: ExcalidrawElement) => Partial<ExcalidrawElement>,
    dismiss: boolean,
  ) => {
    const { selectedElementIds } = api.getAppState();
    const scene = api.getSceneElementsIncludingDeleted();
    const groups = new Set(
      scene.filter((el) => selectedElementIds[el.id]).flatMap((el) => el.groupIds.slice(-1)),
    );
    const parts = new Set(
      scene
        .filter(
          (el) =>
            isProposed(el) &&
            !el.isDeleted &&
            (selectedElementIds[el.id] || groups.has(el.groupIds.at(-1)!)),
        )
        .map((el) => el.id),
    );
    // A label an agent gave a proposed box later goes with it, proposed or not.
    const goes = (el: ExcalidrawElement) =>
      parts.has(el.id) ||
      (dismiss && el.type === 'text' && !!el.containerId && parts.has(el.containerId));
    api.updateScene({
      elements: scene.map((el) => (goes(el) ? newElementWith(el, made(el) as never) : el)),
      ...(dismiss && { appState: { selectedElementIds: {}, selectedGroupIds: {} } }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    // Excalidraw hears keys, an undo among them, only with the focus inside it.
    document.querySelector<HTMLElement>('.board-canvas > .excalidraw')?.focus();
  };
  const keep = () =>
    answer(
      ({ customData: { proposed: _, ...kept } = {} }) => ({
        opacity: 100,
        strokeStyle: 'solid',
        customData: kept,
      }),
      false,
    );
  return (
    <div className="board-proposal" style={at}>
      <button type="button" title="Keep" aria-label="Keep" onClick={keep}>
        <Icon name="check" size={16} />
      </button>
      <button
        type="button"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => answer(() => ({ isDeleted: true }), true)}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
