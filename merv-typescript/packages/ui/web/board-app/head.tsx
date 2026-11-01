/** A board's one line: its title, which is the way to any other board, and its menu. */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BoardSummary } from '@merv/board/models';
import { call, refreshTools, useTool } from '../api';
import { Ago, SearchField, useDismiss, useMoreMenu } from '../components';
import { Icon } from '../icons';
import { useSession } from '../session';
import { onWorn, wear, worn } from '../theme';
import { asksToAdd } from '../views/board-add';
import { BoardTitle } from '../views/board';
import { OutcomeWord, useOutcomes } from '../views/board-outcome';
import { newBoard } from './app';

/** Past this many boards the list gets a search. */
const FEW = 8;

function Switcher({ current, close }: { current: string; close(): void }) {
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const read = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const [query, setQuery] = useState('');
  const [making, setMaking] = useState(false);
  useDismiss(true, box, close, true);
  const all = read.data?.boards ?? [];
  const search = query.trim().toLowerCase();
  const rows = all.filter((board) => board.title.toLowerCase().includes(search));
  const open = (id: string) => {
    close();
    navigate(`/boards/${id}`);
  };
  const start = () => {
    setMaking(true);
    void newBoard().then(open, () => setMaking(false));
  };
  // The arrows go through the rows; the first is what opens the panel's keys.
  const keys = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  };
  useEffect(() => box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(), [!read.data]);
  return (
    <div className="boards-sheet" ref={box} role="dialog" aria-label="Boards" onKeyDown={keys}>
      {all.length > FEW && (
        <SearchField label="Find a board" placeholder="Title" value={query} onChange={setQuery} />
      )}
      <div className="boards-list" role="listbox" aria-label="Boards">
        <button type="button" role="option" aria-selected={false} className="boards-row boards-new" disabled={making} onClick={start}>
          <Icon name="plus" size={16} />
          New board
        </button>
        {rows.map((board) => (
          <button
            key={board.id}
            type="button"
            role="option"
            aria-selected={board.id === current}
            className="boards-row"
            onClick={() => open(board.id)}
          >
            <span className="boards-title">{board.title}</span>
            <Ago at={board.updatedAt} />
          </button>
        ))}
      </div>
    </div>
  );
}

function BoardMenu({
  board,
  outcomes,
  rename,
  talk,
}: {
  board: BoardSummary;
  outcomes: ReturnType<typeof useOutcomes>;
  rename(): void;
  talk(): void;
}) {
  const navigate = useNavigate();
  const { signOut, account } = useSession();
  const theme = useSyncExternalStore(onWorn, worn);
  const { open, close, item, menu } = useMoreMenu();
  const [sure, setSure] = useState(false);
  const [link, setLink] = useState('');
  useEffect(() => void (open || setSure(false)), [open]);
  const archive = async () => {
    if (!sure) return setSure(true);
    close();
    await call('board.set', { id: board.id, archived: true });
    refreshTools('board.read');
    navigate('/');
  };
  const share = async (revoke: boolean) => {
    const result = await call<{ token?: string }>('board.share', { id: board.id, revoke });
    const url = result.token ? `${location.origin}/ui/board-share#${result.token}` : '';
    setLink(url);
    if (url) await navigator.clipboard?.writeText(url).catch(() => undefined);
  };
  return menu(
    <>
      {item('Rename', () => (close(), rename()))}
      {item('Conversation', () => (close(), talk()))}
      {!outcomes.lines.length &&
        item('Outcome', () => (close(), void outcomes.fresh().catch(() => undefined)))}
      {link
        ? item('Revoke link', () => void share(true).catch(() => undefined))
        : item('Copy watch link', () => void share(false).catch(() => undefined))}
      {link && (
        <p className="file-menu-facts board-menu-note" role="status">
          Copied. Anyone with it can watch this board, erased work too.
        </p>
      )}
      {item(`Theme · ${theme}`, () => wear(theme === 'dark' ? 'light' : 'dark'))}
      {account.kind === 'user' && item('Sign out', signOut)}
      {item(sure ? 'Archive: press again' : 'Archive', () => void archive().catch(() => undefined))}
    </>,
  );
}

export function BoardHead({
  board,
  outcomes,
  talk,
}: {
  board: BoardSummary;
  outcomes: ReturnType<typeof useOutcomes>;
  talk(): void;
}) {
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState(false);
  // ⌘K goes to another board from anywhere but a field being written in; the + has its own button.
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      if (!asksToAdd(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setSwitching((now) => !now);
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, []);
  return (
    <header className="board-line">
      <div className="board-line-title">
        {editing ? (
          <BoardTitle board={board} editing done={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            className="board-switch"
            aria-haspopup="dialog"
            aria-expanded={switching}
            onClick={() => setSwitching(!switching)}
          >
            <span>{board.title}</span>
            <Icon name="chevrons" size={16} />
          </button>
        )}
        {switching && <Switcher current={board.id} close={() => setSwitching(false)} />}
      </div>
      <span className="board-line-end">
        {outcomes.lines.length > 0 && <OutcomeWord place={outcomes} />}
        <BoardMenu board={board} outcomes={outcomes} rename={() => setEditing(true)} talk={talk} />
      </span>
    </header>
  );
}
