/**
 * Boards: the project's whiteboards (founder, 2026-10-09). The list is the row's page; a board
 * opens as the whole page, its title on one line with ← back and ⋯, and the canvas under it. The
 * canvas is Excalidraw, loaded only when a board opens (board-canvas.tsx).
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BoardScene, BoardSummary } from '@merv/board/models';
import { call, refreshTools, useTool } from '../api';
import { Ago, PageLoad, useMoreMenu } from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { BackLink } from '../trail';
import { useSession } from '../session';
import { useActorNames } from './people';
import { OutcomePane, OutcomeWord, useOutcomes } from './board-outcome';
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
    const made = await call<{ board: BoardSummary }>('board.write:draw', {
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
  const { open, close, item, menu } = useMoreMenu();
  const [sure, setSure] = useState(false);
  useEffect(() => void (open || setSure(false)), [open]);
  const archive = async () => {
    if (!sure) return setSure(true);
    await call('board.set', { id: board.id, archived: true });
    refreshTools('board.read');
    navigate('/boards');
  };
  return menu(
    <>
      <p className="file-menu-facts">
        Updated <Ago at={board.updatedAt} />
      </p>
      <p className="file-menu-facts board-menu-note">
        History on: project members can replay this board, erased work too.
      </p>
      {item('Rename', () => (close(), rename()))}
      {item(
        sure ? 'Archive: press again' : 'Archive board',
        () => void archive().catch(() => undefined),
      )}
    </>,
  );
}

export function BoardTitle({
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

function BoardShare({ board }: { board: BoardSummary }) {
  const { actor } = useSession();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const change = async (revoke: boolean) => {
    setBusy(true);
    try {
      const result = await call<{ token?: string }>('board.share', { id: board.id, revoke });
      const url = result.token ? `${location.origin}/ui/board-share#${result.token}` : '';
      setLink(url);
      setMessage(
        revoke
          ? 'Link revoked'
          : 'Anyone with this link can view this board and its history, including erased work.',
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (board.createdBy !== actor.id) return null;
  return (
    <details className="board-share">
      <summary>Share</summary>
      <div className="board-share-menu">
        <button className="btn-text" disabled={busy} onClick={() => void change(false)}>
          Make a new link
        </button>
        <button className="btn-text" disabled={busy} onClick={() => void change(true)}>
          Revoke link
        </button>
        {link && (
          <input
            className="input"
            aria-label="Share link"
            value={link}
            readOnly
            onFocus={(event) => event.target.select()}
          />
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  );
}

/**
 * One board and what stands beside it, whatever its title line: the canvas, and the outcome pane.
 * `head` draws the line, handed the board and its outcomes.
 */
export function BoardStage({
  id,
  head,
  back,
  title = (board) => `${board.title} · Merv`,
  children,
  beside,
}: {
  id: string;
  head(board: BoardSummary, outcomes: ReturnType<typeof useOutcomes>): ReactNode;
  back?: { to: string; label: string };
  title?(board: BoardSummary): string;
  /** Over the canvas, and in a column of its own beside it. */
  children?(board: BoardSummary): ReactNode;
  beside?(outcomes: ReturnType<typeof useOutcomes>): ReactNode;
}) {
  // The board alone: no shape changed after a revision this high, so none is read or sent.
  const read = useTool<BoardScene>('board.scene', { id, since: MAX }, { every: 10000 });
  const board = read.data?.board;
  const outcomes = useOutcomes(id, read.data?.outcomes);
  useEffect(() => {
    if (board) document.title = title(board);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);
  if (!board) return <PageLoad {...read} back={back} />;
  const { shown, full } = outcomes;
  return (
    <div className="board-page">
      <div
        className="board-plane"
        data-outcome={shown ? '' : undefined}
        data-full={shown && full ? '' : undefined}
      >
        <div className="board-main">
          {head(board, outcomes)}
          <Suspense fallback={<p className="muted board-loading">Opening the board…</p>}>
            <Canvas key={board.id} id={board.id} onOutcomes={outcomes.report} />
          </Suspense>
          {children?.(board)}
        </div>
        {shown && <OutcomePane key={shown} board={board.id} place={outcomes} />}
        {beside?.(outcomes)}
      </div>
    </div>
  );
}

function BoardPage({ row }: ViewProps) {
  const { id = '' } = useParams();
  const [editing, setEditing] = useState(false);
  return (
    <BoardStage
      id={id}
      back={{ to: row.path, label: 'Boards' }}
      head={(board, outcomes) => (
        <header className="file-page-head board-page-head">
          <BackLink home={row.path} label="Boards" />
          <BoardTitle board={board} editing={editing} done={() => setEditing(false)} />
          <OutcomeWord place={outcomes} />
          <BoardShare board={board} />
          <BoardMenu board={board} rename={() => setEditing(true)} />
        </header>
      )}
    />
  );
}

export const BoardsView = splitRoutes(BoardList, BoardPage, false);
