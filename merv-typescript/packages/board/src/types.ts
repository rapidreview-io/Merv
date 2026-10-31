import type { Caller } from '@merv/contracts';
import type { DrawInput, OutcomeInput, OutcomeSentInput } from './input.js';
import type {
  BoardElement,
  BoardHistory,
  BoardScene,
  BoardSummary,
  Outcome,
  OutcomeLine,
} from './models.js';

export type * from './models.js';

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
  /** Draws operations (input.ts), placed by Board, on one board or a new one; `images` holds what
   *  each image operation places, in order, and `agent` marks an agent's hand on what it draws. */
  draw(
    caller: Caller,
    input: DrawInput,
    images?: PlacedImage[],
    agent?: boolean,
  ): Promise<BoardDrawn>;
  /** One of a board's outcomes with its text; `scene` lists them. */
  outcome(caller: Caller, board: string, id: string): Promise<Outcome>;
  /** Creates an outcome, or changes one: edits apply at any revision, content only at its own. */
  writeOutcome(caller: Caller, input: OutcomeInput): Promise<OutcomeLine>;
  /** Notes the file frozen from an outcome; its revision stays, so an unchanged resend is the same. */
  outcomeSent(caller: Caller, input: OutcomeSentInput): Promise<OutcomeLine>;
}

declare module 'cordis' {
  interface Context {
    board: Board;
  }
}
