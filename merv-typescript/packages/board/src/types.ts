import type { Caller } from '@merv/contracts';
import type { DrawInput } from './input.js';
import type { BoardElement, BoardHistory, BoardScene, BoardSummary } from './models.js';

export type * from './models.js';

/** What board.draw did: the board, and the id each keyed shape got. */
export interface BoardDrawn {
  board: BoardSummary;
  created: Record<string, string>;
  changed: number;
}

/** An image already stored, for an image operation: tools turn its source into this first. */
export interface PlacedImage {
  fileId: string;
  width: number;
  height: number;
}

export interface Board {
  list(caller: Caller): Promise<BoardSummary[]>;
  scene(caller: Caller, id: string, since?: number): Promise<BoardScene>;
  create(caller: Caller, title: string): Promise<BoardSummary>;
  set(
    caller: Caller,
    id: string,
    change: { title?: string; archived?: boolean },
  ): Promise<BoardSummary>;
  /** Merges shapes a page drew: each shape is kept where its version is newer than the stored one. */
  save(
    caller: Caller,
    id: string,
    elements: BoardElement[],
  ): Promise<{ board: BoardSummary; accepted: number }>;
  /** A member's page of the board's history, oldest first, after a revision. */
  history(caller: Caller, id: string, after?: number): Promise<BoardHistory>;
  /** Keeps an image's bytes under its file id in the caller's project, once: PNG, JPEG, WebP or
   *  GIF by their content, at most 10 MiB. */
  storeImage(
    caller: Caller,
    fileId: string,
    bytes: Buffer,
  ): Promise<{ fileId: string; mediaType: string; size: number }>;
  /** An image's bytes, to a member of the project that stored them. */
  image(caller: Caller, fileId: string): Promise<{ mediaType: string; content: Buffer }>;
  /** Draws an agent's operations (input.ts), placed by Board, on one board or a new one;
   *  `images` holds what each image operation places, in order. */
  draw(caller: Caller, input: DrawInput, images?: PlacedImage[]): Promise<BoardDrawn>;
}

declare module 'cordis' {
  interface Context {
    board: Board;
  }
}
