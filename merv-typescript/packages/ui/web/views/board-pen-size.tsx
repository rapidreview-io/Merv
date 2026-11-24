import { useLayoutEffect, useRef } from 'react';

type Box = { left: number; top: number; right: number; bottom: number };
const GAP = 8;

/** Where the sizes go, in the coordinates of `frame` (the box they are positioned in): centred on the pencil,
 *  just past the toolbar's edge that faces the board (below a toolbar in the top half, above one in the bottom
 *  half), stepping past any other control already there, and kept inside what is visible of the frame. */
export function penSizePlace(
  pencil: Box,
  bar: Box,
  frame: Box,
  view: { width: number; height: number },
  size: { width: number; height: number },
  others: Box[] = [],
) {
  const seen = {
    left: Math.max(frame.left, 0),
    top: Math.max(frame.top, 0),
    right: Math.min(frame.right, view.width),
    bottom: Math.min(frame.bottom, view.height),
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const below = (bar.top + bar.bottom) / 2 < (seen.top + seen.bottom) / 2;
  const left = clamp(
    (pencil.left + pencil.right) / 2 - size.width / 2,
    seen.left + GAP,
    seen.right - GAP - size.width,
  );
  let top = below ? bar.bottom + GAP : bar.top - GAP - size.height;
  for (let step = 0; step < 4; step++) {
    const hit = others.find(
      (o) =>
        o.left < left + size.width && o.right > left && o.top < top + size.height && o.bottom > top,
    );
    if (!hit) break;
    top = below ? hit.bottom + GAP : hit.top - GAP - size.height;
  }
  top = clamp(top, seen.top + GAP, seen.bottom - GAP - size.height);
  return { left: left - frame.left, top: top - frame.top };
}

/** The board's three pen widths, shown only while the pen is selected, always beside the pencil. */
export function BoardPenSize({
  pen,
  onChange,
}: {
  pen: number | undefined;
  onChange(width: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = pen !== undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    let frame = 0;
    let last = '';
    // Older Mac apps inject their own top/bottom for these; the pencil's place outranks every one of them.
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('transform', 'none', 'important');
    // Follow the pencil wherever the toolbar puts it: it moves, folds and wraps without telling anyone.
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const root = el.parentElement;
      const pencil = root?.querySelector('[data-testid="toolbar-freedraw"]')?.closest('label');
      const box = (el.offsetParent ?? root)?.getBoundingClientRect();
      const at = pencil?.getBoundingClientRect();
      if (!pencil || !box || !at || !at.width) {
        if (last !== 'hidden') el.style.setProperty('visibility', 'hidden', 'important');
        last = 'hidden';
        return;
      }
      const bar = (
        pencil.closest('.App-toolbar, .App-toolbar-content') ?? pencil
      ).getBoundingClientRect();
      const others = [...root!.querySelectorAll('button, label, a, [role="button"], .voice-who')]
        .filter((o) => !el.contains(o))
        .map((o) => o.getBoundingClientRect())
        .filter((o) => o.width && o.height);
      const { left, top } = penSizePlace(
        at,
        bar,
        box,
        { width: innerWidth, height: innerHeight },
        { width: el.offsetWidth, height: el.offsetHeight },
        others,
      );
      const next = `${Math.round(left)},${Math.round(top)}`;
      if (next === last) return;
      last = next;
      el.style.setProperty('left', `${Math.round(left)}px`, 'important');
      el.style.setProperty('top', `${Math.round(top)}px`, 'important');
      el.style.setProperty('visibility', 'visible', 'important');
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  if (!shown) return null;
  return (
    <div ref={ref} className="board-pen-size" role="radiogroup" aria-label="Pen size">
      {(
        [
          [1, 'Fine'],
          [2, 'Medium'],
          [4, 'Bold'],
        ] as const
      ).map(([width, name]) => (
        <button
          key={width}
          type="button"
          role="radio"
          aria-checked={pen === width}
          aria-label={name}
          title={name}
          onClick={() => onChange(width)}
        >
          <span style={{ width: 3 + width * 2, height: 3 + width * 2 }} />
        </button>
      ))}
    </div>
  );
}
