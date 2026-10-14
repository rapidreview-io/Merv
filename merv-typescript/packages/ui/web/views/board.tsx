/**
 * Boards: the project's whiteboards (founder, 2026-10-09). The list is the row's page; a board
 * opens as the whole page, its title on one line with ← back and ⋯, and the canvas under it. The
 * canvas is Excalidraw, loaded only when a board opens (board-canvas.tsx).
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BoardScene, BoardSummary } from '@merv/board/models';
import { call, refreshTools, useTool } from '../api';
import { Ago, LoadState, useDismiss } from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { BackLink } from '../trail';
import { useSession } from '../session';
import { useActorNames } from './people';
import type { ViewProps } from './index';

const Canvas = lazy(() => import('./board-canvas'));
const MAX = Number.MAX_SAFE_INTEGER;

function BoardList({ row }: ViewProps) {
  const navigate = useNavigate();
  const read = useTool<{ boards: BoardSummary[] }>('board.read', {}, { every: 15000 });
  const nameOf = useActorNames();
  const { actor } = useSession();
  const filter = useListFilter(read.data?.boards, {
    mine: (b) => b.createdBy === actor.id,
    labels: (b) => [b.title, nameOf(b.createdBy)],
    ids: (b) => [b.id, b.createdBy],
  });
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const made = await call<{ board: BoardSummary }>('board.draw', {
      title: 'Untitled board',
    }).catch(() => null);
    setBusy(false);
    if (!made) return;
    refreshTools('board.read');
    navigate(`${row.path}/${made.board.id}`);
  };
  return (
    <ListPage
      load={{ ...read, data: read.data?.boards }}
      noun="boards"
      placeholder="Title or person"
      filter={filter}
      opens
      end={
        <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'New board'}
        </button>
      }
      emptyTitle="No boards"
      emptyHint="Start one to sketch an idea, or ask Pi to draw one with you."
      line={(b) => ({
        name: <strong>{b.title}</strong>,
        standing: (
          <span className="file-meta">
            <span className="file-keeper">{nameOf(b.createdBy)}</span>
            <Ago at={b.updatedAt} />
          </span>
        ),
      })}
    />
  );
}

function BoardMenu({ board, rename }: { board: BoardSummary; rename(): void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  useEffect(() => void (open || setSure(false)), [open]);
  const archive = async () => {
    if (!sure) return setSure(true);
    await call('board.set', { id: board.id, archived: true });
    refreshTools('board.read');
    navigate('/boards');
  };
  return (
    <div className="file-menu" ref={box}>
      <button
        type="button"
        className="btn-icon file-menu-open"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="file-menu-panel" role="menu">
          <p className="file-menu-facts">
            Updated <Ago at={board.updatedAt} />
          </p>
          <button
            type="button"
            role="menuitem"
            className="file-menu-item"
            onClick={() => (setOpen(false), rename())}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="file-menu-item"
            onClick={() => void archive().catch(() => undefined)}
          >
            {sure ? 'Archive: press again' : 'Archive board'}
          </button>
        </div>
      )}
    </div>
  );
}

function BoardTitle({
  board,
  editing,
  done,
}: {
  board: BoardSummary;
  editing: boolean;
  done(): void;
}) {
  const [draft, setDraft] = useState(board.title);
  useEffect(() => setDraft(board.title), [board.title, editing]);
  const save = async () => {
    done();
    const title = draft.trim();
    if (title && title !== board.title) {
      await call('board.set', { id: board.id, title }).then(
        () => refreshTools('board.read', 'board.scene'),
        () => undefined,
      );
    }
  };
  if (!editing)
    return (
      <h1 className="file-page-title" title={board.title}>
        <span className="file-title">{board.title}</span>
      </h1>
    );
  return (
    <input
      className="input board-title-input"
      aria-label="Board title"
      autoFocus
      value={draft}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void save();
        if (event.key === 'Escape') done();
      }}
    />
  );
}

function BoardPage({ row }: ViewProps) {
  const { id = '' } = useParams();
  // The board alone: no shape changed after a revision this high, so none is read or sent.
  const read = useTool<BoardScene>('board.scene', { id, since: MAX }, { every: 10000 });
  const [editing, setEditing] = useState(false);
  const board = read.data?.board;
  useEffect(() => {
    if (board) document.title = `${board.title} · Merv`;
  }, [board]);
  if (!board)
    return (
      <div className="page-stage">
        <LoadState {...read} back={{ to: row.path, label: 'Boards' }} />
      </div>
    );
  return (
    <div className="board-page">
      <header className="file-page-head board-page-head">
        <BackLink home={row.path} label="Boards" />
        <BoardTitle board={board} editing={editing} done={() => setEditing(false)} />
        <BoardMenu board={board} rename={() => setEditing(true)} />
      </header>
      <Suspense fallback={<p className="muted board-loading">Opening the board…</p>}>
        <Canvas key={board.id} id={board.id} />
      </Suspense>
    </div>
  );
}

export const BoardsView = splitRoutes(BoardList, BoardPage, false);
