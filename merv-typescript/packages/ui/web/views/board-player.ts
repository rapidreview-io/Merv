/**
 * The player of a board's changes, the same for watching and for replay: it is given shapes in the
 * order they came and lands them on a canvas one after another, tracing each new stroke like a pen
 * first. Watching, it keeps up with the newest changes; replaying, it is fed history from the start.
 * What it has not landed is in no scene: the stroke being traced is drawn on a canvas of its own
 * above Excalidraw, which nothing can touch, so nothing animated can be saved, change a shape's
 * version or enter undo.
 */
import {
  CaptureUpdateAction,
  getCommonBounds,
  getDataURL,
  getFreeDrawSvgPath,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import { stacked, type BoardElement } from '@merv/board/models';
import { accountRequest, type ApiError } from '../api';

type Point = [number, number];
type Stroke = BoardElement & { points: Point[]; strokeColor: string; strokeWidth: number };
/** What lands together, a shape with its label or a card with its parts, after `ms` of playing. */
interface Unit {
  shapes: BoardElement[];
  ms: number;
  pen?: Stroke;
}
/** How long a new shape takes, a change to one already there, and a stroke at most and at least. */
const [SHAPE_MS, EDIT_MS, LEAST_PEN_MS, MOST_PEN_MS] = [180, 30, 250, 900];
/** Board units a pen covers each millisecond. */
const PEN_PACE = 1.2;

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
const strokeOf = (shape: BoardElement) =>
  ['freedraw', 'line', 'arrow'].includes(shape.type) &&
  !shape.isDeleted &&
  Array.isArray(shape.points) &&
  shape.points.length > 1
    ? (shape as Stroke)
    : undefined;

const partOfCard = (shape: BoardElement) =>
  !!(shape.customData as { card?: boolean } | undefined)?.card;

/** The canvas the player lands shapes on. */
export interface Stage {
  /** Lands shapes in the scene; `settled` when nothing else is waiting to. */
  show(shapes: BoardElement[], settled: boolean): void;
  /** The shapes the scene shows now. */
  standing(): Set<string>;
  camera(): { scrollX: number; scrollY: number; zoom: { value: number } };
  /** While so, the player waits. */
  held(): boolean;
}

export class Player {
  private queue: Unit[] = [];
  /** How far the first of the queue has played, and how long all of it has left. */
  private spent = 0;
  private left = 0;
  private speed = 1;
  private frame = 0;
  private last = 0;
  /** Lands all it is given at once. */
  instant = false;
  /** Called once all it was given has landed. */
  idle?: () => void;
  /** Hears where the pen's tip is on the board as it traces a stroke, and null when none is. */
  pen?: (tip: Point | null) => void;
  /**
   * @param behind The most it stays behind, in milliseconds: given more than that to play, it speeds up.
   * @param rate How fast it plays at the least.
   */
  constructor(
    readonly stage: Stage,
    private canvas: HTMLCanvasElement,
    private behind: number,
    private rate = 1,
  ) {}
  get busy() {
    return this.queue.length > 0;
  }
  add(shapes: BoardElement[]) {
    if (!shapes.length) return;
    if (this.instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.finish();
      this.stage.show(shapes, true);
      this.idle?.();
      return;
    }
    const given = new Set(shapes.map((shape) => shape.id));
    const units = new Map<string, BoardElement[]>();
    for (const shape of shapes) {
      const container = shape.containerId;
      const key =
        typeof container === 'string' && given.has(container)
          ? container
          : partOfCard(shape)
            ? String((shape.groupIds as string[])[0])
            : shape.id;
      units.set(key, [...(units.get(key) ?? []), shape]);
    }
    const standing = this.stage.standing();
    for (const unit of units.values()) {
      const fresh = unit.filter((shape) => !shape.isDeleted && !standing.has(shape.id));
      const pen = fresh.some(partOfCard) ? undefined : fresh.map(strokeOf).find(Boolean);
      const ms = pen
        ? Math.min(
            MOST_PEN_MS,
            Math.max(
              LEAST_PEN_MS,
              lengths(pen.points).reduce((sum, length) => sum + length, 0) / PEN_PACE,
            ),
          )
        : fresh.length
          ? SHAPE_MS
          : EDIT_MS;
      this.queue.push({ shapes: unit, ms, ...(pen && { pen }) });
      this.left += ms;
    }
    this.speed = Math.max(this.rate, this.left / this.behind);
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
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
    this.draw();
  }
  private tick = (at: number) => {
    const played = at - this.last;
    this.last = at;
    this.frame = requestAnimationFrame(this.tick);
    if (!this.stage.held()) {
      let budget = played * this.speed;
      this.left = Math.max(0, this.left - budget);
      const due: BoardElement[] = [];
      for (let head = this.queue[0]; head; head = this.queue[0]) {
        if (this.spent + budget < head.ms) {
          this.spent += budget;
          break;
        }
        budget -= head.ms - this.spent;
        this.spent = 0;
        due.push(...this.queue.shift()!.shapes);
      }
      if (due.length) this.stage.show(due, !this.queue.length);
    }
    this.draw();
    if (this.queue.length) return;
    cancelAnimationFrame(this.frame);
    this.frame = this.left = 0;
    this.idle?.();
  };
  /** The stroke in the pen as far as it has got, where the scene would draw it, or nothing. */
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
    const head = this.queue[0];
    const stroke = head?.pen;
    if (!stroke) return this.pen?.(null);
    const { scrollX, scrollY, zoom } = this.stage.camera();
    const scale = ratio * zoom.value;
    pen.setTransform(
      scale,
      0,
      0,
      scale,
      scale * (scrollX + stroke.x),
      scale * (scrollY + stroke.y),
    );
    // A turned stroke turns about the middle of all of it.
    const [xs, ys] = [stroke.points.map((p) => p[0]), stroke.points.map((p) => p[1])];
    const [cx, cy] = [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
    ];
    pen.translate(cx, cy);
    pen.rotate(Number(stroke.angle ?? 0));
    pen.translate(-cx, -cy);
    pen.globalAlpha = Number(stroke.opacity ?? 100) / 100;
    const points = penned(stroke.points, this.spent / head.ms);
    const [tipX, tipY] = points.at(-1)!;
    this.pen?.([stroke.x + tipX, stroke.y + tipY]);
    if (stroke.type === 'freedraw') {
      const pressures = (stroke.pressures as number[] | undefined)?.slice(0, points.length);
      pen.fillStyle = stroke.strokeColor;
      pen.fill(new Path2D(getFreeDrawSvgPath({ ...stroke, points, pressures } as never)));
      return;
    }
    pen.strokeStyle = stroke.strokeColor;
    pen.lineWidth = stroke.strokeWidth;
    pen.lineCap = pen.lineJoin = 'round';
    pen.beginPath();
    for (const [x, y] of points) pen.lineTo(x, y);
    pen.stroke();
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
): Stage => ({
  held,
  camera: () => api.getAppState(),
  standing: () => new Set(api.getSceneElements().map((el) => el.id)),
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
      elements: restoreElements(merged, null, { refreshDimensions: true, repairBindings: settled }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  },
});

/** Puts these in the middle of the view, zoomed out as far as that takes and in only to `most`. */
export const fitView = (
  api: ExcalidrawImperativeAPI,
  shapes: readonly OrderedExcalidrawElement[],
  most = 1,
) => {
  if (!shapes.length) return;
  const [x1, y1, x2, y2] = getCommonBounds(shapes);
  const { width, height } = api.getAppState();
  const fit = Math.min(width / (x2 - x1 || 1), height / (y2 - y1 || 1)) * (most > 1 ? 0.8 : 0.9);
  const zoom = Math.max(0.1, Math.min(most, fit));
  api.updateScene({
    appState: {
      zoom: { value: zoom as never },
      scrollX: width / (2 * zoom) - (x1 + x2) / 2,
      scrollY: height / (2 * zoom) - (y1 + y2) / 2,
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
