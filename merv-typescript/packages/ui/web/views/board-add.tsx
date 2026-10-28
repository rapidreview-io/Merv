/**
 * Adding to a board: the + at the end of Excalidraw's shape toolbar, and the search it opens over
 * the project's boards and files, or a web address typed in. One pick is a card for it; several
 * picked together (the circle, or a click with Shift or ⌘) are one card that holds them all.
 * Board draws the card (board.write link), so a person's card and an agent's are the same shapes.
 */
import { useEffect, useRef, useState } from 'react';
import type { BoardSummary } from '@merv/board/models';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import { useTool } from '../api';
import { SearchField, useDismiss } from '../components';
import { Icon } from '../icons';
import { bytes, fileType } from './artifacts';

/** What a card is drawn for: what it opens, its title, its one fact and the app's glyph for it. */
export interface CardPick {
  target: string;
  text: string;
  fact?: string;
  icon: string;
}

export const AddButton = ({ onClick }: { onClick(): void }) => (
  <button
    key="merv-add"
    type="button"
    className="ToolIcon_type_button ToolIcon_size_medium ToolIcon board-add"
    title="Add a board, file or link"
    aria-label="Add a board, file or link"
    onClick={onClick}
  >
    <div className="ToolIcon__icon" aria-hidden="true">
      <Icon name="plus" size={18} />
    </div>
  </button>
);

const webPick = (address: string): CardPick[] => {
  try {
    const url = new URL(address);
    if (!/^https?:$/.test(url.protocol)) return [];
    return [
      { target: url.href, text: `${url.host}${url.pathname}`.replace(/\/$/, ''), icon: 'link' },
    ];
  } catch {
    return [];
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
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CardPick[]>([]);
  const [name, setName] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, box, close, true);
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const files = useTool<Artifact[]>('artifact.read:list', { limit: 200 });
  const search = query.trim().toLowerCase();
  const web = webPick(query.trim());
  const rows = web.length
    ? web
    : [
        ...(boards.data?.boards ?? [])
          .filter((b) => b.id !== board)
          .map((b) => ({ target: b.id, text: b.title, fact: 'Board', icon: 'boards' })),
        ...(files.data ?? []).map((f) => ({
          target: f.id,
          text: f.title,
          fact: `${fileType(f).label} · ${bytes(f.size)}`,
          icon: 'file',
        })),
      ]
        .filter((row) => row.text.toLowerCase().includes(search))
        .slice(0, 50);
  const at = Math.min(active, rows.length - 1);
  useEffect(() => setActive(0), [search]);
  const isPicked = (row: CardPick) => picked.some((p) => p.target === row.target);
  const toggle = (row: CardPick) =>
    setPicked((now) =>
      now.some((p) => p.target === row.target)
        ? now.filter((p) => p.target !== row.target)
        : [...now, row],
    );
  const finish = (picks: CardPick[]) =>
    add(picks, name.trim() || `${picks[0]!.text} and ${picks.length - 1} more`);
  const choose = (row: CardPick, many: boolean) =>
    many || picked.length ? toggle(row) : finish([row]);
  return (
    <div className="board-add-panel finder-panel" ref={box} role="dialog" aria-label="Add to board">
      <SearchField
        label="Find a board or file, or paste a web address"
        placeholder="Board, file or link"
        value={query}
        onChange={setQuery}
        autoFocus
        onKeyDown={(event) => {
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          if (step) {
            event.preventDefault();
            setActive(Math.max(0, Math.min(rows.length - 1, at + step)));
          } else if (event.key === 'Enter' && (picked.length || rows[at])) {
            event.preventDefault();
            if (picked.length) finish(picked);
            else choose(rows[at]!, event.shiftKey || event.metaKey);
          }
        }}
      />
      <div className="finder-list" role="listbox" aria-label="Boards and files">
        {rows.map((row, index) => (
          <div
            key={row.target}
            role="option"
            aria-selected={index === at}
            className="finder-row board-add-row"
            onMouseMove={() => index !== at && setActive(index)}
            onClick={(event) => choose(row, event.shiftKey || event.metaKey || event.ctrlKey)}
          >
            <button
              type="button"
              className={`board-add-check${isPicked(row) ? ' is-picked' : ''}`}
              aria-label={`${isPicked(row) ? 'Leave out' : 'Pick'} ${row.text}`}
              onClick={(event) => {
                event.stopPropagation();
                toggle(row);
              }}
            >
              {isPicked(row) && <Icon name="check" size={12} />}
            </button>
            <Icon name={row.icon} size={14} />
            <span className="finder-name">{row.text}</span>
            {row.fact && <span className="finder-when">{row.fact}</span>}
          </div>
        ))}
        {boards.data && files.data && rows.length === 0 && (
          <p className="finder-none">No board or file matches. Paste a web address to link it.</p>
        )}
      </div>
      {picked.length > 0 && (
        <div className="board-add-foot">
          {picked.length > 1 && (
            <input
              className="input"
              aria-label="Name this card"
              placeholder={`${picked[0]!.text} and ${picked.length - 1} more`}
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          )}
          <button type="button" className="btn" onClick={() => finish(picked)}>
            {picked.length > 1 ? `Add ${picked.length} as one card` : 'Add card'}
          </button>
        </div>
      )}
    </div>
  );
}
