interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The nearest empty position at or below/right of the requested position. */
export function freePlace(at: Rect, occupied: Rect[], taken: (at: Rect) => boolean, gap: number) {
  if (!taken(at)) return at;
  const xs = [
    ...new Set([at.x, ...occupied.map((r) => r.x + r.width + gap).filter((x) => x >= at.x)]),
  ];
  const ys = [
    ...new Set([at.y, ...occupied.map((r) => r.y + r.height + gap).filter((y) => y >= at.y)]),
  ];
  let best: Rect | undefined;
  let distance = Infinity;
  for (const x of xs)
    for (const y of ys) {
      const d = Math.hypot(x - at.x, y - at.y);
      if (d >= distance || taken({ ...at, x, y })) continue;
      best = { ...at, x, y };
      distance = d;
    }
  return best!;
}

/** Grow around rewritten material while keeping the frame's bottom fixed. */
export function fitInside(frame: Rect, el: Rect) {
  const bottom = frame.y + frame.height;
  frame.width = Math.max(frame.width, el.width + 60);
  frame.height = Math.max(frame.height, el.height + 80);
  frame.y = bottom - frame.height;
  const x = Math.max(frame.x + 30, Math.min(el.x, frame.x + frame.width - el.width - 30));
  const y = Math.max(frame.y + 60, Math.min(el.y, bottom - el.height - 20));
  return { dx: x - el.x, dy: y - el.y };
}
