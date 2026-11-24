import type { BoardRendering } from './rendering.js';
import type { LookName } from '@merv/protocol/looks';
import type { Caller, Transaction } from '@merv/contracts';
import type { DrawInput } from './input.js';
import type {
  BoardChange,
  BoardElement,
  BoardHistory,
  BoardSaid,
  BoardScene,
  BoardSummary,
} from './models.js';

export type * from './models.js';

/** A stretch of a board's history: how it stood before, then each step in order. */
export interface BoardRewound {
  board: BoardSummary;
  before: BoardElement[];
  steps: BoardChange[];
}

/** What board.draw did: the board, and the id each keyed shape got. */
export interface BoardDrawn {
  board: BoardSummary;
  created: Record<string, string>;
  changed: number;
  /** The group of what the call proposed, to move or delete it whole. */
  proposal?: string;
  /** Where its shapes landed, by key or id, as x, y, width, height. */
  placed: Record<string, number[]>;
  /** What stands under a shape that landed on another, by key or id. */
  overlaps?: Record<string, string[]>;
  /** Why a shape placed exactly landed on another. */
  note?: string;
  /** Where the call's changes stand, for those watching; no answer to the agent carries it. */
  region?: { x: number; y: number; width: number; height: number };
  /** How long a pen takes to draw what the call made, for the same; no answer carries it either. */
  penMs?: number;
  /** The sheet of the look this call put on the board, for the agent to follow from here. */
  look?: string;
}

/** An image already stored, for an image operation: tools turn its source into this first. */
export interface PlacedImage {
  fileId: string;
  width: number;
  height: number;
}

export interface Board {
  drawing(board: string): boolean;
  /** Render a board or a scene already read by this caller, without changing the agent camera. */
  render: BoardRendering['render'];
  display: BoardRendering['display'];
  share(caller: Caller, id: string, revoke?: boolean): Promise<{ token?: string }>;
  sharedScene(token: string): Promise<{
    title: string;
    revision: number;
    look?: LookName;
    paper?: string;
    elements: BoardElement[];
  }>;
  sharedHistory(token: string, after?: number): Promise<BoardHistory>;
  sharedImage(token: string, fileId: string): Promise<{ mediaType: string; content: Buffer }>;
  list(caller: Caller): Promise<BoardSummary[]>;
  scene(
    caller: Caller,
    id: string,
    since?: number,
    edited?: Record<string, number>,
  ): Promise<BoardScene>;
  create(caller: Caller, title: string): Promise<BoardSummary>;
  set(
    caller: Caller,
    id: string,
    change: { title?: string; archived?: boolean; look?: LookName | null; paper?: string },
  ): Promise<BoardSummary>;
  /** Merges shapes a page drew: each shape is kept where its version is newer than the stored one. */
  save(
    caller: Caller,
    id: string,
    elements: BoardElement[],
  ): Promise<{ board: BoardSummary; accepted: number }>;
  /** A member's page of the board's history, oldest first, after a revision. */
  history(caller: Caller, id: string, after?: number): Promise<BoardHistory>;
  changesAfter(caller: Caller, id: string, after: number): Promise<BoardChange[]>;
  /** Keeps a line said aloud in a live session as a step of the board's history. */
  said(caller: Caller, id: string, line: BoardSaid): Promise<{ revision: number }>;
  /** The revision each live shape was last edited at, by id. */
  /** How the board stood just before step `from`, and each step from `from` to `to`. */
  rewind(caller: Caller, id: string, from: number, to: number): Promise<BoardRewound>;
  /** The board as it stood at a revision. */
  sceneAt(caller: Caller, id: string, revision: number): Promise<BoardScene>;
  /** Keeps an image's bytes under its file id in the caller's project, once: PNG, JPEG, WebP or
   *  GIF by their content, at most 10 MiB. */
  storeImage(
    caller: Caller,
    fileId: string,
    bytes: Buffer,
  ): Promise<{ fileId: string; mediaType: string; size: number }>;
  /** An image's bytes, to a member of the project that stored them. */
  image(caller: Caller, fileId: string): Promise<{ mediaType: string; content: Buffer }>;
  /** Draws operations (input.ts), placed by Board, on one board or a new one; `images` holds what
   *  each image operation places, in order, and `agent` marks an agent's hand on what it draws. */
  draw(
    caller: Caller,
    input: DrawInput,
    images?: PlacedImage[],
    agent?: boolean,
  ): Promise<BoardDrawn>;
  /** Moves each retired outcome left in board_outcomes to a page card on its board, once. */
  pageOutcomes(): Promise<number>;
}

declare module 'cordis' {
  interface Context {
    board: Board;
  }
}
