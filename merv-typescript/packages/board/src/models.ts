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
