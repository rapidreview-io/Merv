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

export interface BoardScene {
  board: BoardSummary;
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
