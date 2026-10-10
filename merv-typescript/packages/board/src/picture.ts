/**
 * A board drawn for its agent to look at, on the server: every shape as plain SVG (boxes, text,
 * arrows, pen strokes, frames), cropped to the whole board or to one part of it and scaled so
 * handwriting reads, with no Excalidraw, no script and nobody's screen. It is for reading what is
 * there and where, not a copy of the hand-drawn look.
 */
import type { BoardElement } from './models.js';

type El = BoardElement & Record<string, any>;
type Box = { x1: number; y1: number; x2: number; y2: number };
/** The longest side of a picture, and how far a small part is enlarged. */
const SIDE = 1600;
const MOST_SCALE = 4;
const PAD = 40;

const xml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const paint = (color: unknown, none = 'none') =>
  typeof color === 'string' && color !== 'transparent' && /^#[0-9a-fA-F]{3,8}$|^[a-z]+$/.test(color)
    ? color
    : none;
const pointsOf = (el: El): [number, number][] =>
  Array.isArray(el.points)
    ? (el.points as [number, number][]).map(([px, py]) => [el.x + px, el.y + py])
    : [];
function boxOf(el: El): Box {
  const points = pointsOf(el);
  if (points.length)
    return {
      x1: Math.min(...points.map((p) => p[0])),
      y1: Math.min(...points.map((p) => p[1])),
      x2: Math.max(...points.map((p) => p[0])),
      y2: Math.max(...points.map((p) => p[1])),
    };
  return { x1: el.x, y1: el.y, x2: el.x + el.width, y2: el.y + el.height };
}
const union = (boxes: Box[]): Box | undefined =>
  boxes.length
    ? {
        x1: Math.min(...boxes.map((b) => b.x1)),
        y1: Math.min(...boxes.map((b) => b.y1)),
        x2: Math.max(...boxes.map((b) => b.x2)),
        y2: Math.max(...boxes.map((b) => b.y2)),
      }
    : undefined;

function shape(el: El): string {
  const common = `stroke="${paint(el.strokeColor, '#1e1e1e')}" stroke-width="${Math.max(1, Number(el.strokeWidth) || 2)}" opacity="${(Number(el.opacity) || 100) / 100}"`;
  const fill = `fill="${paint(el.backgroundColor)}"`;
  switch (el.type) {
    case 'rectangle': {
      const r = el.roundness ? Math.min(el.width, el.height) * 0.15 : 0;
      return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${r}" ${fill} ${common}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${el.x + el.width / 2}" cy="${el.y + el.height / 2}" rx="${el.width / 2}" ry="${el.height / 2}" ${fill} ${common}/>`;
    case 'diamond': {
      const [cx, cy] = [el.x + el.width / 2, el.y + el.height / 2];
      return `<polygon points="${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}" ${fill} ${common}/>`;
    }
    case 'frame':
      return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="8" fill="none" stroke="#999" stroke-dasharray="8 6" stroke-width="2"/><text x="${el.x}" y="${el.y - 8}" font-size="16" fill="#666" font-family="sans-serif">${xml(String(el.name ?? ''))}</text>`;
    case 'text': {
      const size = Number(el.fontSize) || 20;
      const step = size * (Number(el.lineHeight) || 1.25);
      const align =
        el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
      const x = align === 'middle' ? el.x + el.width / 2 : align === 'end' ? el.x + el.width : el.x;
      const lines = String(el.text ?? '').split('\n');
      return `<text font-size="${size}" font-family="'Comic Sans MS','Segoe Print',sans-serif" fill="${paint(el.strokeColor, '#1e1e1e')}" text-anchor="${align}">${lines
        .map(
          (line, i) => `<tspan x="${x}" y="${el.y + step * i + size * 0.9}">${xml(line)}</tspan>`,
        )
        .join('')}</text>`;
    }
    case 'arrow':
    case 'line':
    case 'freedraw': {
      const points = pointsOf(el);
      if (points.length < 2) return '';
      const line = points.map(([x, y]) => `${x},${y}`).join(' ');
      const width =
        el.type === 'freedraw' ? Math.max(2, (Number(el.strokeWidth) || 2) * 1.5) : undefined;
      let head = '';
      if (el.type === 'arrow' && el.endArrowhead) {
        const [[ax, ay], [bx, by]] = points.slice(-2) as [[number, number], [number, number]];
        const angle = Math.atan2(by - ay, bx - ax);
        const wing = (turn: number) =>
          `${bx - 14 * Math.cos(angle + turn)},${by - 14 * Math.sin(angle + turn)}`;
        head = `<polyline points="${wing(0.45)} ${bx},${by} ${wing(-0.45)}" fill="none" ${common}/>`;
      }
      return `<polyline points="${line}" ${el.type === 'line' ? fill : 'fill="none"'} ${common}${width ? ` stroke-width="${width}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>${head}`;
    }
    default:
      return '';
  }
}

/**
 * The board, or with `focus` the part it names (a frame with what it holds, a group, a shape), as
 * a page: the part fills the picture with a margin of what surrounds it. A focus the board does
 * not hold is said back as text.
 */
export function pictureOf(elements: BoardElement[], focus?: string) {
  const live = (elements as El[]).filter((el) => !el.isDeleted);
  let target = live;
  if (focus) {
    const named = live.find((el) => el.id === focus);
    if (!named) return `No shape "${focus}" on this board.`;
    const group = named.groupIds?.[0];
    target = live.filter(
      (el) =>
        el.id === named.id ||
        el.containerId === named.id ||
        (named.type === 'frame' && el.frameId === named.id) ||
        (group && el.groupIds?.includes(group)),
    );
  }
  const area = union(target.map(boxOf)) ?? { x1: 0, y1: 0, x2: 400, y2: 300 };
  const [x, y] = [area.x1 - PAD, area.y1 - PAD];
  const [w, h] = [area.x2 - area.x1 + 2 * PAD, area.y2 - area.y1 + 2 * PAD];
  const scale = Math.min(MOST_SCALE, SIDE / Math.max(w, h));
  const [width, height] = [
    Math.max(200, Math.round(w * scale)),
    Math.max(200, Math.round(h * scale)),
  ];
  // Drawn in the board's own order, so what was drawn last stands on top.
  const ordered = [...live].sort((a, b) =>
    String(a.index ?? '￿') < String(b.index ?? '￿') ? -1 : 1,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${w} ${h}">${ordered.map(shape).join('')}</svg>`;
  return {
    html: `<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`,
    width,
    height,
  };
}
