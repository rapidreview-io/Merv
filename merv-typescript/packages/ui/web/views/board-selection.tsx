/**
 * What a selection on a board can do, above it while it stands. A proposal of an agent's takes a
 * keep and a dismiss: keeping makes its shapes ordinary, and dismissing deletes them, each a change
 * of theirs like any other: saved, in history and undoable. The person's own shapes take two asks
 * of Pi, each a sentence sent as they would say it, with what is selected pointed at beside it
 * (pi-transport): finish my sketch, and try it another way.
 */
import { useEffect, useState } from 'react';
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import { readOnly } from '../api';
import { Icon } from '../icons';
import { useSay } from './pi';

const isProposed = (el: ExcalidrawElement) => !!el.customData?.proposed;
/** What the two asks say, as a person would; the note beside them says what is selected. */
export const ASKS = { finish: 'Finish my sketch.', another: 'Try it another way.' } as const;

type Stood = { left: number; top: number; proposal: boolean };

export function BoardSelection({ api }: { api: ExcalidrawImperativeAPI }) {
  const [at, setAt] = useState<Stood | null>(null);
  const say = useSay()?.say;
  useEffect(
    () =>
      api.onChange((elements, state) => {
        const chosen = elements.filter((el) => state.selectedElementIds[el.id] && !el.isDeleted);
        const proposal = chosen.every(isProposed);
        if (
          !chosen.length ||
          state.selectedElementsAreBeingDragged ||
          state.isResizing ||
          state.isRotating ||
          state.editingTextElement ||
          // A card opens what it holds; it is not a sketch of theirs.
          (!proposal && chosen.some((el) => el.customData?.card || el.link))
        )
          return setAt(null);
        const [x1, y1, x2] = getCommonBounds(chosen);
        const { scrollX, scrollY, zoom, width } = state;
        // Centred on the selection, and whole on the screen at a phone's width.
        const half = proposal ? 36 : 116;
        const [left, top] = [
          Math.round(
            Math.min(width - half, Math.max(half, ((x1 + x2) / 2 + scrollX) * zoom.value)),
          ),
          Math.round(Math.max(44, (y1 + scrollY) * zoom.value - 10)),
        ];
        setAt((held) =>
          held?.left === left && held.top === top && held.proposal === proposal
            ? held
            : { left, top, proposal },
        );
      }),
    [api],
  );
  if (!at) return null;
  const { proposal, ...style } = at;
  if (!proposal) {
    if (!say || readOnly()) return null;
    return (
      <div className="board-selection" style={style}>
        <button type="button" onClick={() => void say(ASKS.finish)}>
          Finish my sketch
        </button>
        <button type="button" onClick={() => void say(ASKS.another)}>
          Another way
        </button>
      </div>
    );
  }
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
    if (dismiss)
      for (const el of scene)
        if (el.type === 'text' && el.containerId && parts.has(el.containerId)) parts.add(el.id);
    const elements = scene.map((el) => {
      if (parts.has(el.id)) return newElementWith(el, made(el) as never);
      if (!dismiss) return el;
      // Nothing that stays goes on naming what went.
      const { startBinding, endBinding } = el as Partial<ExcalidrawArrowElement>;
      const [start, end] = [startBinding, endBinding].map((end) => parts.has(end?.elementId ?? ''));
      const named = el.boundElements?.some(({ id }) => parts.has(id));
      if (!start && !end && !named) return el;
      return newElementWith(el, {
        ...(start && { startBinding: null }),
        ...(end && { endBinding: null }),
        ...(named && { boundElements: el.boundElements!.filter(({ id }) => !parts.has(id)) }),
      } as never);
    });
    api.updateScene({
      elements,
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
    <div className="board-selection" style={style}>
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
