/**
 * An SVG path's `d` as the points a pen would pass through: lines kept as they are, curves and
 * arcs walked in short steps. Each subpath (from one move to the next) is its own stroke, closed
 * where it ends in Z. What it cannot read it refuses by name, never by drawing something else.
 */
import { MervError } from '@merv/contracts';

type Point = [number, number];
export interface Stroke {
  points: Point[];
  closed: boolean;
}
/** Steps a curve or an arc is walked in. */
const STEPS = 16;
/** The most points one path may come to. */
const MOST = 4_000;

const refuse = (why: string) => {
  throw new MervError('board_bad_path', `A sketch path could not be read: ${why}`, 400);
};

function tokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  for (const [, command, number, , other] of d.matchAll(re)) {
    if (other) refuse(`"${other}" is not part of a path`);
    if (command) out.push(command);
    else if (number !== undefined) out.push(Number(number));
  }
  return out;
}

/** The points of an SVG elliptical arc from `from` (the endpoint parameterisation, as SVG 1.1 F.6). */
function arc(
  from: Point,
  rx: number,
  ry: number,
  angle: number,
  large: boolean,
  sweep: boolean,
  to: Point,
): Point[] {
  if (!rx || !ry) return [to];
  const phi = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const grow = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (grow > 1) [rx, ry] = [rx * Math.sqrt(grow), ry * Math.sqrt(grow)];
  const sign = large === sweep ? -1 : 1;
  const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const root = sign * Math.sqrt(Math.max(0, top / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (root * rx * y1) / ry;
  const cy1 = (-root * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const at = (ux: number, uy: number) => Math.atan2(uy, ux);
  const start = at((x1 - cx1) / rx, (y1 - cy1) / ry);
  let sweepAngle = at((-x1 - cx1) / rx, (-y1 - cy1) / ry) - start;
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(sweepAngle) / (Math.PI / 2)) * (STEPS / 2)));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = start + (sweepAngle * i) / steps;
    const [ex, ey] = [rx * Math.cos(t), ry * Math.sin(t)];
    points.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return points;
}

const cubic = (p0: Point, p1: Point, p2: Point, p3: Point): Point[] =>
  Array.from({ length: STEPS }, (_, i) => {
    const t = (i + 1) / STEPS;
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  });
const quadratic = (p0: Point, p1: Point, p2: Point): Point[] =>
  cubic(
    p0,
    [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])],
    [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])],
    p2,
  );

/** Every stroke of a path, in the path's own coordinates. */
export function strokesOf(d: string): Stroke[] {
  const list = tokens(d);
  const strokes: Stroke[] = [];
  let current: Stroke | undefined;
  let at: Point = [0, 0];
  let start: Point = [0, 0];
  let control: Point | undefined;
  let command = '';
  let i = 0;
  const number = () => {
    const value = list[i++];
    if (typeof value !== 'number') refuse(`${command} needs more numbers`);
    return value as number;
  };
  const go = (points: Point[]) => {
    if (!current) {
      current = { points: [at], closed: false };
      strokes.push(current);
    }
    current.points.push(...points);
    at = points.at(-1) ?? at;
    if (strokes.reduce((n, s) => n + s.points.length, 0) > MOST) refuse(`more than ${MOST} points`);
  };
  if (typeof list[0] === 'string' && list[0].toUpperCase() !== 'M')
    refuse('it does not begin with M');
  while (i < list.length) {
    if (typeof list[i] === 'string') command = list[i++] as string;
    else if (!command) refuse('it does not begin with M');
    const relative = command === command.toLowerCase();
    const base: Point = relative ? at : [0, 0];
    const point = (): Point => {
      const x = number();
      return [base[0] + x, base[1] + number()];
    };
    switch (command.toUpperCase()) {
      case 'M': {
        at = point();
        start = at;
        current = undefined;
        control = undefined;
        // Pairs after a move's first are lines, as SVG reads them.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L':
        go([point()]);
        control = undefined;
        break;
      case 'H': {
        const x = number();
        go([[relative ? at[0] + x : x, at[1]]]);
        control = undefined;
        break;
      }
      case 'V': {
        const y = number();
        go([[at[0], relative ? at[1] + y : y]]);
        control = undefined;
        break;
      }
      case 'C': {
        const [c1, c2, end] = [point(), point(), point()];
        go(cubic(at, c1, c2, end));
        control = c2;
        break;
      }
      case 'S': {
        const c1: Point = control ? [2 * at[0] - control[0], 2 * at[1] - control[1]] : at;
        const [c2, end] = [point(), point()];
        go(cubic(at, c1, c2, end));
        control = c2;
        break;
      }
      case 'Q': {
        const [c, end] = [point(), point()];
        go(quadratic(at, c, end));
        control = c;
        break;
      }
      case 'T': {
        const c: Point = control ? [2 * at[0] - control[0], 2 * at[1] - control[1]] : at;
        go(quadratic(at, c, point()));
        control = c;
        break;
      }
      case 'A': {
        const [rx, ry, angle, large, sweep] = [number(), number(), number(), number(), number()];
        go(arc(at, rx, ry, angle, !!large, !!sweep, point()));
        control = undefined;
        break;
      }
      case 'Z':
        if (current) {
          current.points.push(start);
          current.closed = true;
        }
        at = start;
        current = undefined;
        control = undefined;
        break;
      default:
        refuse(`unknown command ${command}`);
    }
  }
  const drawn = strokes.filter((stroke) => stroke.points.length > 1);
  if (!drawn.length) refuse('it draws nothing');
  return drawn;
}
