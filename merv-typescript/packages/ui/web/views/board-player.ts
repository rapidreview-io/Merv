/**
 * The player of a board's changes, the same for watching and for replay: it is given shapes in the
 * order they came and draws them on a canvas one after another as a hand would, then lands each in
 * the scene. Each is first drawn whole, off screen, exactly as the scene will draw it, and shown
 * through a mask that follows the pen, so what lands is what was traced, pixel for pixel. Watching,
 * it keeps up with the newest changes; replaying, it is fed history from the start. What it has not
 * landed is in no scene, so nothing animated can be saved, change a shape's version or enter undo.
 */
import {
  CaptureUpdateAction,
  exportToCanvas,
  getCommonBounds,
  getDataURL,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import {
  penMs,
  penUnits,
  stacked,
  type BoardElement,
  type PenStep,
  type PenUnit,
} from '@merv/board/models';
import { accountRequest, type ApiError } from '../api';
import type { Rect } from './board-place';

type Point = [number, number];
/** A unit as the scene will draw it, on a canvas of its own: where it stands, and its pixels a unit. */
interface Ink {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  scale: number;
  /** All of it but what is written, which the pen writes on top: absent if it is only words. */
  under?: { canvas: HTMLCanvasElement; x: number; y: number };
}
/** Where the pen goes for a step: along `path`, or across the lines of what is written, or over all. */
interface Mark {
  box: Rect;
  path?: Point[];
  band?: number;
  lines?: (Rect & { from: number; to: number })[];
}
interface Unit extends PenUnit {
  /** The step in hand; its ink and marks; and that it lands without being drawn. */
  at: number;
  ink?: Ink | null;
  marks?: Mark[];
  inking?: boolean;
  quiet?: boolean;
}
/** Past this many times what it may stay behind it no longer draws the oldest: they land at once. */
const FAR = 10;
/** The fastest it hurries to catch up, and how gently it changes speed. */
const [MOST_SPEED, SPEED_EASE_MS] = [3, 700];
/** Room around a shape on its canvas, and how much around a stroke the mask opens. */
const [ROOM, BAND] = [24, 14];
/** The most pixels one unit is drawn in: a shape larger than that just lands. */
const MOST_PIXELS = 16_000_000;
/** A frame's outline, as a shape: an export does not draw it as the scene does, and its name lands. */
const FRAME = {
  type: 'rectangle',
  strokeColor: '#bbb',
  strokeWidth: 2,
  roughness: 0,
  roundness: { type: 3 },
  backgroundColor: 'transparent',
};
/** How long an image's bytes are waited for; how long ink stays over what landed, the last fading. */
const [IMAGE_WAIT_MS, LINGER_MS, FADE_MS] = [1500, 100, 60];
/** How Excalidraw keeps an image's colours under a dark page's filter. */
const IMAGE_INVERT = 'invert(100%) hue-rotate(180deg) saturate(1.25)';

const lengths = (points: Point[]) =>
  points.slice(1).map(([x, y], i) => Math.hypot(x - points[i]![0], y - points[i]![1]));
/** The stroke's points as far as a share of its length. */
const penned = (points: Point[], share: number) => {
  const each = lengths(points);
  let left = share * each.reduce((sum, length) => sum + length, 0);
  const out = [points[0]!];
  for (const [i, length] of each.entries()) {
    const [a, b] = [points[i]!, points[i + 1]!];
    if (left < length) {
      out.push([a[0] + ((b[0] - a[0]) * left) / length, a[1] + ((b[1] - a[1]) * left) / length]);
      break;
    }
    out.push(b);
    left -= length;
  }
  return out;
};
/** Slow off the mark and into the end, as a hand is, without dawdling. */
const eased = (t: number) => 0.4 * t + 0.6 * t * t * (3 - 2 * t);
/** The way a pen goes round a shape, on the board. */
const pathOf = (shape: BoardElement): Point[] | undefined => {
  const { type, width: w, height: h, points, x, y, angle } = shape;
  if (type === 'text' || type === 'image') return undefined;
  const local: Point[] = Array.isArray(points)
    ? (points as Point[])
    : type === 'ellipse'
      ? Array.from({ length: 49 }, (_, i) => {
          const turn = -Math.PI / 2 + (i / 48) * 2 * Math.PI;
          return [(w / 2) * (1 + Math.cos(turn)), (h / 2) * (1 + Math.sin(turn))];
        })
      : type === 'diamond'
        ? [
            [w / 2, 0],
            [w, h / 2],
            [w / 2, h],
            [0, h / 2],
            [w / 2, 0],
          ]
        : [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
            [0, 0],
          ];
  // A turned shape turns about the middle of all of it.
  const [xs, ys] = [local.map((p) => p[0]), local.map((p) => p[1])];
  const [cx, cy] = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  const [sin, cos] = [Math.sin(Number(angle ?? 0)), Math.cos(Number(angle ?? 0))];
  return local.map(([px, py]) => [
    x + cx + (px - cx) * cos - (py - cy) * sin,
    y + cy + (px - cx) * sin + (py - cy) * cos,
  ]);
};
/** The lines of what is written, in the order of a hand, each its share of the writing. */
const linesOf = (shape: BoardElement, box: Rect): Mark['lines'] => {
  const rows = String(shape.text ?? '').split('\n');
  const total = rows.reduce((sum, row) => sum + row.length, 0) || 1;
  const height = box.height / rows.length;
  let done = 0;
  return rows.map((row, i) => ({
    ...box,
    y: box.y + i * height,
    height,
    from: done / total,
    to: (done += row.length) / total,
  }));
};

/** The canvas the player lands shapes on. */
export interface Stage {
  /** Lands shapes in the scene; `settled` when nothing else is waiting to. */
  show(shapes: BoardElement[], settled: boolean): void;
  /** The shapes the scene shows now. */
  standing(): Set<string>;
  camera(): { scrollX: number; scrollY: number; zoom: { value: number } };
  /** While so, the player waits. */
  held(): boolean;
  /** The images these show, as far as the page has them, asking for the rest. */
  files?(shapes: BoardElement[]): BinaryFiles;
}

export class Player {
  private queue: Unit[] = [];
  /** How far into its step the first of the queue is, and how long all of it has left. */
  private spent = 0;
  private left = 0;
  private speed: number;
  private frame = 0;
  private last = 0;
  /** Where the pen's tip was; ink kept over what just landed until the scene has drawn it. */
  private tip?: Point;
  private landed: { ink: Ink; until: number }[] = [];
  private mask = document.createElement('canvas');
  /** Lands all it is given at once. */
  instant = false;
  /** Called once all it was given has landed. */
  idle?: () => void;
  /** Hears where the pen's tip is on the board as it draws and lifts, and null when it is done. */
  pen?: (tip: Point | null) => void;
  /**
   * @param behind How far behind it plays at a hand's pace, in milliseconds: given more, it hurries,
   * up to three times that, and at ten times what is oldest lands at once. Infinity never hurries.
   * @param rate How fast it plays at the least.
   */
  constructor(
    readonly stage: Stage,
    private canvas: HTMLCanvasElement,
    private behind: number,
    /** Replay moves this to the speed it plays at. */
    public rate = 1,
  ) {
    this.speed = rate;
  }
  /** How many things are still to land. */
  get waiting() {
    return this.queue.length;
  }
  add(shapes: BoardElement[]) {
    if (!shapes.length) return;
    if (this.instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.finish();
      this.stage.show(shapes, true);
      this.idle?.();
      return;
    }
    // What is on its way counts as there: a later change to it is no second drawing of it.
    const standing = this.stage.standing();
    for (const unit of this.queue) for (const shape of unit.shapes) standing.add(shape.id);
    const units = penUnits(shapes, (id) => standing.has(id));
    this.queue.push(...units.map((unit) => ({ ...unit, at: 0 })));
    this.left += penMs(units);
    // Too far behind to draw it all honestly: the oldest land, and the pen stays with the newest.
    for (const unit of this.queue.slice(1)) {
      if (this.left <= this.behind * FAR) break;
      if (unit.quiet) continue;
      unit.quiet = true;
      this.left -= penMs([unit]);
    }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }
  /** Someone stepped in: the stroke in hand ends and what is left lands at once, without a show. */
  hurry() {
    const [head, ...rest] = this.queue;
    for (const unit of rest) unit.quiet = true;
    this.left = 0;
    if (!head) return;
    const started = this.spent > (head.steps[head.at]?.rest ?? 0);
    head.steps = head.steps.slice(0, head.at + (started ? 1 : 0));
    if (!head.steps.length) head.quiet = true;
  }
  /** Lands what is waiting, at once. */
  finish() {
    const shapes = this.queue.flatMap((unit) => unit.shapes);
    this.stop();
    if (shapes.length) this.stage.show(shapes, true);
  }
  /** Forgets what is waiting. */
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = this.spent = this.left = 0;
    this.queue = [];
    this.landed = [];
    this.draw();
    this.pen?.(null);
  }
  /** Draws a unit whole, as the scene will, at the scale the view now shows it. */
  private async inked(unit: Unit) {
    if (unit.inking) return;
    unit.inking = true;
    const scale = devicePixelRatio * this.stage.camera().zoom.value;
    const drawn = unit.steps.map(({ shape }) => shape);
    const shapes = restored(
      drawn.map((shape) => ({ ...shape, frameId: null, ...(shape.type === 'frame' && FRAME) })),
      true,
    );
    const [x1, y1, x2, y2] = getCommonBounds(shapes);
    const images = drawn.filter(({ type }) => type === 'image');
    const missing = () => images.some((el) => !this.stage.files?.(drawn)[String(el.fileId)]);
    for (let waited = 0; missing() && waited < IMAGE_WAIT_MS; waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const inkOf = (elements: typeof shapes) =>
      exportToCanvas({
        elements,
        files: this.stage.files?.(drawn) ?? {},
        exportPadding: ROOM,
        appState: { exportBackground: false, exportWithDarkMode: false },
        getDimensions: (width: number, height: number) => ({
          width: Math.ceil(width * scale),
          height: Math.ceil(height * scale),
          scale,
        }),
      });
    const bare = shapes.filter(({ type }) => type !== 'text');
    const big = (x2 - x1 + 2 * ROOM) * (y2 - y1 + 2 * ROOM) * scale ** 2 > MOST_PIXELS;
    const canvases = big
      ? null
      : await Promise.all([
          inkOf(shapes),
          bare.length && bare.length < shapes.length ? inkOf(bare) : null,
        ]).catch(() => null);
    unit.inking = false;
    if (!canvases) {
      unit.ink = null;
      unit.quiet = true;
      return;
    }
    let [canvas, under] = canvases as [HTMLCanvasElement, HTMLCanvasElement | null];
    // The page's filter turns the canvas dark, and an image back, which Excalidraw does as it draws it.
    if (images.length && this.canvas.classList.contains('is-dark')) {
      const turned = document.createElement('canvas');
      [turned.width, turned.height] = [canvas.width, canvas.height];
      const paint = turned.getContext('2d')!;
      paint.filter = IMAGE_INVERT;
      paint.drawImage(canvas, 0, 0);
      canvas = turned;
    }
    const [ux, uy] = under ? getCommonBounds(bare) : [x1, y1];
    const ink: Ink = {
      canvas,
      x: x1 - ROOM,
      y: y1 - ROOM,
      scale,
      ...(bare.length && {
        under: { canvas: under ?? canvas, x: ux - ROOM, y: uy - ROOM },
      }),
    };
    unit.ink = ink;
    unit.marks = unit.steps.map(({ shape }) => {
      const [left, top, right, bottom] = getCommonBounds(shapes.filter((el) => el.id === shape.id));
      const box = { x: left, y: top, width: right - left, height: bottom - top };
      return shape.type === 'text'
        ? { box, lines: linesOf(shape, box) }
        : {
            box,
            path: pathOf(shape),
            band: Number(shape.strokeWidth ?? 2) + BAND,
          };
    });
  }
  private tick = (at: number) => {
    const played = at - this.last;
    this.last = at;
    this.frame = requestAnimationFrame(this.tick);
    this.landed = this.landed.filter(({ until }) => until > at);
    if (!this.stage.held()) {
      const wanted = this.rate * Math.min(MOST_SPEED, Math.max(1, this.left / this.behind));
      this.speed += (wanted - this.speed) * (1 - Math.exp(-played / SPEED_EASE_MS));
      let budget = played * this.speed;
      const due: BoardElement[] = [];
      for (let head = this.queue[0]; head; head = this.queue[0]) {
        const step = head.quiet ? undefined : head.steps[head.at];
        if (step && !head.ink) {
          void this.inked(head);
          break;
        }
        const takes = step ? step.rest + step.ms : head.quiet ? 0 : head.ms;
        if (this.spent + budget < takes) {
          this.spent += budget;
          this.left = Math.max(0, this.left - budget);
          break;
        }
        budget -= takes - this.spent;
        this.left = Math.max(0, this.left - (takes - this.spent));
        this.spent = 0;
        if (step && ++head.at < head.steps.length) continue;
        this.queue.shift();
        due.push(...head.shapes);
        if (head.ink && step) this.landed.push({ ink: head.ink, until: at + LINGER_MS });
      }
      // What comes next is ready before the pen reaches it.
      const next = this.queue.slice(1, 3).find((unit) => !unit.quiet && unit.steps.length);
      if (next && next.ink === undefined) void this.inked(next);
      if (due.length) this.stage.show(due, !this.queue.length);
    }
    this.draw();
    if (this.queue.length || this.landed.length) return;
    cancelAnimationFrame(this.frame);
    this.frame = this.left = 0;
    this.pen?.(null);
    this.idle?.();
  };
  /** A step's mask as far as `share`, the pen's tip there, in the mask's board coordinates. */
  private reveal(
    mask: CanvasRenderingContext2D,
    { box, path, band = 0 }: Mark,
    { ms, flood }: PenStep,
    share: number,
  ): Point {
    if (!path) {
      mask.globalAlpha = share;
      mask.fillRect(box.x, box.y, box.width, box.height);
      mask.globalAlpha = 1;
      return [box.x + box.width / 2, box.y + box.height / 2];
    }
    // The outline first; then the rest of the way, the mask widens to take in all of the shape.
    const trace = ms ? (ms - flood) / ms : 1;
    const [traced, widened] =
      share < trace ? [share / trace, 0] : [1, (share - trace) / (1 - trace || 1)];
    const line = penned(path, eased(traced));
    mask.lineWidth = band + widened * 2 * Math.max(box.width, box.height, 2 * ROOM);
    mask.beginPath();
    for (const [x, y] of line) mask.lineTo(x, y);
    mask.stroke();
    return line.at(-1)!;
  }
  /** What is in the pen as far as it has got, where the scene would draw it, or nothing. */
  private draw() {
    const { canvas } = this;
    const ratio = devicePixelRatio;
    const [width, height] = [canvas.clientWidth, canvas.clientHeight].map((n) =>
      Math.floor(n * ratio),
    ) as [number, number];
    if (canvas.width !== width || canvas.height !== height)
      [canvas.width, canvas.height] = [width, height];
    const pen = canvas.getContext('2d')!;
    pen.setTransform(1, 0, 0, 1, 0, 0);
    pen.clearRect(0, 0, width, height);
    const { scrollX, scrollY, zoom } = this.stage.camera();
    const scale = ratio * zoom.value;
    const blit = (from: CanvasImageSource, ink: Ink) => {
      const fit = scale / ink.scale;
      pen.setTransform(fit, 0, 0, fit, scale * (scrollX + ink.x), scale * (scrollY + ink.y));
      pen.drawImage(from, 0, 0);
    };
    for (const { ink, until } of this.landed) {
      pen.globalAlpha = Math.min(1, (until - performance.now()) / FADE_MS);
      blit(ink.canvas, ink);
    }
    pen.globalAlpha = 1;
    const head = this.queue[0];
    const step = head?.steps[head.at];
    if (!head?.ink || !head.marks || !step || head.quiet) return;
    const { ink, marks } = head;
    // A zoom has moved on: the next frames draw it again at the scale now shown.
    if (Math.abs(ink.scale / scale - 1) > 0.08) void this.inked(head);
    const { mask } = this;
    if (mask.width !== ink.canvas.width || mask.height !== ink.canvas.height)
      [mask.width, mask.height] = [ink.canvas.width, ink.canvas.height];
    const draw = mask.getContext('2d')!;
    draw.setTransform(1, 0, 0, 1, 0, 0);
    draw.globalCompositeOperation = 'source-over';
    draw.clearRect(0, 0, mask.width, mask.height);
    const toBoard = () =>
      draw.setTransform(ink.scale, 0, 0, ink.scale, -ink.x * ink.scale, -ink.y * ink.scale);
    toBoard();
    draw.lineCap = draw.lineJoin = 'round';
    draw.strokeStyle = draw.fillStyle = '#000';
    const raw = (this.spent - step.rest) / (step.ms || 1);
    let tip = this.tip;
    // First all but the words, as far as the pen has come round it; what is not reached yet stays
    // hidden, whatever has been coloured in around it.
    head.steps.forEach((each, j) => {
      const mark = marks[j];
      if (!mark || mark.lines) return;
      if (j > head.at) {
        draw.globalCompositeOperation = 'destination-out';
        draw.fillRect(mark.box.x, mark.box.y, mark.box.width, mark.box.height);
        draw.globalCompositeOperation = 'source-over';
      } else if (j < head.at || raw > 0) {
        const at = this.reveal(draw, mark, each, j < head.at ? 1 : Math.min(1, raw));
        if (j === head.at) tip = at;
      }
    });
    draw.globalCompositeOperation = 'source-in';
    if (ink.under)
      draw.drawImage(
        ink.under.canvas,
        ink.under.x,
        ink.under.y,
        ink.under.canvas.width / ink.scale,
        ink.under.canvas.height / ink.scale,
      );
    draw.globalCompositeOperation = 'source-over';
    // Then the words, as far as they are written, taking the place of what lies under them.
    head.steps.forEach((_, j) => {
      const lines = marks[j]?.lines;
      if (!lines || j > head.at || (j === head.at && raw <= 0)) return;
      const share = j < head.at ? 1 : Math.min(1, raw);
      for (const { x, y, width: wide, height: tall, from, to } of lines) {
        if (share <= from) break;
        const wrote = wide * Math.min(1, (share - from) / (to - from || 1));
        draw.clearRect(x - 2, y, wrote + 2, tall);
        draw.drawImage(
          ink.canvas,
          (x - 2 - ink.x) * ink.scale,
          (y - ink.y) * ink.scale,
          (wrote + 2) * ink.scale,
          tall * ink.scale,
          x - 2,
          y,
          wrote + 2,
          tall,
        );
        if (j === head.at) tip = [x + wrote, y + tall * 0.8];
      }
    });
    blit(mask, ink);
    // Lifted, the pen travels to where it next comes down.
    const mark = marks[head.at];
    const first = mark?.lines?.[0];
    const start = mark?.path?.[0] ?? (first ? ([first.x, first.y] as Point) : undefined);
    if (raw > 0) this.tip = tip;
    else if (start && this.tip) {
      const went = eased(Math.min(1, this.spent / (step.rest || 1)));
      tip = [
        this.tip[0] + (start[0] - this.tip[0]) * went,
        this.tip[1] + (start[1] - this.tip[1]) * went,
      ];
    } else tip = start;
    if (tip) this.pen?.(tip);
  }
}

/**
 * Shapes ready for a scene, at the versions Board holds. Where fractional indices clash (two people
 * adding at once, or a shape put where a deleted one stands), Excalidraw ranks them again and counts
 * that a new version, which the page would save as if someone had changed them. Every page ranks a
 * clash alike, so here it stays on the page, as it does when merging below.
 */
export const restored = (shapes: readonly BoardElement[], repairBindings: boolean) => {
  // Given a shape twice, as what was waiting can be, the last is the newest: Excalidraw would take
  // the other for a new shape.
  const as = new Map(shapes.map((el) => [el.id, el]));
  const out = restoreElements(stacked([...as.values()]) as never, null, {
    refreshDimensions: true,
    repairBindings,
  });
  for (const el of out) {
    const { version, versionNonce } = as.get(el.id)!;
    Object.assign(el, { version, versionNonce });
  }
  return out;
};

/** A stage on an Excalidraw canvas: `landing` hears what lands just before it does. */
export const stageOf = (
  api: ExcalidrawImperativeAPI,
  held: () => boolean,
  landing?: (shapes: BoardElement[]) => void,
  bringAhead = imageBringer(api),
): Stage => ({
  held,
  camera: () => api.getAppState(),
  standing: () => new Set(api.getSceneElements().map((el) => el.id)),
  files(shapes) {
    bringAhead(shapes as never, api.getFiles());
    return api.getFiles();
  },
  show(shapes, settled) {
    landing?.(shapes);
    // Never repair bindings on these alone: they are only the shapes that changed, and a box whose
    // text did not change would lose it. Nor while more is to land: a box already names an arrow
    // that is on its way, and would forget it.
    const held = api.getSceneElementsIncludingDeleted();
    const remote = restored(shapes, false) as unknown as RemoteExcalidrawElement[];
    const versions = new Map(
      [...held, ...remote].map((el) => [
        el as object,
        { version: el.version, versionNonce: el.versionNonce },
      ]),
    );
    const merged = reconcileElements(held, remote, api.getAppState());
    for (const el of merged) Object.assign(el, versions.get(el));
    api.updateScene({
      // All of a large board need not be gone over for each shape, only at the last.
      elements: settled
        ? restoreElements(merged, null, { refreshDimensions: true, repairBindings: true })
        : merged,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  },
});

/** What Excalidraw's own controls leave of a canvas: its toolbar above and its footer below. */
const [TOP, BOTTOM, SIDE] = [72, 60, 16];
/**
 * The part of the canvas that shows the board, in its pixels: clear of Excalidraw's controls, and
 * on whichever side of the Agent's window has the most room.
 */
export const clearView = (api: ExcalidrawImperativeAPI): Rect => {
  const { width, height, offsetLeft, offsetTop } = api.getAppState();
  const x = Math.min(SIDE, width / 4);
  const y = Math.min(TOP, height / 4);
  const free = { x, y, width: width - 2 * x, height: height - y - Math.min(BOTTOM, height / 4) };
  const dock = document.querySelector('.pi-dock')?.getBoundingClientRect();
  if (!dock) return free;
  const [left, top] = [dock.left - offsetLeft, dock.top - offsetTop];
  const [right, bottom] = [left + dock.width, top + dock.height];
  const [endX, endY] = [free.x + free.width, free.y + free.height];
  return [
    { ...free, width: Math.min(free.width, left - x) },
    { ...free, x: Math.max(x, right), width: Math.min(free.width, endX - right) },
    { ...free, height: Math.min(free.height, top - y) },
    { ...free, y: Math.max(y, bottom), height: Math.min(free.height, endY - bottom) },
  ].reduce((best, side) =>
    side.width * side.height > best.width * best.height && side.width > 0 && side.height > 0
      ? side
      : best,
  );
};

/** How long a change of view takes to dissolve. */
const DISSOLVE_MS = 220;
/**
 * The view about to change with no travel: what these canvases show now stays over them and fades.
 * Nothing slides, and opacity is not motion to the inner ear. Asked for less motion, it is a plain cut.
 */
export const dissolve = (root: Element | null | undefined) => {
  const from = root?.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static');
  if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const held = from.cloneNode() as HTMLCanvasElement;
  held.getContext('2d')?.drawImage(from, 0, 0);
  from.after(held);
  held.animate({ opacity: [1, 0] }, { duration: DISSOLVE_MS, easing: 'ease-out' }).onfinish = () =>
    held.remove();
};

/** Puts these in the middle of the clear view, zoomed out as far as that takes and in only to `most`. */
export const fitView = (
  api: ExcalidrawImperativeAPI,
  shapes: readonly OrderedExcalidrawElement[],
  most = 1,
) => {
  if (!shapes.length) return;
  const [x1, y1, x2, y2] = getCommonBounds(shapes);
  const { x, y, width, height } = clearView(api);
  const fit = Math.min(width / (x2 - x1 || 1), height / (y2 - y1 || 1)) * (most > 1 ? 0.8 : 0.9);
  const zoom = Math.max(0.1, Math.min(most, fit));
  api.updateScene({
    appState: {
      zoom: { value: zoom as never },
      scrollX: (x + width / 2) / zoom - (x1 + x2) / 2,
      scrollY: (y + height / 2) / zoom - (y1 + y2) / 2,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

/** The file a shape shows, if it is an image with its file chosen. */
export const fileOf = (el: OrderedExcalidrawElement) => (el.type === 'image' ? el.fileId : null);
export const imageAt = (fileId: string) => `/board-images/${encodeURIComponent(fileId)}`;
/**
 * Brings in an image on the board that this page has not got, once each: its shape shows a
 * placeholder until it comes.
 */
export const imageBringer = (api: ExcalidrawImperativeAPI, brought?: (fileId: FileId) => void) => {
  const asked = new Set<string>();
  return (elements: readonly OrderedExcalidrawElement[], held: BinaryFiles) => {
    for (const el of elements) {
      const fileId = el.isDeleted ? null : fileOf(el);
      if (!fileId || held[fileId] || asked.has(fileId)) continue;
      asked.add(fileId);
      accountRequest<Blob>(imageAt(fileId), { scoped: true, bytes: true })
        .then(async (blob) => {
          const dataURL = await getDataURL(blob);
          brought?.(fileId);
          api.addFiles([
            { id: fileId, mimeType: blob.type as never, dataURL, created: Date.now() },
          ]);
        })
        // Refused or gone, it stays a placeholder; anything else is asked again at the next change.
        .catch((error: ApiError) => [403, 404].includes(error.status) || asked.delete(fileId));
    }
  };
};
