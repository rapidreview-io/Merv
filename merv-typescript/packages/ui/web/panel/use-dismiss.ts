import { useState, useRef, useEffect } from 'react';

/** A menu goes on a click anywhere else or Escape, which closes only the menu and never the panel. */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  close: (event: PointerEvent | KeyboardEvent) => void,
  { capture = true, escape = true, prevent = true } = {},
) {
  const ref = useRef<T>(null);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) latest.current(event);
    };
    const key = (event: KeyboardEvent) => {
      if (escape && event.key === 'Escape') {
        if (prevent) event.preventDefault();
        event.stopPropagation();
        latest.current(event);
      }
    };
    document.addEventListener('pointerdown', outside, capture);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, capture);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, capture, escape, prevent]);
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
