import { useEffect, useRef, useState, type RefObject } from 'react';

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { cardAt } from './board-tap-open';
type Card = {
  node: RefObject<HTMLElement>;
  also?: RefObject<HTMLElement>;
  full: boolean;
  nativeFocus: boolean;
  state: { live: boolean; opened: boolean };
  set(state: Card['state']): void;
};
/** Resting cards pass gestures to the canvas. One board owns the pointer, listeners and one timer.
 * A stationary pointer or completed click wakes a card; the activating click is swallowed.
 * A finger has no hover: its tap keeps the card awake until a touch lands elsewhere. */
export function pageActivity(api: ExcalidrawImperativeAPI) {
  const cards = new Map<string, Card>();
  let x = -1,
    y = -1,
    visible = true,
    wheelUntil = 0;
  let down: { x: number; y: number; moved: boolean } | undefined,
    clicked: Card | undefined,
    touched: Card | undefined;
  let rest: ReturnType<typeof setTimeout>;
  const change = (c: Card, live: boolean) => {
    if (c.state.live !== live) c.set((c.state = { live, opened: c.state.opened || live }));
  };
  const own = (c: Card, target: EventTarget | null) =>
    c.node.current?.contains(target as Node) || c.also?.current?.contains(target as Node);
  const focused = (c: Card) =>
    c.nativeFocus ||
    (c.node.current?.contains(document.activeElement) &&
      document.activeElement?.tagName !== 'WEBVIEW' &&
      document.hasFocus());
  const hit = () =>
    x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight
      ? undefined
      : ([...cards.values()].find((c) => c.full) ??
        cards.get(
          cardAt(api.getSceneElements(), api.getAppState(), x, y, (s) => cards.has(s.id))?.id ?? '',
        ));
  const check = () => {
    clearTimeout(rest);
    if (!cards.size) return;
    if (!visible || document.hidden) {
      touched = undefined;
      for (const card of cards.values()) change(card, false);
      return;
    }
    if (performance.now() < wheelUntil) {
      rest = setTimeout(check, wheelUntil - performance.now());
      return;
    }
    for (const card of cards.values()) if (focused(card) || card === touched) change(card, true);
    rest = setTimeout(() => {
      const hover = down ? undefined : hit();
      for (const card of cards.values())
        change(card, card === hover || card === touched || !!focused(card));
    }, 1000);
  };
  const move = (e: PointerEvent) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
    if (x === e.clientX && y === e.clientY) return;
    x = e.clientX;
    y = e.clientY;
    check();
  };
  // A canvas gesture revokes grace-period input before it crosses a card.
  const start = (e: PointerEvent | WheelEvent) => {
    for (const card of cards.values())
      if (!own(card, e.target)) {
        if (touched === card) touched = undefined;
        change(card, false);
      }
    clearTimeout(rest);
    if (e.type === 'pointerdown') {
      x = e.clientX;
      y = e.clientY;
      down = { x, y, moved: false };
      clicked = undefined;
    } else {
      wheelUntil = performance.now() + 180;
      if (down) down.moved = true;
      check();
    }
  };
  const end = (e: PointerEvent) => {
    clicked =
      down &&
      !down.moved &&
      e.type !== 'pointercancel' &&
      e.button === 0 &&
      performance.now() >= wheelUntil
        ? hit()
        : undefined;
    // A finger may never send click: the canvas already received its complete gesture.
    if (clicked && e.pointerType !== 'mouse' && !clicked.state.live) {
      touched = clicked;
      clicked = undefined;
    }
    down = undefined;
    check();
  };
  const click = (e: MouseEvent) => {
    if (clicked && !clicked.state.live && clicked === hit() && visible && !document.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      change(clicked, true);
    }
    clicked = undefined;
    check();
  };
  const blur = () => {
    x = y = -1;
    down = clicked = undefined;
    check();
  };
  const events = {
    pointermove: move,
    pointerdown: start,
    pointerup: end,
    pointercancel: end,
    click,
    wheel: start,
    focusin: check,
    focusout: check,
    visibilitychange: check,
    focus: check,
    blur,
    pointerleave: () => {
      x = y = -1;
      check();
    },
    'merv:pages-visible': (e: CustomEvent<boolean>) => {
      visible = !!e.detail;
      if (visible) check();
      else blur();
    },
  };
  const listen = () => {
    const stop = new window.AbortController();
    for (const [name, fn] of Object.entries(events)) {
      const target = ['merv:pages-visible', 'blur', 'focus'].includes(name) ? window : document;
      target.addEventListener(name, fn as EventListener, {
        capture: target === document && name !== 'pointerleave',
        signal: stop.signal,
      });
    }
    return () => {
      stop.abort();
      clearTimeout(rest);
    };
  };
  return {
    check,
    listen,
    subscribe: (id: string, card: Card) => {
      cards.set(id, card);
      check();
      return () => void cards.delete(id);
    },
  };
}
/** `also` is the card's unscaled Full screen / Close strip: touching it belongs to the card.
 * Board geometry rechecks once in BoardPages; local focus/full-screen changes recheck here. */
export function usePageActivity(
  activity: ReturnType<typeof pageActivity>,
  id: string,
  node: RefObject<HTMLElement>,
  full = false,
  nativeFocus = false,
  also?: RefObject<HTMLElement>,
) {
  const [state, setState] = useState({ live: false, opened: false });
  const card = useRef({ node, also, full, nativeFocus, state, set: setState });
  Object.assign(card.current, { full, nativeFocus });
  useEffect(() => activity.subscribe(id, card.current), [activity, id, full, nativeFocus]);
  return state;
}
