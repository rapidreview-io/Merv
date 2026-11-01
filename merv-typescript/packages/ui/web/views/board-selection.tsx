/**
 * What a selection on a board can do, above it while it stands. A proposal of an agent's takes a
 * keep and a dismiss: keeping makes its shapes ordinary, and dismissing deletes them, each a change
 * of theirs like any other: saved, in history and undoable. The person's own shapes take two asks
 * of Pi, each a sentence sent as they would say it, with what is selected pointed at beside it
 * (pi-transport): finish my sketch, and try it another way.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

type Stood = { left: number; top: number; proposal: boolean; theirs: boolean };
/** How long the island says a send was refused. */
const REFUSED_MS = 4_000;
/**
 * Where the island stands clear of Excalidraw's style panel, which is drawn over the board's top
 * left while a shape is selected, and only once the selection has drawn it: beside the panel, or
 * under it when there is no room beside. Measured, since the panel's height is what it holds.
 */
function clearOfPanel(island: HTMLElement, at: { left: number; top: number }) {
  const home = island.parentElement!;
  const box = home.querySelector('.excalidraw .App-menu__left')?.getBoundingClientRect();
  if (!box?.height) return at;
  const room = home.getBoundingClientRect();
  const [right, bottom] = [box.right - room.left + 8, box.bottom - room.top + 44];
  const half = island.offsetWidth / 2;
  if (at.top - 36 >= bottom - 44 || at.left - half >= right) return at;
  return right + 2 * half <= room.width
    ? { left: Math.max(at.left, right + half), top: at.top }
    : { left: at.left, top: bottom };
}

export function BoardSelection({
  api,
  frames,
}: {
  api: ExcalidrawImperativeAPI;
  /** Task frames, whose selection is the hand-off's (board-agents). */
  frames?: Set<string>;
}) {
  const [at, setAt] = useState<Stood | null>(null);
  const [sending, setSending] = useState<'' | 'asking' | 'refused'>('');
  const said = useSay(true);
  const island = useRef<HTMLDivElement>(null);
  const [clear, setClear] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    setClear(at && island.current ? clearOfPanel(island.current, at) : null);
  }, [at]);
  useEffect(
    () =>
      api.onChange((elements, state) => {
        const chosen = elements.filter((el) => state.selectedElementIds[el.id] && !el.isDeleted);
        const proposal = chosen.every(isProposed);
        // Their own lines are finished; an agent's drawing is only tried another way.
        const theirs = chosen.some((el) => el.customData?.by !== 'agent');
        if (
          !chosen.length ||
          state.selectedElementsAreBeingDragged ||
          state.isResizing ||
          state.isRotating ||
          state.editingTextElement ||
          chosen.some((el) => frames?.has(el.id) || (el.frameId && frames?.has(el.frameId))) ||
          // A card opens what it holds; it is not a sketch of theirs.
          (!proposal && chosen.some((el) => el.customData?.card || el.link))
        )
          return setAt(null);
        const [x1, y1, x2] = getCommonBounds(chosen);
        const { scrollX, scrollY, zoom, width } = state;
        // Centred on the selection, and whole on the screen at a phone's width.
        const half = proposal ? 36 : theirs ? 116 : 60;
        const [left, top] = [
          Math.round(
            Math.min(width - half, Math.max(half, ((x1 + x2) / 2 + scrollX) * zoom.value)),
          ),
          Math.round(Math.max(44, (y1 + scrollY) * zoom.value - 10)),
        ];
        setAt((held) =>
          held?.left === left &&
          held.top === top &&
          held.proposal === proposal &&
          held.theirs === theirs
            ? held
            : { left, top, proposal, theirs },
        );
      }),
    [api, frames],
  );
  if (!at) return null;
  const { proposal, theirs } = at;
  // Drawn where the selection puts it, and seen once measured clear of the panel.
  const style = {
    ...(clear ?? { left: at.left, top: at.top }),
    visibility: clear ? undefined : ('hidden' as const),
  };
  if (!proposal) {
    if (!said || readOnly()) return null;
    const ask = (words: string) => {
      setSending('asking');
      void said.say(words).then((sent) => {
        setSending(sent ? '' : 'refused');
        if (!sent) setTimeout(() => setSending(''), REFUSED_MS);
      });
    };
    return (
      <div className="board-selection" style={style} ref={island}>
        {sending === 'refused' ? (
          <span className="board-selection-note">Pi didn’t take it. Try again.</span>
        ) : (
          <>
            {theirs && (
              <button type="button" disabled={!!sending} onClick={() => ask(ASKS.finish)}>
                Finish my sketch
              </button>
            )}
            <button type="button" disabled={!!sending} onClick={() => ask(ASKS.another)}>
              Another way
            </button>
          </>
        )}
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
    <div className="board-selection" style={style} ref={island}>
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
