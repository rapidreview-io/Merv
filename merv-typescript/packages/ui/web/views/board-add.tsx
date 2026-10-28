/**
 * Adding to a board: the + at the end of Excalidraw's shape toolbar, and the panel it opens. Its
 * tabs say what is added (a board, a file, a collection of them, a web link), and each lists what
 * there is, newest first, with chips that narrow it by kind and, on a long list, a search. A board or a
 * file is added at a click; a collection gathers what is picked into one card that holds them all.
 * Board draws the card (board.write link), so a person's card and an agent's are the same shapes.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BoardSummary } from '@merv/board/models';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import { useTool } from '../api';
import { SearchField, relativeTime, useDismiss } from '../components';
import { Icon } from '../icons';
import { Chips, Tabs, matches } from '../list-filters';
import { bytes, fileType, type FileType } from './artifacts';

/** What a card is drawn for: what it opens, its title and its one fact. */
export interface CardPick {
  target: string;
  text: string;
  fact?: string;
}
/** A row of the panel: the card it adds, the kind its chips narrow by, and how it is shown. */
type Row = CardPick & { kind: string; icon: string; meta: string };

export const AddButton = ({ onClick }: { onClick(): void }) => (
  <button
    key="merv-add"
    type="button"
    className="ToolIcon_type_button ToolIcon_size_medium ToolIcon board-add"
    title="Add a board, file, collection or link"
    aria-label="Add a board, file, collection or link"
    onClick={onClick}
  >
    <div className="ToolIcon__icon" aria-hidden="true">
      <Icon name="plus" size={18} />
    </div>
  </button>
);

type Adding = 'boards' | 'files' | 'collection' | 'link';
/** The tab last added from, which the next + opens on. */
let lastTab: Adding = 'boards';
const EMPTY: Record<Adding, string> = {
  boards: 'No other boards in this project yet.',
  files: 'No files in this project yet.',
  collection: 'No boards or files to collect yet.',
  link: '',
};
/** The kind of file each chip stands for, by how the file is read. */
const FAMILY: Record<FileType['reads'], string> = {
  markdown: 'Documents',
  pdf: 'Documents',
  html: 'Documents',
  text: 'Documents',
  json: 'Data',
  jsonl: 'Data',
  csv: 'Data',
  tsv: 'Data',
  image: 'Images',
  mermaid: 'Images',
  code: 'Code',
  notebook: 'Code',
};
const KINDS = ['Boards', 'Documents', 'Data', 'Images', 'Code'];
/** A list this short is read at a glance, so it has no search. */
const FEW = 8;

const webPick = (address: string): CardPick | undefined => {
  try {
    const url = new URL(address);
    if (/^https?:$/.test(url.protocol))
      return { target: url.href, text: `${url.host}${url.pathname}`.replace(/\/$/, '') };
  } catch {
    // Not an address yet.
  }
};

export function CardPicker({
  board,
  close,
  add,
}: {
  board: string;
  close(): void;
  add(picks: CardPick[], name: string): void;
}) {
  const [tab, setTab] = useState(lastTab);
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<CardPick[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, box, close, true);
  // The panel takes the keys as it opens, unless a field of it already took them (Link's address).
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus();
  }, []);
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const files = useTool<Artifact[]>('artifact.read:list', { limit: 200 });
  const boardRows: Row[] = (boards.data?.boards ?? [])
    .filter((b) => b.id !== board)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((b) => ({
      target: b.id,
      text: b.title,
      fact: 'Board',
      kind: 'Boards',
      icon: 'boards',
      meta: `Edited ${relativeTime(b.updatedAt)}`,
    }));
  const fileRows: Row[] = (files.data ?? []).map((f) => {
    const type = fileType(f);
    const fact = `${type.label} · ${bytes(f.size)}`;
    return {
      target: f.id,
      text: f.title,
      fact,
      kind: FAMILY[type.reads],
      icon: type.icon,
      meta: fact,
    };
  });
  const all = {
    boards: boardRows,
    files: fileRows,
    collection: [...boardRows, ...fileRows],
    link: [],
  }[tab];
  const kinds = KINDS.map((value) => ({
    value,
    label: value,
    count: all.filter((row) => row.kind === value).length,
  })).filter((choice) => choice.count);
  const search = query.trim().toLowerCase();
  const rows = all.filter(
    (row) => (!kind || row.kind === kind) && matches(search, [row.text, row.meta], [row.target]),
  );
  const at = Math.min(active, rows.length - 1);
  useEffect(() => setActive(0), [tab, kind, search]);
  const web = webPick(address.trim());
  const isPicked = (row: CardPick) => picked.some((p) => p.target === row.target);
  const finish = (picks: CardPick[], label = '') => {
    lastTab = tab;
    add(picks, label);
  };
  const choose = (row: Row) =>
    tab !== 'collection'
      ? finish([row])
      : setPicked((now) => {
          const kept = now.filter((p) => p.target !== row.target);
          return kept.length < now.length ? kept : [...now, row];
        });
  const open = (next: Adding) => {
    setTab(next);
    setKind('');
    setQuery('');
  };
  // Arrows walk the list wherever the focus is but a field being written in; Enter adds the row
  // they reached from the search, the list (Tab reaches it) or the panel itself; a letter typed at
  // the panel starts a search.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const searching =
      target === box.current ||
      !!target.closest('.search') ||
      target.getAttribute('role') === 'listbox';
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step && (searching || !(target instanceof HTMLInputElement))) {
      event.preventDefault();
      setActive(Math.max(0, Math.min(rows.length - 1, at + step)));
    } else if (event.key === 'Enter' && searching && rows[at]) {
      event.preventDefault();
      choose(rows[at]!);
    } else if (target === box.current && event.key.length === 1 && !event.metaKey && !event.ctrlKey)
      box.current.querySelector<HTMLInputElement>('.search input')?.focus();
  };
  const unnamed = picked.length > 1 ? `${picked[0]!.text} and ${picked.length - 1} more` : 'Name';
  return (
    <div
      className="board-add-panel finder-panel"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label="Add to board"
      onKeyDown={keys}
    >
      <Tabs
        label="What to add"
        options={[
          { value: 'boards', label: 'Boards', count: boards.data && boardRows.length },
          { value: 'files', label: 'Files', count: files.data && fileRows.length },
          { value: 'collection', label: 'Collection' },
          { value: 'link', label: 'Link' },
        ]}
        value={tab}
        onChange={open}
      />
      {tab === 'link' ? (
        <form
          className="board-add-link"
          onSubmit={(event) => {
            event.preventDefault();
            if (web) finish([{ ...web, text: title.trim() || web.text }]);
          }}
        >
          <input
            className="input"
            type="url"
            aria-label="Web address"
            placeholder="https://"
            value={address}
            autoFocus
            onChange={(event) => setAddress(event.target.value)}
          />
          <input
            className="input"
            aria-label="Title"
            placeholder={web?.text ?? 'Title'}
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit" className="btn" disabled={!web}>
            Add link
          </button>
        </form>
      ) : (
        <>
          {(kinds.length > 1 || all.length > FEW) && (
            <div className="board-add-filters">
              {kinds.length > 1 && (
                <Chips
                  label="Kind"
                  options={kinds}
                  value={kind}
                  onChange={(value) => setKind(kind === value ? '' : value)}
                />
              )}
              {all.length > FEW && (
                <SearchField
                  label={`Search ${tab === 'collection' ? 'boards and files' : tab}`}
                  value={query}
                  onChange={setQuery}
                />
              )}
            </div>
          )}
          <div
            className="finder-list"
            role="listbox"
            tabIndex={0}
            aria-label={tab === 'collection' ? 'Boards and files' : tab}
            aria-multiselectable={tab === 'collection'}
          >
            {rows.map((row, index) => (
              <div
                key={row.target}
                role="option"
                aria-selected={index === at}
                aria-checked={tab === 'collection' ? isPicked(row) : undefined}
                className="finder-row board-add-row"
                onMouseMove={() => index !== at && setActive(index)}
                onClick={() => choose(row)}
              >
                {tab === 'collection' && (
                  <span className={`board-add-check${isPicked(row) ? ' is-picked' : ''}`}>
                    {isPicked(row) && <Icon name="check" size={12} />}
                  </span>
                )}
                <Icon name={row.icon} size={14} />
                <span className="finder-name">{row.text}</span>
                <span className="finder-when">{row.meta}</span>
              </div>
            ))}
            {boards.data && files.data && rows.length === 0 && (
              <p className="finder-none">{all.length ? 'Nothing matches.' : EMPTY[tab]}</p>
            )}
          </div>
          {tab === 'collection' && (
            <div className="board-add-foot">
              <input
                className="input"
                aria-label="Name this collection"
                placeholder={unnamed}
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={picked.length < 2}
                onClick={() => finish(picked, name.trim() || unnamed)}
              >
                {picked.length < 2 ? 'Pick two or more' : `Add ${picked.length} as one card`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
