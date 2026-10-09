import type { Context } from 'cordis';
import {
  check,
  createService,
  newId,
  now,
  recorded,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { Drawing } from './elements.js';
import { drawSchema, elementSchema, id, parse, setSchema, title, type DrawInput } from './input.js';
import { postgresMigrations } from './storage.postgres.js';
import type { Board, BoardDrawn, BoardElement, BoardScene, BoardSummary } from './types.js';
export type * from './types.js';

/** The most live shapes one board holds. */
const MOST = 5_000;

/**
 * Whiteboards (founder, 2026-10-09): unlimited per project, drawn on by people in Excalidraw and by
 * their agents through board.draw. A board is a living record, not a file: each shape is kept at
 * its newest version, so a person, a colleague and an agent drawing at once merge shape by shape.
 * Board reads nothing outside itself; a card that links to a record keeps only its id, which the
 * page names and opens through project.references.
 */
export class BoardService implements Board {
  private closed = false;
  constructor(
    private state: State,
    private scope: Scope,
  ) {}
  async initialize(): Promise<void> {
    await this.state.migrate('board', postgresMigrations);
  }
  close(): void {
    this.closed = true;
  }
  private open(caller: Caller): Caller {
    check(!this.closed, 'board_unavailable', 'Boards are unavailable', 503);
    return structuredClone(caller);
  }
  private async summary(caller: Caller, boardId: string, tx: Transaction): Promise<BoardSummary> {
    const row = await tx.get<{ record: string }>(
      'SELECT record FROM boards WHERE id=? AND project_id=?',
      parse(id, boardId),
      caller.projectId,
    );
    check(row, 'not_found', 'Board not found', 404);
    return JSON.parse(row.record) as BoardSummary;
  }
  private async elements(boardId: string, since: number | undefined, tx: Transaction) {
    const rows =
      since === undefined
        ? await tx.all<{ record: string }>(
            'SELECT record FROM board_elements WHERE board_id=? AND NOT deleted',
            boardId,
          )
        : await tx.all<{ record: string }>(
            'SELECT record FROM board_elements WHERE board_id=? AND revision>?',
            boardId,
            since,
          );
    return rows.map((row) => JSON.parse(row.record) as BoardElement);
  }
  private async write(caller: Caller, board: BoardSummary, tx: Transaction) {
    await tx.run(
      'UPDATE boards SET revision=?,record=? WHERE id=?',
      board.revision,
      JSON.stringify(board),
      board.id,
    );
  }

  async list(caller: Caller): Promise<BoardSummary[]> {
    caller = this.open(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<{ record: string }>(
          'SELECT record FROM boards WHERE project_id=?',
          caller.projectId,
        )
      )
        .map((row) => JSON.parse(row.record) as BoardSummary)
        .filter((board) => !board.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }
  async scene(caller: Caller, boardId: string, since?: number): Promise<BoardScene> {
    caller = this.open(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const board = await this.summary(caller, boardId, tx);
      return { board, elements: await this.elements(board.id, since, tx) };
    });
  }
  private async created(caller: Caller, name: string, tx: Transaction): Promise<BoardSummary> {
    await this.scope.require(caller, 'write', tx);
    const at = now();
    const board: BoardSummary = {
      id: newId('board'),
      projectId: caller.projectId,
      title: parse(title, name),
      revision: 0,
      archived: false,
      createdBy: caller.actorId,
      createdAt: at,
      updatedBy: caller.actorId,
      updatedAt: at,
    };
    await tx.run(
      'INSERT INTO boards(id,project_id,revision,record) VALUES(?,?,?,?)',
      board.id,
      board.projectId,
      0,
      JSON.stringify(board),
    );
    await recorded(this.state, tx, caller, 'board.created', board.id, { title: board.title });
    return board;
  }
  async create(caller: Caller, name: string): Promise<BoardSummary> {
    caller = this.open(caller);
    return await this.state.transaction(async (tx) => await this.created(caller, name, tx));
  }
  async set(caller: Caller, boardId: string, change: { title?: string; archived?: boolean }) {
    caller = this.open(caller);
    const input = parse(setSchema, { id: boardId, ...change });
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const board = await this.summary(caller, input.id, tx);
      const next = {
        ...board,
        ...(input.title !== undefined && { title: input.title }),
        ...(input.archived !== undefined && { archived: input.archived }),
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      await this.write(caller, next, tx);
      await recorded(this.state, tx, caller, 'board.set', board.id, {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.archived !== undefined && { archived: input.archived }),
      });
      return next;
    });
  }
  /**
   * Keeps each shape whose version is newer than the stored one (the lower nonce winning a tie,
   * as Excalidraw reconciles), all in one revision of the board.
   */
  private async merge(
    caller: Caller,
    board: BoardSummary,
    shapes: BoardElement[],
    tx: Transaction,
  ) {
    const stored = new Map(
      (
        await tx.all<{ element_id: string; record: string }>(
          `SELECT element_id,record FROM board_elements WHERE board_id=? AND element_id IN (${shapes.map(() => '?').join(',')})`,
          board.id,
          ...shapes.map((shape) => shape.id),
        )
      ).map((row) => [row.element_id, JSON.parse(row.record) as BoardElement]),
    );
    const newer = shapes.filter((shape) => {
      const old = stored.get(shape.id);
      return (
        !old ||
        shape.version > old.version ||
        (shape.version === old.version && shape.versionNonce < old.versionNonce)
      );
    });
    if (!newer.length) return { board, accepted: 0 };
    const added = newer.filter((shape) => !stored.has(shape.id) && !shape.isDeleted).length;
    if (added) {
      const live = await tx.get<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM board_elements WHERE board_id=? AND NOT deleted',
        board.id,
      );
      check(
        (live?.n ?? 0) + added <= MOST,
        'board_full',
        `A board holds at most ${MOST} shapes`,
        409,
      );
    }
    const next = {
      ...board,
      revision: board.revision + 1,
      updatedBy: caller.actorId,
      updatedAt: now(),
    };
    for (const shape of newer)
      await tx.run(
        `INSERT INTO board_elements(board_id,element_id,revision,deleted,record) VALUES(?,?,?,?,?)
         ON CONFLICT(board_id,element_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,record=excluded.record`,
        board.id,
        shape.id,
        next.revision,
        shape.isDeleted ? 'true' : 'false',
        JSON.stringify(shape),
      );
    await this.write(caller, next, tx);
    await recorded(this.state, tx, caller, 'board.changed', board.id, {
      revision: next.revision,
      shapes: newer.length,
    });
    return { board: next, accepted: newer.length };
  }
  async save(caller: Caller, boardId: string, shapes: BoardElement[]) {
    caller = this.open(caller);
    const elements = parse(elementSchema.array().min(1).max(500), shapes) as BoardElement[];
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.merge(caller, await this.summary(caller, boardId, tx), elements, tx);
    });
  }
  async draw(caller: Caller, value: DrawInput): Promise<BoardDrawn> {
    caller = this.open(caller);
    const input = parse(drawSchema, value);
    check(
      input.board || input.title,
      'invalid_board_input',
      'Name a board, or a title for a new one',
    );
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      let board = input.board
        ? await this.summary(caller, input.board, tx)
        : await this.created(caller, input.title!, tx);
      if (input.board && input.title && input.title !== board.title) {
        board = { ...board, title: input.title };
        await this.write(caller, board, tx);
      }
      const drawing = new Drawing(
        await this.elements(board.id, undefined, tx),
        !!caller.conversation,
      );
      for (const op of input.ops) drawing.apply(op);
      const changed = drawing.result();
      const merged = changed.length
        ? await this.merge(caller, board, changed, tx)
        : { board, accepted: 0 };
      return { board: merged.board, created: drawing.created, changed: merged.accepted };
    });
  }
}

export const boardPlugin = {
  name: 'merv-board',
  inject: ['state', 'scope'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(new BoardService(ctx.state, ctx.scope));
      yield () => service.close();
      yield ctx.provide('board', service);
    });
  },
};
export default boardPlugin;
