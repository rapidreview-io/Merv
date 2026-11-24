import { useEffect, useRef, type RefObject } from 'react';
import { media } from '../theme';
import type { EventStreamState } from '../event-stream';
import { useLongGone } from '../quiet';

/** Room for the panel beside a board: wide, and either tall or pointed at with a mouse. Anything else is a phone,
 *  including one turned on its side (short, and touched). The panel's CSS says the same in its own media queries
 *  (web-panel.css: `(max-width: 730px), (max-height: 500px) and (pointer: coarse)`), so the two always agree. */
export const WIDE =
  '(min-width: 731px) and (min-height: 501px), (min-width: 731px) and (not (pointer: coarse))';
const useWide = media(WIDE);
export const usePhoneWidth = () => !useWide();

/** A phone on its side with room for two columns: short and touched, and wide enough for the project beside the chat. */
const SIDEWAYS = '(min-width: 600px) and (max-height: 500px) and (pointer: coarse)';
const useSideways = media(SIDEWAYS);
export const useSidewaysPhone = () => useSideways();

export const reconnecting = (state: EventStreamState) =>
  ['retrying', 'stalled', 'refused'].includes(state);

/** The head's buttons are Merv.app's own. */
export { BACK, PLUS, HeadButton as Icon } from '../panel/parts';

/** No Mac is linked to this account yet: what one adds, and where the app is got. */
export function EmptyMac() {
  return (
    <div className="center">
      <p className="hand">Your agents live on your Mac</p>
      <p className="soft">
        Merv for Mac hands work to your own Claude Code and Codex, and shows them here. Open it on
        your Mac and it pairs with this account.
      </p>
      <a className="get-mac" href="/download" target="_blank" rel="noopener">
        Get Merv for Mac
      </a>
    </div>
  );
}

/** This page's link to runmerv.com, then the Mac's: neither is mentioned in the first minute it is gone (`since`, when
 *  the Mac was last heard). A refusal is no dropped link: it is said at once, with a way to try again. */
export function ConnectionLine({
  state,
  offline,
  since,
  retry,
}: {
  state: EventStreamState;
  offline: boolean;
  since?: string | number | null;
  retry(): void;
}) {
  const refused = state === 'refused';
  const retrying = useLongGone(reconnecting(state) && !refused),
    away = useLongGone(offline, since);
  if (!refused && !retrying && !away) return null;
  return (
    <p className="connection-note" role="status">
      {refused || retrying ? 'Reconnecting…' : 'Mac is away'}
      {refused && (
        <>
          {' '}
          <button onClick={retry}>Reconnect</button>
        </>
      )}
    </p>
  );
}

/** How far in from the screen's left edge a swipe back must start, and how far it must go, mostly sideways. */
export const EDGE = 24,
  SWIPE = 64;
/** A touch is a swipe back only when it began at the very edge and went right, more across than down: anywhere else a
 *  finger is the board's or the thread's own (a pan, a scroll), and never taken from them. */
export const swipesBack = (start: { x: number; y: number }, now: { x: number; y: number }) =>
  start.x <= EDGE && now.x - start.x >= SWIPE && Math.abs(now.y - start.y) * 2 < now.x - start.x;

/** On touch: a swipe in from the left edge goes back, as the arrow does. */
export function useEdgeSwipe(area: RefObject<HTMLElement | null>, on: boolean, back: () => void) {
  const go = useRef(back);
  go.current = back;
  useEffect(() => {
    const el = area.current;
    if (!on || !el) return;
    let start: { x: number; y: number } | undefined;
    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch && touch.clientX <= EDGE
          ? { x: touch.clientX, y: touch.clientY }
          : undefined;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (swipesBack(start, { x: touch.clientX, y: touch.clientY })) {
        start = undefined;
        go.current();
      }
    };
    const end = () => {
      start = undefined;
    };
    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', begin);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [area, on]);
}
