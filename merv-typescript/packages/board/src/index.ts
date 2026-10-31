import type { Context } from 'cordis';
import {
  check,
  createService,
  forRead,
  newId,
  now,
  recorded,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { bounds, Drawing, rectOf } from './elements.js';
import {
  drawSchema,
  elementSchema,
  fileIdSchema,
  id,
  imageType,
  outcomeSchema,
  outcomeSentSchema,
  parse,
  setSchema,
  title,
  type DrawInput,
  type OutcomeInput,
  type OutcomeSentInput,
} from './input.js';
import { postgresMigrations } from './storage.postgres.js';
import type {
  Board,
  BoardChange,
  BoardDrawn,
  BoardElement,
  BoardHistory,
  BoardScene,
  BoardSummary,
  Outcome,
  OutcomeLine,
  PlacedImage,
} from './types.js';
import { MOST_IMAGE_BYTES, stacked } from './models.js';
export type * from './types.js';

/** The most live shapes one board holds. */
const MOST = 5_000;
/** How long a deleted shape is kept, and the most a save purges after it. */
const [KEEP_MS, PURGE] = [30 * 86_400_000, 500];
/** How long a person's saves count as one step of history, and the size past which a step stops growing. */
const [STEP_MS, STEP_BYTES] = [5_000, 1_000_000];
/** The most steps of history one read answers, and the bytes past which it stops. */
const [HISTORY_PAGE, HISTORY_BYTES] = [100, 2_000_000];
/** The most outcomes one board holds, the characters one holds, and the sends it remembers. */
const [MOST_OUTCOMES, OUTCOME_CHARS, SENDS_KEPT] = [50, 200_000, 20];
/** An outcome's row as a line; Postgres may answer a BIGINT as text. */
const outcomeLine = (row: { id: string; revision: number; record: string }) =>
  ({ id: row.id, revision: Number(row.revision), ...JSON.parse(row.record) }) as OutcomeLine;
const lineOf = ({ text: _text, createdBy: _by, updatedBy: _last, ...line }: Outcome): OutcomeLine =>
  line;
/** Whether a shape is newer than the one held: the lower nonce wins a tie, as Excalidraw reconciles. */
const newer = (shape: BoardElement, held?: BoardElement) =>
  !held ||
  shape.version > held.version ||
  (shape.version === held.version && shape.versionNonce < held.versionNonce);

/**
 * Whiteboards (founder, 2026-10-09): unlimited per project, drawn on by people in Excalidraw and by
 * their agents through board.draw. A board is a living record, not a file: each shape is kept at
 * its newest version, so a person, a colleague and an agent drawing at once merge shape by shape.
 * Board reads nothing outside itself; a card that links to a record keeps only its id, which the
 * page names and opens through project.references. An image's bytes are Board's own, kept in its
 * table under project membership, so it needs no other plugin. Every project member may edit a
 * board, including reviewers and readers; read scope establishes membership, not a read-only effect.
 * Session writes still re-check their live authority in this transaction.
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
  /** A board, and the newest revision whose deletion Board has purged. */
  private async summary(caller: Caller, boardId: string, tx: Transaction) {
    const row = await tx.get<{ record: string; purged: number }>(
      'SELECT record,purged FROM boards WHERE id=? AND project_id=?',
      parse(id, boardId),
      caller.projectId,
    );
    check(row, 'not_found', 'Board not found', 404);
    return [JSON.parse(row.record) as BoardSummary, row.purged] as const;
  }
  private async elements(boardId: string, since: number | undefined, tx: Transaction) {
    const rows = await tx.all<{ record: string }>(
      `SELECT record FROM board_elements WHERE board_id=? AND ${since === undefined ? 'NOT deleted' : 'revision>?'}`,
      boardId,
      ...(since === undefined ? [] : [since]),
    );
    return stacked(rows.map((row) => JSON.parse(row.record) as BoardElement));
  }
  private async write(board: BoardSummary, tx: Transaction) {
    await tx.run(
      'UPDATE boards SET revision=?,record=? WHERE id=?',
      board.revision,
      JSON.stringify(board),
      board.id,
    );
  }

  async list(caller: Caller): Promise<BoardSummary[]> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
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
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const [board, purged] = await this.summary(caller, boardId, tx);
      // A deletion purged after `since` can no longer be named, so that reader is told it all.
      const whole = since !== undefined && since < purged;
      const elements = await this.elements(board.id, whole ? undefined : since, tx);
      const outcomes = await this.lines(board.id, tx);
      return whole ? { board, outcomes, elements, whole } : { board, outcomes, elements };
    });
  }
  async history(caller: Caller, boardId: string, after = 0): Promise<BoardHistory> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      // Members alone, as with image bytes: it holds what people drew and erased.
      await this.editable(caller, tx);
      await this.summary(caller, boardId, tx);
      const rows = await tx.all<{
        revision: number;
        actor_id: string;
        began_at: string;
        kind: BoardChange['kind'];
        shapes: string;
      }>(
        `SELECT revision,actor_id,began_at,kind,shapes FROM (SELECT *,SUM(octet_length(shapes)) OVER (ORDER BY revision)-octet_length(shapes) AS earlier
           FROM board_history WHERE board_id=? AND revision>? ORDER BY revision LIMIT ${HISTORY_PAGE}) h WHERE earlier<${HISTORY_BYTES} ORDER BY revision`,
        boardId,
        after,
      );
      const count = await tx.get<{ total: number; left: number }>(
        'SELECT COUNT(*)::int AS total,(COUNT(*) FILTER (WHERE revision>?))::int AS left FROM board_history WHERE board_id=?',
        after,
        boardId,
      );
      return {
        changes: rows.map((row) => ({
          revision: row.revision,
          actorId: row.actor_id,
          at: row.began_at,
          kind: row.kind,
          shapes: JSON.parse(row.shapes) as BoardElement[],
        })),
        total: count!.total,
        ...(count!.left > rows.length && { next: rows.at(-1)!.revision }),
      };
    });
  }
  /** Collaboration is for project members, not platform inspection or runner control identities. */
  private async editable(caller: Caller, tx: Transaction): Promise<void> {
    check(
      !caller.platform && !caller.managed,
      'forbidden',
      'Board edits require a project member',
      403,
    );
    await this.scope.require(caller, 'read', tx);
  }
  private async created(caller: Caller, name: string, tx: Transaction): Promise<BoardSummary> {
    await this.editable(caller, tx);
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
    // Parsed as plain data, which drops what is undefined: only the fields given are changed.
    const { id: _id, ...fields } = parse(setSchema, { id: boardId, ...change });
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      const next = { ...board, ...fields, updatedBy: caller.actorId, updatedAt: now() };
      await this.write(next, tx);
      await recorded(this.state, tx, caller, 'board.set', board.id, fields);
      return next;
    });
  }
  /**
   * Writes what this revision made of its shapes to the board's history, for replay. A person's
   * saves moments apart are one step, so a step is not a row every 600 ms; an agent's every call
   * stands alone, since each is a step it meant, and another actor's change ends any step.
   */
  private async remember(
    caller: Caller,
    board: BoardSummary,
    next: BoardSummary,
    shapes: BoardElement[],
    kind: BoardChange['kind'],
    tx: Transaction,
  ) {
    const last = await tx.get<{
      revision: number;
      actor_id: string;
      began_at: string;
      kind: string;
      bytes: number;
    }>(
      'SELECT revision,actor_id,began_at,kind,octet_length(shapes) AS bytes FROM board_history WHERE board_id=? ORDER BY revision DESC LIMIT 1',
      board.id,
    );
    const step = (revision: number, at: string, kind: string, shapes: BoardElement[]) =>
      tx.run(
        'INSERT INTO board_history(board_id,revision,actor_id,began_at,kind,shapes) VALUES(?,?,?,?,?,?)',
        board.id,
        revision,
        caller.actorId,
        at,
        kind,
        JSON.stringify(shapes),
      );
    // A board older than history starts it from how it stands, as there is no knowing how it came.
    const before = !last && board.revision ? await this.elements(board.id, undefined, tx) : [];
    if (!last && board.revision) await step(board.revision, next.updatedAt, 'before', before);
    if (
      kind === 'save' &&
      last?.kind === 'save' &&
      last.actor_id === caller.actorId &&
      last.bytes < STEP_BYTES &&
      Date.parse(next.updatedAt) - Date.parse(last.began_at) < STEP_MS
    ) {
      // A shape saved again stands where it first came in the step, as it now is.
      const held = await tx.get<{ shapes: string }>(
        'SELECT shapes FROM board_history WHERE board_id=? AND revision=?',
        board.id,
        last.revision,
      );
      const merged = new Map((JSON.parse(held!.shapes) as BoardElement[]).map((el) => [el.id, el]));
      for (const shape of shapes) merged.set(shape.id, shape);
      await tx.run(
        'UPDATE board_history SET revision=?,shapes=? WHERE board_id=? AND revision=?',
        next.revision,
        JSON.stringify([...merged.values()]),
        board.id,
        last.revision,
      );
    } else await step(next.revision, next.updatedAt, kind, shapes);
    // History shows an image as long as the board lasts, so its bytes last that long too.
    const files = new Set([...before, ...shapes].map((el) => el.fileId));
    for (const file of files)
      if (typeof file === 'string')
        await tx.run(
          'INSERT INTO board_history_files(project_id,file_id) VALUES(?,?) ON CONFLICT DO NOTHING',
          board.projectId,
          file,
        );
  }
  /** Keeps each shape whose version is newer than the stored one, all in one revision of the board. */
  private async merge(
    caller: Caller,
    board: BoardSummary,
    shapes: BoardElement[],
    kind: 'draw' | 'save',
    tx: Transaction,
  ) {
    // A save may name a shape twice: its newest version stands for it.
    const latest = new Map<string, BoardElement>();
    for (const shape of shapes) if (newer(shape, latest.get(shape.id))) latest.set(shape.id, shape);
    const stored = new Map(
      (
        await tx.all<{ element_id: string; record: string }>(
          `SELECT element_id,record FROM board_elements WHERE board_id=? AND element_id IN (${[...latest.keys()].map(() => '?').join(',')})`,
          board.id,
          ...latest.keys(),
        )
      ).map((row) => [row.element_id, JSON.parse(row.record) as BoardElement]),
    );
    const kept = [...latest.values()].filter((shape) => newer(shape, stored.get(shape.id)));
    if (!kept.length) return { board, accepted: 0 };
    // A shape new to the board, or brought back from deletion, counts against the cap.
    const added = kept.filter(
      (shape) => !shape.isDeleted && (stored.get(shape.id)?.isDeleted ?? true),
    ).length;
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
    await this.remember(caller, board, next, kept, kind, tx);
    for (const shape of kept)
      await tx.run(
        `INSERT INTO board_elements(board_id,element_id,revision,deleted,deleted_at,record,file_id) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(board_id,element_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,deleted_at=excluded.deleted_at,record=excluded.record,file_id=excluded.file_id`,
        board.id,
        shape.id,
        next.revision,
        shape.isDeleted ? 'true' : 'false',
        shape.isDeleted ? next.updatedAt : null,
        JSON.stringify(shape),
        typeof shape.fileId === 'string' ? shape.fileId : null,
      );
    // Shapes deleted over 30 days ago go, the oldest first and a bounded number a save; the board
    // keeps the newest revision it purged, so scene() knows which readers missed a deletion.
    const cutoff = new Date(Date.parse(next.updatedAt) - KEEP_MS).toISOString();
    const purged = await tx.run(
      `WITH gone AS (DELETE FROM board_elements WHERE (board_id,element_id) IN (SELECT board_id,element_id FROM board_elements
         WHERE board_id=? AND deleted AND deleted_at<? ORDER BY deleted_at LIMIT ${PURGE}) RETURNING board_id,revision)
       UPDATE boards SET purged=GREATEST(purged,(SELECT MAX(revision) FROM gone)) WHERE id IN (SELECT board_id FROM gone)`,
      board.id,
      cutoff,
    );
    // A purge may leave bytes no shape of the project can name, and they go with it, as does what
    // was stored that long ago and never drawn.
    if (purged.changes)
      await tx.run(
        `DELETE FROM board_images i WHERE project_id=? AND stored_at<? AND NOT EXISTS(SELECT 1 FROM board_elements e
           JOIN boards b ON b.id=e.board_id WHERE b.project_id=i.project_id AND e.file_id=i.file_id)
           AND NOT EXISTS(SELECT 1 FROM board_history_files f WHERE f.project_id=i.project_id AND f.file_id=i.file_id)`,
        board.projectId,
        cutoff,
      );
    await this.write(next, tx);
    await recorded(this.state, tx, caller, 'board.changed', board.id, {
      revision: next.revision,
      shapes: kept.length,
    });
    return { board: next, accepted: kept.length };
  }
  async save(caller: Caller, boardId: string, shapes: BoardElement[]) {
    caller = this.open(caller);
    const elements = parse(elementSchema.array().min(1).max(500), shapes) as BoardElement[];
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      return await this.merge(caller, board, elements, 'save', tx);
    });
  }
  async storeImage(caller: Caller, fileId: string, bytes: Buffer) {
    caller = this.open(caller);
    const file = parse(fileIdSchema, fileId);
    check(bytes.length <= MOST_IMAGE_BYTES, 'image_too_large', 'An image is at most 10 MiB', 413);
    const mediaType = imageType(bytes);
    check(mediaType, 'image_type', 'An image is a PNG, JPEG, WebP or GIF', 415);
    await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      // The same file again is kept once; its date moves, so a purge spares what is about to be drawn.
      await tx.run(
        `INSERT INTO board_images(project_id,file_id,content,stored_at) VALUES(?,?,?,?)
         ON CONFLICT(project_id,file_id) DO UPDATE SET stored_at=excluded.stored_at`,
        caller.projectId,
        file,
        bytes,
        now(),
      );
    });
    return { fileId: file, mediaType, size: bytes.length };
  }
  async image(caller: Caller, fileId: string) {
    caller = this.open(caller);
    const file = parse(fileIdSchema, fileId);
    return await forRead(this.state, async (tx) => {
      // Members alone: a platform reader of the board's shapes is not shown what people pasted.
      await this.editable(caller, tx);
      const row = await tx.get<{ content: Buffer }>(
        'SELECT content FROM board_images WHERE project_id=? AND file_id=?',
        caller.projectId,
        file,
      );
      check(row, 'not_found', 'Image not found', 404);
      return { mediaType: imageType(row.content)!, content: row.content };
    });
  }
  async draw(caller: Caller, value: DrawInput, images: PlacedImage[] = []): Promise<BoardDrawn> {
    caller = this.open(caller);
    const input = parse(drawSchema, value);
    check(
      input.board || input.title,
      'invalid_board_input',
      'Name a board, or a title for a new one',
    );
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      let board = input.board
        ? (await this.summary(caller, input.board, tx))[0]
        : await this.created(caller, input.title!, tx);
      if (input.board && input.title && input.title !== board.title) {
        board = { ...board, title: input.title, updatedBy: caller.actorId, updatedAt: now() };
        await this.write(board, tx);
        await recorded(this.state, tx, caller, 'board.set', board.id, { title: board.title });
      }
      const drawing = new Drawing(
        await this.elements(board.id, undefined, tx),
        !!caller.conversation,
      );
      const waiting = [...images];
      for (const op of input.ops)
        drawing.apply(op, op.op === 'image' ? waiting.shift() : undefined);
      const changed = drawing.result();
      const merged = changed.length
        ? await this.merge(caller, board, changed, 'draw', tx)
        : { board, accepted: 0 };
      const region = bounds(changed.map(rectOf));
      return {
        board: merged.board,
        created: drawing.created,
        changed: merged.accepted,
        ...(drawing.proposal && { proposal: drawing.proposal }),
        ...(region && { region }),
      };
    });
  }
  private async lines(boardId: string, tx: Transaction) {
    const rows = await tx.all<{ id: string; revision: number; record: string }>(
      'SELECT id,revision,record FROM board_outcomes WHERE board_id=?',
      boardId,
    );
    return rows
      .map((row) => outcomeLine(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** One outcome of a board this caller's project holds. */
  private async held(caller: Caller, boardId: string, outcomeId: string, tx: Transaction) {
    await this.summary(caller, boardId, tx);
    const row = await tx.get<{ id: string; revision: number; record: string; text: string }>(
      'SELECT id,revision,record,text FROM board_outcomes WHERE board_id=? AND id=?',
      boardId,
      parse(id, outcomeId),
    );
    check(row, 'not_found', 'Outcome not found', 404);
    return { ...outcomeLine(row), text: row.text } as Outcome;
  }
  private async keepOutcome(outcome: Outcome, tx: Transaction, boardId: string) {
    const { id, revision, text, ...record } = outcome;
    await tx.run(
      `INSERT INTO board_outcomes(board_id,id,revision,record,text) VALUES(?,?,?,?,?)
       ON CONFLICT(board_id,id) DO UPDATE SET revision=excluded.revision,record=excluded.record,text=excluded.text`,
      boardId,
      id,
      revision,
      JSON.stringify(record),
      text,
    );
  }
  async outcome(caller: Caller, boardId: string, outcomeId: string): Promise<Outcome> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.held(caller, boardId, outcomeId, tx);
    });
  }
  async writeOutcome(caller: Caller, value: OutcomeInput): Promise<OutcomeLine> {
    caller = this.open(caller);
    const input = parse(outcomeSchema, value);
    check(
      input.content === undefined || !input.edits,
      'invalid_board_input',
      'An outcome takes content, which replaces it whole, or edits, which change part of it, not both',
    );
    return await this.state
      .transaction(async (tx) => {
        await this.editable(caller, tx);
        await this.summary(caller, input.board, tx);
        const at = now();
        let before: Outcome;
        if (input.outcome) before = await this.held(caller, input.board, input.outcome, tx);
        else {
          check(input.title, 'invalid_board_input', 'A new outcome needs a title');
          check(
            !input.edits,
            'invalid_board_input',
            'A new outcome has nothing to edit: give content',
          );
          const held = await tx.get<{ n: number }>(
            'SELECT COUNT(*)::int AS n FROM board_outcomes WHERE board_id=?',
            input.board,
          );
          check(
            (held?.n ?? 0) < MOST_OUTCOMES,
            'board_full',
            `A board holds at most ${MOST_OUTCOMES} outcomes`,
            409,
          );
          before = {
            id: newId('outcome'),
            title: input.title,
            revision: 0,
            text: '',
            createdBy: caller.actorId,
            createdAt: at,
            updatedBy: caller.actorId,
            updatedAt: at,
            sent: [],
          };
        }
        let text = before.text;
        if (input.content !== undefined) {
          if (input.outcome)
            check(
              input.expectedRevision === before.revision,
              'board_outcome_conflict',
              `Expected revision ${input.expectedRevision ?? 'none'}, found ${before.revision}: read the outcome again with board.read outcome and change it with edits [{find, replace}], or resend content with expectedRevision ${before.revision}`,
              409,
            );
          text = input.content;
        }
        for (const [edit, { find, replace }] of (input.edits ?? []).entries()) {
          const found = text.indexOf(find);
          const repeated = found >= 0 && text.includes(find, found + 1);
          check(
            found >= 0 && !repeated,
            'board_outcome_conflict',
            `Edit ${edit + 1} finds ${JSON.stringify(find.slice(0, 80))} ${repeated ? 'more than once, so quote more of the text around it' : 'nowhere'} in outcome ${before.id} revision ${before.revision}${edit ? ', after the edits before it' : ''}: each find quotes text that occurs exactly once, as board.read outcome returns it`,
            409,
          );
          text = text.slice(0, found) + replace + text.slice(found + find.length);
        }
        check(
          text.length <= OUTCOME_CHARS,
          'invalid_board_input',
          `An outcome holds at most ${OUTCOME_CHARS} characters; this would hold ${text.length}`,
        );
        const name = input.title ?? before.title;
        if (input.outcome && text === before.text && name === before.title) return before;
        const next = {
          ...before,
          title: name,
          text,
          revision: before.revision + 1,
          updatedBy: caller.actorId,
          updatedAt: at,
        };
        await this.keepOutcome(next, tx, input.board);
        await recorded(this.state, tx, caller, 'board.outcome', input.board, {
          outcome: next.id,
          revision: next.revision,
        });
        return next;
      })
      .then(lineOf);
  }
  async outcomeSent(caller: Caller, value: OutcomeSentInput): Promise<OutcomeLine> {
    caller = this.open(caller);
    const input = parse(outcomeSentSchema, value);
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      // Whoever may keep a file: a reader, who may edit the board, sends nothing in anyone's name.
      await this.scope.require(caller, 'write', tx);
      const outcome = await this.held(caller, input.board, input.outcome, tx);
      const { board: _board, outcome: _outcome, ...sent } = input;
      const others = outcome.sent.filter(
        (was) => was.how !== sent.how || was.artifactId !== sent.artifactId,
      );
      const next = {
        ...outcome,
        sent: [...others, { at: now(), ...sent }].slice(-SENDS_KEPT),
      };
      await this.keepOutcome(next, tx, input.board);
      return lineOf(next);
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
