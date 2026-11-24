/** Merv's orb: the faceted sphere Merv.app draws too (shared orb.ts), turning while shown. On the board's toolbar and in Merv's reply box. */
import { useEffect, useRef } from 'react';
import { orbPainter, type OrbLook } from '@merv/protocol/orb';

export function OrbCanvas(look: OrbLook) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const now = useRef(look);
  now.current = look;
  const redraw = useRef<() => void>();
  useEffect(() => {
    const paint = orbPainter(canvas.current!);
    // Where nothing answers for motion, the orb is drawn still.
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? { matches: true };
    let frame = 0;
    const draw = (time: number) => {
      const el = canvas.current;
      frame = 0;
      // Only the app's hidden orb has a native replacement; the web slider can appear without a resize.
      // An orb put away with its bar (the board as a small card) has no size to draw at; it is drawn again when it has.
      if (!el?.clientWidth) return;
      if (
        !el ||
        document.hidden ||
        (el.closest('html.in-app .board-voice > .board-orb') &&
          getComputedStyle(el).visibility === 'hidden')
      )
        return;
      paint(
        now.current,
        el.clientWidth,
        !!el.parentElement?.matches(':hover'),
        time,
        still.matches,
      );
      frame = still.matches ? 0 : requestAnimationFrame(draw);
    };
    redraw.current = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current();
    document.addEventListener('visibilitychange', redraw.current);
    const watch = new ResizeObserver(() => redraw.current?.());
    watch.observe(canvas.current!);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      document.removeEventListener('visibilitychange', redraw.current!);
    };
  }, []);
  // A still orb is drawn again only when how it looks changes.
  useEffect(() => redraw.current?.(), [look.kind, look.hearing, look.muted, look.voice]);
  return <canvas ref={canvas} className="board-orb-sphere" aria-hidden="true" />;
}
