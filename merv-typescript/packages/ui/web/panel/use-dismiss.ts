import { useState, useRef, useEffect } from 'react';

/**
 * The one way a menu, panel or card goes away: a press outside what `inside` returns, or Escape,
 * while it is `open`. `stop` keeps Escape from also closing whatever holds it (the panel); `press`
 * is which press counts, `capture` whether it is heard before the page's own handlers.
 */
export function useDismissOn(
  open: boolean,
  inside: () => HTMLElement | null | undefined,
  close: (event: PointerEvent | MouseEvent | KeyboardEvent) => void,
  {
    capture = true,
    escape = true,
    prevent = true,
    stop = true,
    press = 'pointerdown' as 'pointerdown' | 'mousedown',
  } = {},
) {
  const latest = useRef({ close, inside });
  latest.current = { close, inside };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | MouseEvent) => {
      if (!latest.current.inside()?.contains(event.target as Node)) latest.current.close(event);
    };
    const key = (event: KeyboardEvent) => {
      if (escape && event.key === 'Escape') {
        if (prevent) event.preventDefault();
        if (stop) event.stopPropagation();
        latest.current.close(event);
      }
    };
    document.addEventListener(press, outside, capture);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener(press, outside, capture);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, capture, escape, prevent, stop, press]);
}

/** A menu goes on a click anywhere else or Escape, which closes only the menu and never the panel. */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  close: (event: PointerEvent | MouseEvent | KeyboardEvent) => void,
  options: Parameters<typeof useDismissOn>[3] = {},
) {
  const ref = useRef<T>(null);
  useDismissOn(open, () => ref.current, close, options);
  return ref;
}

export function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(
    open,
    (event) => {
      setOpen(false);
      if (event.type === 'keydown') ref.current?.querySelector('button')?.focus();
    },
    { capture: false, prevent: false },
  );
  return { open, setOpen, ref };
}
