import type { Json } from '@merv/contracts/data';

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
}

/**
 * Shapes in the order they stack, by Excalidraw's fractional index (compared as plain strings, as
 * it compares them); a shape without one stands on top. Excalidraw takes the order it is handed
 * as the stacking order and re-ranks whatever is out of it, so a page is always handed this one.
 */
export const stacked = <T extends object>(elements: readonly T[]): T[] =>
  [...elements].sort((a, b) => {
    const [x, y] = [a, b]
      .map((el) => (el as { index?: unknown }).index)
      .map((i) => (typeof i === 'string' ? i : '\uffff'));
    return x! < y! ? -1 : x! > y! ? 1 : 0;
  });
