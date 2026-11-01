import type { Json } from '@merv/contracts/data';

/** The most bytes one image holds. */
export const MOST_IMAGE_BYTES = 10 * 1024 * 1024;

/** One whiteboard of a project, without what is drawn on it. */
export interface BoardSummary {
  id: string;
  projectId: string;
  title: string;
  /** Counts every save that changed a shape; a page asks for what changed after the one it has. */
  revision: number;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * One Excalidraw shape, as Excalidraw writes it. Board reads only what it merges and places by;
 * the rest is the drawing's own and is kept as it came.
 */
export interface BoardElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  [field: string]: Json | undefined;
}

/** One way an outcome left the board: the file frozen from it at a revision of it. */
export interface OutcomeSent {
  at: string;
  how: 'claude' | 'copy' | 'fleet';
  artifactId: string;
  revision: number;
  /** The task a send to Fleet became, once one names the file (`@merv/board/links`). */
  taskId?: string;
}

/** An outcome without its text: what the page polls and what board.read lists. */
export interface OutcomeLine {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sent: OutcomeSent[];
}

/**
 * What a board led to: a titled Markdown draft that a person and their agent edit side by side.
 * Saving is implicit, so it has no history of its own; each send freezes a file, and those are it.
 */
export interface Outcome extends OutcomeLine {
  text: string;
  createdBy: string;
  updatedBy: string;
  /** The agent that last wrote it, as a page names it; none when a person did. */
  writer?: string;
}

export interface BoardScene {
  board: BoardSummary;
  outcomes: OutcomeLine[];
  /** Every live shape, or with `since` every shape changed after that revision, deleted ones too. */
  elements: BoardElement[];
  /** A shape deleted after `since` was purged (30 days on): `elements` is every live shape. */
  whole?: true;
  /** Where agents were on this board in the last moments, for the page to show. */
  looking?: BoardLooking[];
}

/** Where an agent last looked or drew on a board. It is no record: nothing keeps it. */
export interface BoardLooking {
  actor: string;
  name: string;
  region: { x: number; y: number; width: number; height: number };
  at: number;
  /** It drew there, so a stroke being traced there is its own. */
  drew?: true;
  /** The sentence its last draw came with, which the page shows while the pen goes. */
  saying?: string;
}

/**
 * One step of a board's history: the shapes as they became, in the order they came. `draw` is one
 * agent's call; `save` is one person's saves within moments of each other; `before`, on a board
 * older than history, is the board as it stood when history began.
 */
export interface BoardChange {
  /** The board's revision once this step was done. */
  revision: number;
  actorId: string;
  at: string;
  kind: 'before' | 'draw' | 'save';
  shapes: BoardElement[];
}

export interface BoardHistory {
  /** The next steps after the revision asked for, oldest first. */
  changes: BoardChange[];
  /** Every step the board has. */
  total: number;
  /** Ask again after this revision for more. */
  next?: number;
}

/**
 * Shapes in the order they stack, by Excalidraw's fractional index (compared as plain strings, as
 * it compares them, and on a tie by id, so every page ranks a clash alike); a shape without one
 * stands on top. Excalidraw takes the order it is handed
 * as the stacking order and re-ranks whatever is out of it, so a page is always handed this one.
 */
export const stacked = <T extends object>(elements: readonly T[]): T[] =>
  [...elements].sort((a, b) => {
    const [x, y] = [a, b]
      .map((el) => (el as { index?: unknown }).index)
      .map((i) => (typeof i === 'string' ? i : '\uffff'));
    const [p, q] = [a, b].map((el) => String((el as { id?: unknown }).id));
    return x! < y! ? -1 : x! > y! ? 1 : p! < q! ? -1 : p! > q! ? 1 : 0;
  });

/** The board once these steps of its history are done: every shape as the last of them left it. */
export const boardAt = (changes: readonly BoardChange[]): BoardElement[] => {
  const shapes = new Map(changes.flatMap((change) => change.shapes.map((el) => [el.id, el])));
  return stacked([...shapes.values()].filter((el) => !el.isDeleted));
};

/**
 * How long a pen takes, read by the page that traces shapes and by Board, which holds an agent's
 * answer for as long while a person watches: one set of numbers, so neither runs ahead of the other.
 * A longer stroke goes faster, as a hand does: a 100-unit tick takes 240 ms, a 600-unit box 700 ms.
 */
export const PEN = {
  /** A stroke's milliseconds: `stroke` times its length to the power of `reach`, within these. */
  stroke: 15,
  reach: 0.6,
  least: 140,
  most: 1600,
  /** Writing, per character and within these: about 18 characters a second. */
  char: 55,
  leastText: 220,
  mostText: 3000,
  /** Colouring a shape in after its outline, an arrow's head, and bringing up an image. */
  fill: 200,
  head: 110,
  image: 450,
  /** The last of a stroke that settles what the outline left, however rough its edge. */
  settle: 40,
  /** A change to a shape already there. */
  edit: 30,
  /** The pen lifting between shapes, between the parts of one, and a unit of distance on the way. */
  rest: 160,
  lift: 50,
  /** Done with one thing, the beat before the next, and how far apart two things are at the least. */
  pause: 700,
  apart: 60,
  travel: 0.25,
  mostTravel: 200,
  /** A card's parts are quick: it is one thing, not a drawing. */
  card: 0.45,
} as const;

/** One thing the pen does: `rest` to reach it, `ms` to draw it, the last `flood` colouring it in. */
export interface PenStep {
  shape: BoardElement;
  rest: number;
  ms: number;
  flood: number;
}
/** What lands together, a shape with its label or a card with its parts, and how it is drawn. */
export interface PenUnit {
  shapes: BoardElement[];
  steps: PenStep[];
  /** How long it takes when it has nothing to draw, being only changes to what is there. */
  ms: number;
}

const between = (least: number, most: number, value: number) =>
  Math.min(most, Math.max(least, value));
const strokeLength = ({ type, width, height, points }: BoardElement) => {
  if (Array.isArray(points))
    return (points as [number, number][]).reduce(
      (sum, [x, y], i, all) => (i ? sum + Math.hypot(x - all[i - 1]![0], y - all[i - 1]![1]) : 0),
      0,
    );
  if (type === 'ellipse') return (Math.PI * (width + height)) / 2;
  return type === 'diamond' ? 2 * Math.hypot(width, height) : 2 * (width + height);
};
/** What of `shape` is coloured in after its outline, in milliseconds. */
const floodOf = (shape: BoardElement) =>
  shape.type === 'arrow'
    ? PEN.head
    : shape.backgroundColor && shape.backgroundColor !== 'transparent'
      ? PEN.fill
      : PEN.settle;
const middle = ({ x, y, width, height }: BoardElement) => [x + width / 2, y + height / 2] as const;
/** How far apart two shapes' boxes are, or 0 where they touch. */
const gapOf = (a: BoardElement, b: BoardElement) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)),
    Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)),
  );
const partOfCard = (shape: BoardElement) => {
  const data = shape.customData as { card?: unknown; target?: unknown } | undefined;
  return !!data?.card || data?.target !== undefined;
};

/** The units `shapes` make, in order; what `standing` already holds is only changed, not drawn. */
export const penUnits = (
  shapes: readonly BoardElement[],
  standing: (id: string) => boolean,
): PenUnit[] => {
  const given = new Set(shapes.map((shape) => shape.id));
  const units = new Map<string, BoardElement[]>();
  for (const shape of shapes) {
    const container = shape.containerId;
    const group = (shape.groupIds as string[] | undefined)?.[0];
    const key =
      typeof container === 'string' && given.has(container)
        ? container
        : partOfCard(shape) && group
          ? group
          : shape.id;
    units.set(key, [...(units.get(key) ?? []), shape]);
  }
  let last: BoardElement | undefined;
  return [...units.values()].map((unit) => {
    // The outline before what it holds, which words on it are written over.
    const fresh = unit
      .filter((shape) => !shape.isDeleted && !standing(shape.id))
      .sort((a, b) => Number(a.type === 'text') - Number(b.type === 'text'));
    const steps = fresh.map((shape, i): PenStep => {
      const quick = partOfCard(shape) ? PEN.card : 1;
      const flood = shape.type === 'text' || shape.type === 'image' ? 0 : floodOf(shape);
      const drawn =
        shape.type === 'text'
          ? between(PEN.leastText, PEN.mostText, PEN.char * String(shape.text ?? '').length)
          : shape.type === 'image'
            ? PEN.image
            : between(PEN.least, PEN.most, PEN.stroke * strokeLength(shape) ** PEN.reach);
      // A stroke of the same sketch is the same drawing: the pen hardly leaves it.
      const sketch = (shape.customData as { sketch?: unknown } | undefined)?.sketch;
      const same = !!sketch && (last?.customData as { sketch?: unknown })?.sketch === sketch;
      const [fromX, fromY] = last ? middle(last) : middle(shape);
      const [toX, toY] = middle(shape);
      const rest =
        i || same
          ? PEN.lift
          : !last
            ? 0
            : (gapOf(last, shape) > PEN.apart ? PEN.pause : PEN.rest) +
              Math.min(PEN.mostTravel, Math.hypot(toX - fromX, toY - fromY) * PEN.travel);
      last = shape;
      return { shape, rest, ms: (drawn + flood) * quick, flood: flood * quick };
    });
    return { shapes: unit, steps, ms: steps.length ? 0 : PEN.edit };
  });
};
/** How long these units take to draw, played at the pace of a hand. */
export const penMs = (units: readonly PenUnit[]) =>
  units.reduce(
    (sum, { steps, ms }) => steps.reduce((all, step) => all + step.rest + step.ms, sum + ms),
    0,
  );
