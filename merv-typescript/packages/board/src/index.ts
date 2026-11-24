import { BoardWatch } from './hold.js';
import { BoardRendering, type RenderOptions } from './rendering.js';
import { LOOKS, LOOK_NAMES, lookSheet, type LookName } from '@merv/protocol/looks';
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'cordis';
import {
  check,
  createService,
  forRead,
  MervError,
  newId,
  now,
  recorded,
  digest,
  RequestJournal,
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
  parse,
  saidSchema,
  setSchema,
  title,
  type DrawInput,
  type DrawOp,
} from './input.js';
import { postgresMigrations } from './storage.postgres.js';
import type {
  Board,
  BoardChange,
  BoardDrawn,
  BoardElement,
  BoardHistory,
  BoardRewound,
  BoardSaid,
  BoardScene,
  BoardSummary,
  PlacedImage,
} from './types.js';
import { MOST_IMAGE_BYTES, penMs, penUnits, stacked } from './models.js';
export type * from './types.js';
export { drawSchema } from './input.js';

/** The most live shapes one board holds. */
const MOST = 5_000;
/** How long a deleted shape is kept, and the most a save purges after it. */
const [KEEP_MS, PURGE] = [30 * 86_400_000, 500];
/** How long a person's saves count as one step of history, and the size past which a step stops growing. */
const [STEP_MS, STEP_BYTES] = [5_000, 1_000_000];
/** The most steps of history one read answers, and the bytes past which it stops. */
const [HISTORY_PAGE, HISTORY_BYTES] = [100, 2_000_000];
/** The most shapes one read recalls the earlier state of. */
const MOST_RECALLED = 32;
/** The most a page card's body holds: a longer retired outcome becomes several cards. */
const PAGE_CHARS = 100_000;
/** A step of history as stored; Postgres may answer a BIGINT as text. */
type HistoryRow = {
  revision: number;
  actor_id: string;
  began_at: string;
  kind: BoardChange['kind'];
  shapes: string;
  said: string | null;
};
const stepOf = (row: HistoryRow): BoardChange => ({
  revision: Number(row.revision),
  actorId: row.actor_id,
  at: row.began_at,
  kind: row.kind,
  shapes: JSON.parse(row.shapes) as BoardElement[],
  ...(row.said && { said: JSON.parse(row.said) as BoardSaid }),
});
/** Whether a shape is newer than the one held: the lower nonce wins a tie, as Excalidraw reconciles. */
const newer = (shape: BoardElement, held?: BoardElement) =>
  !held ||
  shape.version > held.version ||
  (shape.version === held.version && shape.versionNonce < held.versionNonce);

/** A public drawing carries no record targets, links, agent identity or embedded details. */
const publicShape = (shape: BoardElement): BoardElement => {
  const { customData, link: _link, ...drawn } = shape;
  const say = (customData as { say?: unknown } | undefined)?.say;
  return { ...drawn, link: null, ...(typeof say === 'string' && { customData: { say } }) };
};

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
  private readonly rendering = new BoardRendering(this);
  display(caller: Caller, board: string, appearance: 'light' | 'dark') {
    this.rendering.display(caller, board, appearance);
  }
  render<T extends RenderOptions>(
    caller: Caller,
    board: string | import('./types.js').BoardScene,
    options?: T,
  ) {
    return this.rendering.render(caller, board, options);
  }
  readonly watch = new BoardWatch();
  drawing(board: string): boolean {
    return this.watch.drawing(board);
  }
  private closed = false;
  constructor(
    private state: State,
    private scope: Scope,
  ) {}
  async initialize(): Promise<void> {
    await this.state.migrate('board', postgresMigrations);
    const moved = await this.pageOutcomes();
    if (moved) console.log(`board: moved ${moved} outcome${moved === 1 ? '' : 's'} to page cards`);
  }
  close() {
    this.closed = true;
    this.watch.close();
    return this.rendering.close();
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
    // A look is the person's, never the record's: one written there earlier is not read back.
    const { look: _worn, ...board } = JSON.parse(row.record) as BoardSummary;
    return [board as BoardSummary, row.purged] as const;
  }
  /** The look this person draws in now, on every board of theirs. */
  private async lookOf(projectId: string, tx: Transaction): Promise<LookName | undefined> {
    const row = await tx.get<{ look: string }>(
      'SELECT look FROM board_looks WHERE project_id=?',
      projectId,
    );
    return row && (LOOK_NAMES as readonly string[]).includes(row.look)
      ? (row.look as LookName)
      : undefined;
  }
  private async setLook(caller: Caller, look: LookName | null, tx: Transaction) {
    if (look)
      await tx.run(
        'INSERT INTO board_looks(project_id,look,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET look=excluded.look,updated_at=excluded.updated_at',
        caller.projectId,
        look,
        now(),
      );
    else await tx.run('DELETE FROM board_looks WHERE project_id=?', caller.projectId);
  }
  /** A board as the person sees it now: in the look they draw in. */
  private dressed(board: BoardSummary, look: LookName | undefined): BoardSummary {
    return look ? { ...board, look } : board;
  }
  /**
   * Gives back the lines said since `since` that a later call took off their shape. A line lives on
   * the shape it was said with and is cleared when that shape changes again (an arrow joined to a
   * box is such a change), so a page that had not yet fetched it would never hear it. History has
   * every call as it was: each line said after `since` goes on its shape as the page gets it, in
   * the order said. One at or before `since` was fetched then, and is not said twice.
   */
  private async resaid(boardId: string, since: number, elements: BoardElement[], tx: Transaction) {
    const steps = await tx.all<{ shapes: string }>(
      `SELECT shapes FROM board_history WHERE board_id=? AND revision>? AND kind='draw' AND strpos(shapes,'"say"')>0 ORDER BY revision LIMIT 200`,
      boardId,
      since,
    );
    if (!steps.length) return;
    const said = new Map<string, string[]>();
    for (const step of steps)
      for (const shape of JSON.parse(step.shapes) as BoardElement[]) {
        const line = (shape.customData as { say?: unknown } | undefined)?.say;
        if (typeof line !== 'string') continue;
        const lines = said.get(shape.id) ?? [];
        if (!lines.includes(line)) said.set(shape.id, [...lines, line]);
      }
    for (const el of elements) {
      const lines = said.get(el.id);
      if (lines)
        el.customData = {
          ...(el.customData as Record<string, unknown> | undefined),
          say: lines.join(' '),
        };
    }
  }
  private async elements(
    boardId: string,
    since: number | undefined,
    tx: Transaction,
    edited?: Record<string, number>,
  ) {
    const rows = await tx.all<{ record: string; element_id: string; revision: number }>(
      `SELECT record,element_id,revision FROM board_elements WHERE board_id=? AND ${since === undefined ? 'NOT deleted' : 'revision>?'}`,
      boardId,
      ...(since === undefined ? [] : [since]),
    );
    if (edited) for (const row of rows) edited[row.element_id] = Number(row.revision);
    return stacked(rows.map((row) => JSON.parse(row.record) as BoardElement));
  }
  private async write(board: BoardSummary, tx: Transaction) {
    const { look: _worn, ...record } = board;
    await tx.run(
      'UPDATE boards SET revision=?,record=? WHERE id=?',
      board.revision,
      JSON.stringify(record),
      board.id,
    );
    this.state.afterCommit(() => this.watch.landed(board.id, board.revision));
  }

  async list(caller: Caller): Promise<BoardSummary[]> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const look = await this.lookOf(caller.projectId, tx);
      return (
        await tx.all<{ record: string }>(
          'SELECT record FROM boards WHERE project_id=?',
          caller.projectId,
        )
      )
        .map((row) => {
          const { look: _worn, ...board } = JSON.parse(row.record) as BoardSummary;
          return this.dressed(board as BoardSummary, look);
        })
        .filter((board) => !board.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }
  async scene(
    caller: Caller,
    boardId: string,
    since?: number,
    edited?: Record<string, number>,
  ): Promise<BoardScene> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const [stored, purged] = await this.summary(caller, boardId, tx);
      const board = this.dressed(stored, await this.lookOf(caller.projectId, tx));
      // A deletion purged after `since` can no longer be named, so that reader is told it all.
      const whole = since !== undefined && since < purged;
      const elements = await this.elements(board.id, whole ? undefined : since, tx, edited);
      if (since !== undefined && !whole && elements.length)
        await this.resaid(board.id, since, elements, tx);
      return whole ? { board, elements, whole } : { board, elements };
    });
  }
  async history(caller: Caller, boardId: string, after = 0): Promise<BoardHistory> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      // Members alone, as with image bytes: it holds what people drew and erased.
      await this.editable(caller, tx);
      await this.summary(caller, boardId, tx);
      return this.historyPage(boardId, after, tx);
    });
  }
  private async historyPage(
    boardId: string,
    after: number,
    tx: Transaction,
  ): Promise<BoardHistory> {
    const rows = await tx.all<{
      revision: number;
      actor_id: string;
      began_at: string;
      kind: BoardChange['kind'];
      shapes: string;
      said: string | null;
    }>(
      `SELECT revision,actor_id,began_at,kind,shapes,said FROM (SELECT *,SUM(octet_length(shapes)) OVER (ORDER BY revision)-octet_length(shapes) AS earlier
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
      changes: rows.map(stepOf),
      total: count!.total,
      ...(count!.left > rows.length && { next: rows.at(-1)!.revision }),
    };
  }
  /** A share is a separate read capability, never a Scope credential. Only its digest is kept. */
  async share(caller: Caller, boardId: string, revoke = false): Promise<{ token?: string }> {
    caller = this.open(caller);
    return this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      check(board.createdBy === caller.actorId, 'forbidden', 'Only the board owner can share', 403);
      await tx.run('DELETE FROM board_shares WHERE board_id=?', boardId);
      if (revoke) return {};
      const token = `mbs_${randomBytes(32).toString('base64url')}`;
      await tx.run(
        'INSERT INTO board_shares(board_id,digest) VALUES(?,?)',
        boardId,
        this.digest(token),
      );
      return { token };
    });
  }
  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  private async shared(token: string, tx: Transaction): Promise<BoardSummary> {
    check(!this.closed, 'board_unavailable', 'Boards are unavailable', 503);
    check(/^mbs_[A-Za-z0-9_-]{43}$/.test(token), 'not_found', 'Share not found', 404);
    const row = await tx.get<{ record: string }>(
      'SELECT b.record FROM boards b JOIN board_shares s ON s.board_id=b.id WHERE s.digest=?',
      this.digest(token),
    );
    check(row, 'not_found', 'Share not found', 404);
    return JSON.parse(row.record);
  }
  async sharedScene(token: string) {
    return forRead(this.state, async (tx) => {
      const board = await this.shared(token, tx);
      const look = await this.lookOf(board.projectId, tx);
      return {
        title: board.title,
        revision: board.revision,
        ...(look && { look }),
        paper: board.paper ?? '#ffffff',
        elements: (await this.elements(board.id, undefined, tx)).map(publicShape),
      };
    });
  }
  async sharedHistory(token: string, after = 0): Promise<BoardHistory> {
    return forRead(this.state, async (tx) => {
      const board = await this.shared(token, tx);
      const page = await this.historyPage(board.id, after, tx);
      return {
        ...page,
        // A share shows the drawing; what was said aloud beside it stays with the project.
        changes: page.changes
          .filter(({ kind }) => kind !== 'said')
          .map((change) => ({
            ...change,
            actorId: createHash('sha256')
              .update(token)
              .update(change.actorId)
              .digest('hex')
              .slice(0, 16),
            shapes: change.shapes.map(publicShape),
          })),
      };
    });
  }
  async sharedImage(token: string, fileId: string) {
    return forRead(this.state, async (tx) => {
      const board = await this.shared(token, tx);
      const file = parse(fileIdSchema, fileId);
      const row = await tx.get<{ content: Buffer }>(
        `SELECT content FROM board_images WHERE project_id=? AND file_id=? AND (
          EXISTS(SELECT 1 FROM board_elements WHERE board_id=? AND file_id=?) OR
          EXISTS(SELECT 1 FROM board_history h
         CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(h.shapes,'jsonb') THEN h.shapes::jsonb ELSE '[]'::jsonb END AS shapes OFFSET 0) decoded,
         jsonb_array_elements(decoded.shapes) e WHERE h.board_id=? AND e->>'fileId'=?))`,
        board.projectId,
        file,
        board.id,
        file,
        board.id,
        file,
      );
      check(row, 'not_found', 'Image not found', 404);
      return { mediaType: imageType(row.content)!, content: row.content };
    });
  }
  /** What changed after a revision, a bounded page of it, and how each shape it names stood then. */
  async changesAfter(caller: Caller, boardId: string, after: number) {
    const { changes } = await this.history(caller, boardId, after);
    const ids = [...new Set(changes.flatMap(({ shapes }) => shapes.map((el) => el.id)))];
    if (!ids.length) return changes;
    return await forRead(this.state, async (tx) => {
      const rows = await tx.all<{ revision: number; shape: BoardElement }>(
        `SELECT DISTINCT ON (e->>'id') h.revision, e AS shape
         FROM board_history h
         CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(h.shapes,'jsonb') THEN h.shapes::jsonb ELSE '[]'::jsonb END AS shapes
           WHERE h.shapes LIKE ANY(ARRAY(SELECT jsonb_array_elements_text(?::jsonb))) OFFSET 0) decoded,
         jsonb_array_elements(decoded.shapes) e
         WHERE h.board_id=? AND h.revision<=? AND e->>'id'=ANY(ARRAY(SELECT jsonb_array_elements_text(?::jsonb)))
         ORDER BY e->>'id', h.revision DESC`,
        JSON.stringify(
          ids
            .slice(0, MOST_RECALLED)
            .map((id) => '%"id":' + JSON.stringify(id).replace(/[\\%_]/g, '\\$&') + '%'),
        ),
        boardId,
        after,
        JSON.stringify(ids.slice(0, MOST_RECALLED)),
      );
      const byId = new Map(rows.map((row) => [row.shape.id, row]));
      const stood: BoardChange[] = ids.flatMap((id) => {
        const row = byId.get(id);
        return row
          ? [
              {
                revision: Number(row.revision),
                actorId: '',
                at: '',
                kind: 'before' as const,
                shapes: [row.shape],
              },
            ]
          : [];
      });
      return [...stood, ...changes];
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
      paper: '#ffffff',
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
  async set(
    caller: Caller,
    boardId: string,
    change: { title?: string; archived?: boolean; look?: LookName | null; paper?: string },
  ) {
    caller = this.open(caller);
    // Parsed as plain data, which drops what is undefined: only the fields given are changed.
    const { id: _id, look, ...fields } = parse(setSchema, { id: boardId, ...change });
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      const next: BoardSummary = {
        ...board,
        ...fields,
        revision:
          board.revision + (fields.paper !== undefined && fields.paper !== board.paper ? 1 : 0),
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      // The look is the person's: set here, it is how every board of theirs draws from now on.
      if (look !== undefined) await this.setLook(caller, look, tx);
      if (Object.keys(fields).length) await this.write(next, tx);
      await recorded(this.state, tx, caller, 'board.set', board.id, {
        ...fields,
        ...(look !== undefined && { look }),
      });
      return this.dressed(next, await this.lookOf(caller.projectId, tx));
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
    said?: BoardSaid,
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
        'INSERT INTO board_history(board_id,revision,actor_id,began_at,kind,shapes,said) VALUES(?,?,?,?,?,?,?)',
        board.id,
        revision,
        caller.actorId,
        at,
        kind,
        JSON.stringify(shapes),
        kind === 'said' && said ? JSON.stringify(said) : null,
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
    // A page's save is a person's hand, whichever last drew the shape it holds.
    if (kind === 'save')
      for (const shape of kept) {
        const customData = shape.customData as
          { changedBy?: string; say?: string; tab?: string; owner?: string } | undefined;
        delete customData?.changedBy;
        // And it says nothing: a line copied or moved with its shape is no agent speaking.
        delete customData?.say;
        // Which browser tab a page is, and whose, only an agent's draw says; a save keeps what was.
        const was = stored.get(shape.id)?.customData as
          { tab?: string; owner?: string } | undefined;
        if (customData)
          for (const key of ['tab', 'owner'] as const) {
            if (was?.[key] === undefined) delete customData[key];
            else customData[key] = was[key];
          }
      }
    if (!kept.length) return { board, accepted: 0 };
    // Enforce the live count after the entire merge, including accepted deletions.
    const added = kept.reduce(
      (count, shape) =>
        count +
        Number(!shape.isDeleted) -
        Number(stored.has(shape.id) && !stored.get(shape.id)!.isDeleted),
      0,
    );
    if (added > 0) {
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
    // Bound each statement (seven parameters per shape), including larger agent draws.
    for (let offset = 0; offset < kept.length; offset += 500) {
      const batch = kept.slice(offset, offset + 500);
      await tx.run(
        `INSERT INTO board_elements(board_id,element_id,revision,deleted,deleted_at,record,file_id) VALUES ${batch.map(() => '(?,?,?,?,?,?,?)').join(',')}
         ON CONFLICT(board_id,element_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,deleted_at=excluded.deleted_at,record=excluded.record,file_id=excluded.file_id`,
        ...batch.flatMap((shape) => [
          board.id,
          shape.id,
          next.revision,
          shape.isDeleted ? 'true' : 'false',
          shape.isDeleted ? next.updatedAt : null,
          JSON.stringify(shape),
          typeof shape.fileId === 'string' ? shape.fileId : null,
        ]),
      );
    }
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
      // Position and styling changes do not make frozen work stale.
      words: kept.some((shape) => {
        const words = (value?: BoardElement) =>
          value?.isDeleted
            ? ''
            : JSON.stringify([
                value?.text,
                value?.originalText,
                value?.name,
                (value?.customData as { details?: unknown } | undefined)?.details,
              ]);
        return words(shape) !== words(stored.get(shape.id));
      }),
    });
    return { board: next, accepted: kept.length };
  }
  /**
   * A line said aloud in a live session on this board, by the person or the agent's voice: a step
   * of its history like a drawing, numbered on the same line, so a rewind tells words and ink in
   * the order they came. The shapes stay as they were.
   */
  async said(caller: Caller, boardId: string, line: BoardSaid) {
    caller = this.open(caller);
    const said = parse(saidSchema, line);
    return await this.state.transaction(async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      const next = { ...board, revision: board.revision + 1, updatedAt: now() };
      await this.remember(caller, board, next, [], 'said', tx, said);
      await this.write(next, tx);
      return { revision: next.revision };
    });
  }
  /**
   * The board as it stood just before step `from`, and every step from `from` to `to` in order:
   * shapes drawn and saved, and lines said. Members alone, as history is.
   */
  async rewind(caller: Caller, boardId: string, from: number, to: number): Promise<BoardRewound> {
    caller = this.open(caller);
    return await forRead(this.state, async (tx) => {
      await this.editable(caller, tx);
      const [board] = await this.summary(caller, boardId, tx);
      const rows = await tx.all<HistoryRow>(
        'SELECT revision,actor_id,began_at,kind,shapes,said FROM board_history WHERE board_id=? AND revision BETWEEN ? AND ? ORDER BY revision',
        board.id,
        from,
        to,
      );
      const prior = await tx.all<{ shape: BoardElement }>(
        `SELECT DISTINCT ON (e->>'id') e AS shape
         FROM board_history h
         CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(h.shapes,'jsonb') THEN h.shapes::jsonb ELSE '[]'::jsonb END AS shapes OFFSET 0) decoded,
         jsonb_array_elements(decoded.shapes) e
         WHERE h.board_id=? AND h.revision<? AND h.revision<=?
         ORDER BY e->>'id', h.revision DESC`,
        board.id,
        from,
        to,
      );
      return {
        board,
        before: stacked(prior.map(({ shape }) => shape).filter((el) => !el.isDeleted)),
        steps: rows.map(stepOf),
      };
    });
  }
  /** The board as it stood at a revision, rebuilt from its history, for a picture of it then. */
  async sceneAt(caller: Caller, boardId: string, revision: number): Promise<BoardScene> {
    const { board, before } = await this.rewind(caller, boardId, revision + 1, revision);
    return { board, elements: before };
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
    // A caller already in a transaction (a return landing with its receipt) is joined, not nested.
    const write = <T>(fn: (tx: Transaction) => Promise<T>) =>
      this.state.ambient ? fn(this.state.ambient) : this.state.transaction(fn);
    await write(async (tx) => {
      await this.editable(caller, tx);
      const limit = 1024 ** 3;
      const usage = () =>
        tx.get<{ bytes: string; present: boolean }>(
          'SELECT COALESCE(SUM(octet_length(content)),0) AS bytes, COALESCE(bool_or(file_id=?),false) AS present FROM board_images WHERE project_id=?',
          file,
          caller.projectId,
        );
      let held = (await usage())!;
      if (Number(held.bytes) + (held.present ? 0 : bytes.length) > limit * 0.8) {
        await tx.run(
          `DELETE FROM board_images i WHERE project_id=? AND file_id<>? AND stored_at<?
           AND NOT EXISTS(SELECT 1 FROM board_elements e JOIN boards b ON b.id=e.board_id WHERE b.project_id=i.project_id AND e.file_id=i.file_id)
           AND NOT EXISTS(SELECT 1 FROM board_history_files f WHERE f.project_id=i.project_id AND f.file_id=i.file_id)`,
          caller.projectId,
          file,
          new Date(Date.now() - KEEP_MS).toISOString(),
        );
        held = (await usage())!;
      }
      check(
        Number(held.bytes) + (held.present ? 0 : bytes.length) <= limit,
        'image_quota',
        'Board images use at most 1 GiB per project',
        507,
      );
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
  async draw(
    caller: Caller,
    value: DrawInput,
    images: PlacedImage[] = [],
    agent = !!caller.conversation,
  ): Promise<BoardDrawn> {
    caller = this.open(caller);
    const input = parse(drawSchema, value);
    check(
      input.board || input.title,
      'invalid_board_input',
      'Name a board, or a title for a new one',
    );
    const draw = async (tx: Transaction) => {
      await this.editable(caller, tx);
      let board = input.board
        ? (await this.summary(caller, input.board, tx))[0]
        : await this.created(caller, input.title!, tx);
      if (input.board && input.title && input.title !== board.title) {
        board = { ...board, title: input.title, updatedBy: caller.actorId, updatedAt: now() };
        await this.write(board, tx);
        await recorded(this.state, tx, caller, 'board.set', board.id, { title: board.title });
      }
      // The preferred look is guidance returned to agents, never a drawing constraint.
      const worn = await this.lookOf(caller.projectId, tx);
      const changed = !!input.look && input.look !== worn;
      if (changed) {
        await this.setLook(caller, input.look!, tx);
        await recorded(this.state, tx, caller, 'board.set', board.id, { look: input.look! });
      }
      const look = input.look ?? worn;
      const before = await this.elements(board.id, undefined, tx);
      if (input.paper !== undefined && input.paper !== board.paper) {
        board = {
          ...board,
          paper: input.paper,
          revision: board.revision + 1,
          updatedBy: caller.actorId,
          updatedAt: now(),
        };
        await this.write(board, tx);
        await recorded(this.state, tx, caller, 'board.set', board.id, { paper: input.paper });
      }
      const drawing = new Drawing(before, agent, board.paper);
      const waiting = [...images];
      for (const op of input.ops) {
        if (agent && op.op === 'link' && [op.target].flat().includes(board.id))
          throw new MervError(
            'board_link_to_itself',
            'A link cannot open the board it stands on. For words of your own, use page: text is its title, body what it opens to.',
            400,
          );
        drawing.apply(op, op.op === 'image' ? waiting.shift() : undefined);
      }
      const drawn = drawing.result();
      const merged = drawn.length
        ? await this.merge(caller, board, drawn, 'draw', tx)
        : { board, accepted: 0 };
      const region = bounds(drawn.map(rectOf));
      const standing = new Set(before.map((el) => el.id));
      return {
        board: this.dressed(merged.board, look),
        created: drawing.created,
        changed: merged.accepted,
        ...(drawing.proposal && { proposal: drawing.proposal }),
        ...drawing.report(),
        ...(region && { region }),
        penMs: penMs(penUnits(drawn, (el) => standing.has(el))),
        // A look just put on comes with its sheet; one already worn is known.
        ...(changed && { look: lookSheet(LOOKS[input.look!]) }),
      };
    };
    // A return and its drawing commit together, through the usual board tool.
    const tx = this.state.ambient;
    return tx ? draw(tx) : this.state.transaction(draw);
  }
  /**
   * Board outcomes were retired on 2026-11-18 for page cards (founder's ruling). Each outcome still
   * kept in the read-only board_outcomes becomes a page card on its own board, titled the same with
   * its whole text, in the board's next free place; board_outcome_pages remembers which were moved,
   * so this runs at every start and moves each once. Answers how many it moved now.
   */
  async pageOutcomes(): Promise<number> {
    const waiting = await this.state.transaction((tx) =>
      tx.all<{ board_id: string; id: string }>(
        `SELECT o.board_id,o.id FROM board_outcomes o JOIN boards b ON b.id=o.board_id
         WHERE NOT EXISTS(SELECT 1 FROM board_outcome_pages p WHERE p.board_id=o.board_id AND p.outcome_id=o.id)
         ORDER BY o.board_id,o.record::jsonb->>'createdAt',o.id`,
      ),
    );
    let moved = 0;
    for (const { board_id, id } of waiting) {
      try {
        if (await this.state.transaction((tx) => this.pageOutcome(board_id, id, tx))) moved++;
      } catch (error) {
        // A full board keeps its outcome where it is, to move at the next start.
        console.error(
          `board: outcome ${id} on ${board_id} stays unmoved: ${(error as Error).message}`,
        );
      }
    }
    return moved;
  }
  private async pageOutcome(boardId: string, outcomeId: string, tx: Transaction): Promise<boolean> {
    // The board's row is held first, so two starting servers never move one outcome twice.
    const row = await tx.get<{ project_id: string; record: string }>(
      'SELECT project_id,record FROM boards WHERE id=? FOR UPDATE',
      boardId,
    );
    const outcome = await tx.get<{ record: string; text: string }>(
      `SELECT record,text FROM board_outcomes o WHERE board_id=? AND id=?
         AND NOT EXISTS(SELECT 1 FROM board_outcome_pages p WHERE p.board_id=o.board_id AND p.outcome_id=o.id)`,
      boardId,
      outcomeId,
    );
    if (!row || !outcome) return false;
    const { look: _worn, ...stored } = JSON.parse(row.record) as BoardSummary;
    const board = stored as BoardSummary;
    const record = JSON.parse(outcome.record) as {
      title?: string;
      createdBy?: string;
      updatedBy?: string;
    };
    const caller: Caller = {
      projectId: row.project_id,
      actorId: record.updatedBy ?? record.createdBy ?? board.createdBy,
    };
    const name = (record.title ?? '').trim() || 'Outcome';
    const parts = pagesOf(outcome.text, PAGE_CHARS);
    // Built here rather than parsed, so the text is kept to the character, its edges included.
    const ops: DrawOp[] = parts.map((body, at) => ({
      op: 'page',
      key: `outcome${at}`,
      text: parts.length > 1 ? `${name.slice(0, 190)} (${at + 1}/${parts.length})` : name,
      body: body.trim() ? body : name,
    }));
    const drawing = new Drawing(await this.elements(boardId, undefined, tx), false, board.paper);
    for (const op of ops) drawing.apply(op);
    await this.merge(caller, board, drawing.result(), 'draw', tx);
    await tx.run(
      'INSERT INTO board_outcome_pages(board_id,outcome_id,elements,moved_at) VALUES(?,?,?,?)',
      boardId,
      outcomeId,
      JSON.stringify(Object.values(drawing.created)),
      now(),
    );
    return true;
  }
}

/** A text cut into bodies of at most `most` characters, at a line's end where there is one. */
export function pagesOf(text: string, most: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > most) {
    const end = rest.lastIndexOf('\n', most);
    const cut = end > most / 2 ? end + 1 : most;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return [...parts, rest];
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
