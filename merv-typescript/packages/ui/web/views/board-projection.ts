/**
 * The second Excalidraw's side of a board's replay (board-replay.tsx): its clock, what stands at
 * that point, and each frame's work. The clock is the master, and hands the player one unit as it
 * reaches it, to trace in the time the timeline gave it. The camera is the board's own, which this
 * moves only while nobody else does, and never by travelling: all of a chunk of work is framed before
 * its first stroke, so the ink moves and the view does not. The view changes in one dissolve, with
 * the pen lifted, when what comes next would be out of it; never under a hand on the scrubber.
 */
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw';
import type {
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types';
import type { BoardChange, BoardElement } from '@merv/board/models';
import type { BoardFilm } from './board-film';
import { framing, zoomToFit, type Rect } from './board-place';
import { clearView, dissolve, imageBringer, Player, restored, type Stage } from './board-player';
import {
  landedBy,
  openingOf,
  timelineOf,
  toneOf,
  widened,
  type Reach,
  type Timeline,
  type Unit,
} from './board-timeline';

/** How long the tape runs back before it plays, and how long it then stays, showing how it stood. */
const [REWIND_MS, OPENING_MS] = [650, 450];
/** How long the clock waits for the eye after the view changed. */
const SETTLE_MS = 350;
/**
 * How far out it holds a stretch of work together before splitting it, and the nearest it goes, on a
 * view this wide or wider. A phone holds as much of the board, or it would change view every few
 * seconds and swing in on each small stroke.
 */
const [LEAST_ZOOM, WIDE_VIEW, NEAREST_NARROW] = [0.3, 1000, 0.4];
/** Past this many shapes standing, what is drawn is only scaled while a hand moves the camera. */
const SCALED_ABOVE = 200;
/** How many of what it told the board's camera it remembers, while that takes them up. */
const TOLD_KEPT = 8;
/** A unit too short to trace at this speed just lands, and how many may be in the pen at once. */
const LEAST_TRACE_MS = 40;
const MOST_IN_HAND = 2;
/** How many frames what took over stays on screen untouched before anything moves. */
const SHOW_FRAMES = 3;
/** How often to see whether others have drawn more while this plays. */
const LOOK_MS = 1500;
const READING_DIALOGS = ['help', 'imageExport'];
/** How long a name stays with the pen after its last mark, and how fast it slides there. */
const [TAG_MS, TAG_SLIDE] = [900, 0.3];
/** Excalidraw colours a cursor by a hash of this id alone; these come out peach, blue, teal, amber. */
const PERSON_TAG = 'hand22';
const AGENT_TAGS = ['hand51', 'hand55', 'hand20'];
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export type Shape = ReturnType<typeof restoreElements>[number];
interface Camera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}
const cameraOf = (api: ExcalidrawImperativeAPI): Camera => {
  const { scrollX, scrollY, zoom } = api.getAppState();
  return { scrollX, scrollY, zoom: zoom.value };
};
const sameCamera = (a: Camera, b: Camera) =>
  a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom;
const asState = ({ scrollX, scrollY, zoom }: Camera) => ({
  scrollX,
  scrollY,
  zoom: { value: zoom as never },
});

const rectOf = ([x, y, right, bottom]: Reach): Rect => ({
  x,
  y,
  width: right - x,
  height: bottom - y,
});
/** A version of a shape as the scene holds it, measured as the board measures it. */
export const restoreOne = (raw: BoardElement, holder?: BoardElement): Shape | undefined =>
  raw.type === 'text'
    ? restored(holder ? [raw, holder] : [raw], true).find((el) => el.id === raw.id)
    : restored([raw], false)[0];
/** Every picture any version of any shape has shown, for bringing in: erased ones replay too. */
export const picturesOf = (changes: readonly BoardChange[]) =>
  changes.flatMap(({ shapes }) => shapes.filter((el) => el.type === 'image' && !el.isDeleted));

interface Hooks {
  place(at: number): void;
  changed(): void;
  /** The clock reached now. */
  ended(): void;
  nameOf(hand: number): string;
  /** What else has been drawn since this began, if anything. */
  more(): Promise<BoardChange[] | null>;
  /** How many pixels the scrubber takes off the bottom of the view. */
  below(): number;
  /** A person reached for something that would change the board. */
  refused(): void;
}

export class Projection {
  at: number;
  playing = false;
  speed = 1;
  private rewinding = 0;
  /** The frames left before it starts back, for the moment it took over to be on screen untouched. */
  private waiting = 0;
  private starting = false;
  private next = 0;
  private landing = 0;
  private frame = 0;
  private last = 0;
  private lookedAt = 0;
  private looking = false;
  private player: Player;
  /** The camera as this last left the board's, and as the second Excalidraw last showed it. */
  private set: Camera;
  private shown: Camera;
  /** What the board's camera was lately told, which it takes a moment to take up. */
  private told: Camera[];
  private moved = false;
  private background = '';
  /** Whether the person moved the camera themselves, which it then leaves to them. */
  private touched = false;
  /** Whether the board is itself again, whose camera this now only follows. */
  private resting = false;
  /** While a hand drags through it, the view stays. */
  private dragged = false;
  /** The units before this are in the view as it was framed; and the clock waits until `still`. */
  private framedTo = 0;
  private still = 0;
  private entered: Camera;
  private tag?: {
    x: number;
    y: number;
    toX: number;
    toY: number;
    id: string;
    name: string;
    until: number;
  };
  private tagShown = '';
  private bring: ReturnType<typeof imageBringer>;
  constructor(
    private live: ExcalidrawImperativeAPI,
    private screen: ExcalidrawImperativeAPI,
    private canvas: HTMLCanvasElement,
    public line: Timeline,
    public film: BoardFilm<Shape>,
    private pictures: BoardElement[],
    private hooks: Hooks,
  ) {
    this.bring = imageBringer(screen);
    this.at = line.length;
    this.set = this.shown = this.entered = cameraOf(live);
    this.told = [this.set];
    const stage: Stage = {
      held: () => !this.playing,
      camera: () => screen.getAppState(),
      // A copy: the player counts in what is on its way.
      standing: () => new Set(this.film.standing),
      files: (shapes) => {
        this.bring(shapes as never, screen.getFiles());
        return screen.getFiles();
      },
      show: (shapes) => {
        this.landing += shapes.length;
        const { units } = this.line;
        let at = this.film.at;
        while (at < units.length && this.landing >= units[at]!.shapes.length)
          this.landing -= units[at++]!.shapes.length;
        this.film.seek(at);
        this.paint();
      },
    };
    this.player = new Player(stage, canvas, Infinity, line.rate);
    this.player.pen = (tip) => {
      if (tip && this.tag) [this.tag.toX, this.tag.toY] = tip;
    };
  }
  /** What the second Excalidraw shows to begin with: what the board shows, to the pixel. */
  match(files: BinaryFiles) {
    this.film.seek(this.line.units.length);
    this.screen.addFiles(Object.values(files));
    const shapes = this.live
      .getSceneElements()
      .map((el) => this.film.held(el.id, el.version, el.versionNonce) ?? structuredClone(el));
    this.screen.updateScene({
      elements: shapes as never,
      appState: this.state(),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.images(this.pictures);
  }
  private images(pictures: BoardElement[]) {
    this.bring(pictures as never, this.screen.getFiles());
  }
  private state() {
    const { viewBackgroundColor, gridModeEnabled, gridSize, gridStep } = this.live.getAppState();
    this.background = viewBackgroundColor;
    return {
      viewBackgroundColor,
      gridModeEnabled,
      gridSize,
      gridStep,
      ...asState(cameraOf(this.live)),
    };
  }
  /** Whether the tape is moving, either way. */
  get moving() {
    return this.playing || this.waiting > 0 || this.rewinding > 0;
  }
  run() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.player.stop();
  }
  private paint() {
    this.screen.updateScene({
      elements: this.film.scene() as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
  /** Runs back to where it opens, and plays. */
  rewind() {
    this.player.stop();
    this.landing = 0;
    this.playing = false;
    if (calm()) this.open();
    else {
      this.waiting = SHOW_FRAMES;
      this.starting = true;
    }
    this.hooks.changed();
  }
  /** The board as it stood just before the last chunk of work, framed for it, and then it plays. */
  private open() {
    this.seek(openingOf(this.line));
    this.frameFrom(this.next);
    this.still = performance.now() + OPENING_MS;
    this.play();
  }
  private setCamera(camera: Camera) {
    this.set = camera;
    this.told = [...this.told.slice(-TOLD_KEPT), camera];
    this.live.updateScene({
      appState: asState(camera),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
  play() {
    if (this.at >= this.line.length) return this.rewind();
    this.playing = true;
    this.hooks.changed();
    this.run();
  }
  pause() {
    this.playing = false;
    this.rewinding = this.waiting = 0;
    this.starting = false;
    this.hooks.changed();
  }
  setSpeed(speed: number) {
    this.speed = speed;
    this.player.rate = speed * this.line.rate;
    this.hooks.changed();
  }
  /** The playhead goes here, and the board with it, at once. */
  seek(at: number) {
    this.at = Math.max(0, Math.min(this.line.length, at));
    this.player.stop();
    this.landing = 0;
    this.film.seek(landedBy(this.line, this.at));
    this.next = this.film.at;
    this.paint();
    this.hooks.place(this.at);
    this.framedTo = 0;
  }
  grab() {
    this.pause();
    this.dragged = true;
    this.hooks.changed();
  }
  drop() {
    this.dragged = false;
    this.settle();
  }
  /** The playhead has stopped somewhere: the view comes to what is there, if it is not in it. */
  settle() {
    this.frameFrom(Math.max(0, Math.min(this.next, this.line.units.length) - 1));
  }
  /** Steps through history by its own steps: its changes as they came. */
  step(by: number) {
    const { steps, length, units } = this.line;
    // From what the board shows, and not a stroke still in the pen.
    const shown = units[this.film.at - 1]?.start ?? -1;
    const to = steps.filter((start) => start <= shown).length - 1 + by;
    this.pause();
    this.seek(to < 0 ? 0 : to >= steps.length ? length : steps[to]! + 0.5);
    this.settle();
  }
  /** It is over: the board is itself again under this as it fades, its camera as it was unless moved. */
  rest() {
    this.playing = false;
    this.rewinding = this.waiting = 0;
    this.starting = false;
    this.dragged = false;
    this.resting = true;
    this.player.stop();
    this.tag = undefined;
    this.showTag();
    if (!this.touched) this.setCamera(this.entered);
    this.hooks.changed();
  }
  /** The person's hand went to the camera: nothing of this may be told over it. */
  handOn() {
    this.touched = true;
  }
  /** Picked up again after it ended. */
  again() {
    this.entered = this.set = cameraOf(this.live);
    this.told = [this.set];
    this.touched = this.resting = false;
    this.steer();
  }
  /** Others drew more: it goes on the end, and the playhead stays with what it was showing. */
  private longer(changes: BoardChange[]) {
    const line = timelineOf(changes);
    const [had, has] = [this.line.units[this.next - 1], line.units[this.next - 1]];
    this.at =
      had && has && this.at < this.line.length
        ? has.start + (this.at - had.start) * (has.ms / (had.ms || 1))
        : this.at * (line.length / (this.line.length || 1));
    this.line = line;
    this.player.rate = this.speed * line.rate;
    this.film = this.film.longer(line);
    this.images(picturesOf(changes));
    this.hooks.place(this.at);
    this.hooks.changed();
  }
  private feed() {
    const { units, length } = this.line;
    // However many land in a frame, it is painted once.
    let painting = false;
    while (this.next < units.length && units[this.next]!.start <= this.at) {
      if (this.next >= this.framedTo && this.frameFrom(this.next)) break;
      const unit = units[this.next++]!;
      const fit = unit.ms / this.speed;
      if (fit < LEAST_TRACE_MS) {
        this.player.finish();
        this.landing = 0;
        this.film.seek(this.next);
        painting = true;
      } else {
        // The clock is the master: what the pen has not got through by now lands as it is.
        if (this.player.waiting > MOST_IN_HAND) this.player.finish();
        this.tagOf(unit);
        this.player.add(unit.shapes);
      }
    }
    if (this.at >= length && this.next >= units.length) {
      this.player.finish();
      this.landing = 0;
      this.film.seek(units.length);
      this.paint();
      this.playing = false;
      this.hooks.ended();
    } else if (painting) this.paint();
  }
  /** The name of who is drawing goes with the pen. */
  private tagOf({ hand, shapes, ms }: Unit) {
    if (calm()) return;
    const tone = toneOf(this.line.hands, hand);
    const id = this.line.hands[hand]?.person ? PERSON_TAG : AGENT_TAGS[tone]!;
    const first = shapes[0]!;
    const toX = Number(first.x) + Number(first.width ?? 0) / 2;
    const toY = Number(first.y) + Number(first.height ?? 0) / 2;
    const held = this.tag?.id === id ? this.tag : undefined;
    this.tag = {
      id,
      name: this.hooks.nameOf(hand),
      toX,
      toY,
      x: held?.x ?? toX,
      y: held?.y ?? toY,
      until: performance.now() + TAG_MS + ms / this.speed,
    };
  }
  private showTag(now = performance.now()) {
    if (this.tag && (now > this.tag.until || !this.moving)) this.tag = undefined;
    const tag = this.tag;
    if (tag) {
      tag.x += (tag.toX - tag.x) * TAG_SLIDE;
      tag.y += (tag.toY - tag.y) * TAG_SLIDE;
    }
    const said = tag ? `${Math.round(tag.x)},${Math.round(tag.y)},${tag.name}` : '';
    if (said === this.tagShown) return;
    this.tagShown = said;
    const who = new Map<SocketId, Collaborator>();
    if (tag)
      who.set(tag.id as SocketId, {
        id: tag.id,
        username: tag.name,
        button: 'up',
        pointer: { x: tag.x, y: tag.y, tool: 'pointer' },
      });
    this.screen.updateScene({ collaborators: who, captureUpdate: CaptureUpdateAction.NEVER });
  }
  private tick = (now: number) => {
    const played = Math.min(100, now - this.last);
    this.last = now;
    this.frame = requestAnimationFrame(this.tick);
    if (this.waiting && --this.waiting) return;
    if (this.starting) {
      this.starting = false;
      this.rewinding = now;
    }
    if (!this.resting) this.closeDialogs();
    this.steer();
    if (this.rewinding) {
      const share = Math.min(1, (now - this.rewinding) / REWIND_MS);
      const opening = openingOf(this.line);
      this.at = opening + (this.line.length - opening) * (1 - ease(share));
      this.film.seek(landedBy(this.line, this.at));
      this.paint();
      if (share >= 1) {
        this.rewinding = 0;
        this.open();
      }
      this.hooks.place(this.at);
    } else if (this.playing && now >= this.still) {
      this.at += played * this.speed;
      this.feed();
      this.hooks.place(this.at);
    }
    this.showTag(now);
    if (now - this.lookedAt > LOOK_MS && !this.looking && !this.resting) {
      this.lookedAt = now;
      this.looking = true;
      void this.hooks
        .more()
        .then((more) => more && this.frame && this.longer(more))
        .finally(() => (this.looking = false));
    }
  };
  /**
   * Excalidraw opens some dialogs from anywhere, ahead of any guard, and some change the scene: what
   * does here does not stay. Help and saving as an image only read; the second one takes nothing.
   */
  private closeDialogs() {
    for (const [api, read] of [
      [this.live, READING_DIALOGS],
      [this.screen, []],
    ] as const) {
      const { openDialog } = api.getAppState();
      if (!openDialog || (read as readonly string[]).includes(openDialog.name)) continue;
      api.updateScene({ appState: { openDialog: null }, captureUpdate: CaptureUpdateAction.NEVER });
      if (api === this.live) this.hooks.refused();
    }
  }
  /**
   * Frames the work from this unit to the end of its chunk, or as much of it as reads held together,
   * and says whether the view had to change for it. Only the pen is lifted when it does.
   */
  private frameFrom(from: number) {
    const { units, chunks } = this.line;
    const first = units[from];
    if (!first || this.touched || this.resting || this.dragged) return false;
    const clear = clearView(this.live);
    clear.height -= this.hooks.below();
    const end = chunks.find((chunk) => from >= chunk.first && from < chunk.end)?.end ?? from + 1;
    const wide = Math.min(1, clear.width / WIDE_VIEW);
    const least = Math.max(0.1, LEAST_ZOOM * wide);
    let reach = first.reach;
    let to = from + 1;
    for (; to < end; to++) {
      const wider = widened(reach, units[to]!.reach);
      if (zoomToFit(rectOf(wider), clear) < least) break;
      reach = wider;
    }
    this.framedTo = to;
    const now = cameraOf(this.live);
    const camera = framing(rectOf(reach), clear, now, Math.max(NEAREST_NARROW, wide));
    if (sameCamera(camera, now)) return false;
    this.player.finish();
    this.landing = 0;
    this.film.seek(this.next);
    this.paint();
    dissolve(this.canvas.parentElement);
    this.setCamera(camera);
    this.steer();
    this.still = performance.now() + SETTLE_MS;
    return true;
  }
  /** The camera, each frame: the person's if they took it; or else as set, this one held as it fades. */
  private steer() {
    const live = cameraOf(this.live);
    if (!this.told.some((camera) => sameCamera(camera, live))) {
      // Not moved from here: the person's hand is on it.
      this.touched = true;
      this.set = live;
      this.told = [live];
    }
    const next = this.touched ? live : this.resting ? this.shown : this.set;
    const moved = !sameCamera(next, this.shown);
    const background = this.live.getAppState().viewBackgroundColor;
    if (moved || this.moved || background !== this.background) {
      this.moved = moved;
      this.shown = next;
      this.background = background;
      const { gridModeEnabled, gridSize, gridStep } = this.live.getAppState();
      this.screen.updateScene({
        appState: {
          ...asState(next),
          // Moving, a full board's shapes are only scaled, and drawn again sharp when it stops.
          shouldCacheIgnoreZoom: moved && this.film.standing.size > SCALED_ABOVE,
          viewBackgroundColor: background,
          gridModeEnabled,
          gridSize,
          gridStep,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }
}
