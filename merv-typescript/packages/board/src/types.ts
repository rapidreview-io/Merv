import type { Caller } from '@merv/contracts';
import type { DrawInput } from './input.js';
import type { BoardElement, BoardScene, BoardSummary } from './models.js';

export type * from './models.js';

/** What board.draw did: the board, and the id each keyed shape got. */
export interface BoardDrawn {
  board: BoardSummary;
  created: Record<string, string>;
  changed: number;
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
  /** Draws an agent's operations (input.ts), placed by Board, on one board or a new one. */
  draw(caller: Caller, input: DrawInput): Promise<BoardDrawn>;
}

declare module 'cordis' {
  interface Context {
    board: Board;
  }
}
