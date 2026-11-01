/**
 * Bringing things onto a board: the + at the end of Excalidraw's shape toolbar, or ⌘K, and the panel
 * they open. Its tabs say what is added (a board, a file, a record, a collection of them, a web
 * link), and each lists what there is, most recent first, with chips that narrow it by kind and, on
 * a long list, a search. What is chosen is added at a click or Enter; a file dropped on the panel or
 * uploaded from it is kept in the project's Files and added too; a collection gathers what is picked
 * into one card that holds them all. Board draws each one (board.write), so what a person adds and
 * what an agent adds are the same shapes: a card, or for a JPEG, PNG or WebP the picture itself.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { BoardSummary } from '@merv/board/models';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import type { PaperCitation } from '@merv/paper/models';
import { isResolution } from '@merv/tasks/resolution';
import { call, readOnly, useTool } from '../api';
import { SearchField, relativeTime, useDismiss, words } from '../components';
import { Icon } from '../icons';
import { Chips, Tabs, matches } from '../list-filters';
import { useCurrent } from '../mutations';
import { NotSession, readTranscript } from '@merv/board/transcript';
import { bytes, fileType, MAX_FILE, refusalOf, storeFile, type FileType } from './artifacts';
import { newest, useHome } from './map-data';
import { speech } from '../speech';

/** What is drawn for one thing added: what it opens (several, for a collection), its title and fact. */
export interface CardPick {
  target: string | string[];
  text: string;
  fact?: string;
  /** A file the board can show: it lands as the picture, and as a card should that fail. */
  picture?: boolean;
}
/** A row of the panel: the one thing it adds, its kind for the chips, how it is shown, how recent. */
type Row = CardPick & { target: string; kind: string; icon: string; meta: string; at: string };

/** The key that opens the panel: ⌘K, or Ctrl+K elsewhere. */
export const asksToAdd = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
) =>
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  event.key.toLowerCase() === 'k';
const ADD_KEY = /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

export const AddButton = ({ onClick }: { onClick(): void }) => (
  <button
    key="merv-add"
    type="button"
    className="ToolIcon_type_button ToolIcon_size_medium ToolIcon board-add"
    title={
      speech.boardOnly
        ? 'Add a board or link'
        : `Add a board, file, record, collection or link — ${ADD_KEY}`
    }
    aria-label={
      speech.boardOnly ? 'Add a board or link' : 'Add a board, file, record, collection or link'
    }
    onClick={onClick}
  >
    <div className="ToolIcon__icon" aria-hidden="true">
      <Icon name="plus" size={18} />
    </div>
  </button>
);

const TABS = ['boards', 'files', 'records', 'collection', 'link'] as const;
type Adding = (typeof TABS)[number];
/** The tab last added from, which the panel next opens on. */
let lastTab: Adding = 'boards';
const EMPTY: Record<Adding, string> = {
  boards: 'No other boards yet.',
  files: 'No files in this project yet.',
  records: 'No tasks, experiments or papers in this project yet.',
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
const KINDS = ['Boards', 'Documents', 'Data', 'Images', 'Code', 'Tasks', 'Experiments', 'Papers'];
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

/** What Board can draw as a picture; any other image stays a card. */
const PICTURED = /^image\/(jpeg|png|webp)\s*(;|$)/i;
/** The most of a file read to see whether it is an agent's session. */
const MOST_SESSION = 512 * 1024 * 1024;
/**
 * An agent's session goes as its steps with secret-shaped values replaced, made here, so the raw
 * file never leaves this machine; any other file goes as it is.
 */
export const sessionOf = async (file: File): Promise<File> => {
  if (!/\.jsonl$/i.test(file.name) || file.size > MOST_SESSION) return file;
  let session;
  try {
    session = readTranscript(await file.text());
  } catch (error) {
    // What is no session goes as any file; a session that cannot be read never goes raw.
    if (error instanceof NotSession) return file;
    throw error;
  }
  const name = file.name.replace(/\.jsonl$/i, '');
  return new File([JSON.stringify(session)], `${name} agent session.json`, {
    type: 'application/json',
  });
};
const fileRow = (file: Artifact): Row => {
  const type = fileType(file);
  const fact = `${type.label} · ${bytes(file.size)}`;
  return {
    target: file.id,
    text: file.title,
    fact,
    kind: FAMILY[type.reads],
    icon: type.icon,
    meta: fact,
    at: file.createdAt,
    ...(PICTURED.test(file.mediaType) && { picture: true }),
  };
};
const workRow = (
  kind: string,
  fact: string,
  target: string,
  text: string,
  { state, updatedAt }: { state: string; updatedAt: string },
): Row => ({
  target,
  text,
  fact,
  kind,
  icon: 'work',
  meta: `${fact} · ${words(state)}`,
  at: updatedAt,
});
const ARTICLE: Record<string, string> = {
  arxiv: 'https://arxiv.org/abs/',
  doi: 'https://doi.org/',
};
/**
 * A paper the project cites. A citation is no record a card can name by id (nothing resolves it),
 * so its card opens the paper itself, and one that says nowhere to open is not listed.
 */
const paperRow = ({ url, identifier, title, year, updatedAt }: PaperCitation): Row[] => {
  const colon = identifier.indexOf(':');
  const article = ARTICLE[identifier.slice(0, colon)];
  const target = url ?? (article && article + identifier.slice(colon + 1));
  return target && /^https?:\/\//.test(target)
    ? [
        {
          target,
          text: title,
          fact: 'Paper',
          kind: 'Papers',
          icon: 'paper',
          meta: `Paper${year ? ` · ${year}` : ''}`,
          at: updatedAt,
        },
      ]
    : [];
};

export function CardPicker({
  board,
  close,
  add,
}: {
  board: string;
  close(): void;
  add(items: CardPick[]): void;
}) {
  // Files, and what is gathered from them, exist where something keeps files.
  const keepsFiles = !speech.boardOnly;
  const [tab, setTab] = useState(keepsFiles ? lastTab : lastTab === 'link' ? 'link' : 'boards');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Row[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);
  /** What is being uploaded, or why it was not. The panel holds on to its upload until it is done. */
  const [sent, setSent] = useState<{ note: string; failed?: boolean }>();
  const busy = !!sent && !sent.failed;
  const current = useCurrent();
  const sending = useRef<XMLHttpRequest>();
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(!busy, box, close, true);
  // An upload whose panel goes is abandoned with it, and so are the bytes it was still sending.
  useEffect(() => () => sending.current?.abort(), []);
  // The panel takes the keys as it opens, unless a field of it already took them (Link's address).
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus();
  }, []);
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const files = useTool<Artifact[]>(keepsFiles ? 'artifact.read:list' : null, { limit: 200 });
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
      at: b.updatedAt,
    }));
  const fileRows = (files.data ?? []).map(fileRow);
  // What the rail already reads, and on the one tab that lists them, what the paper cites.
  const home = useHome();
  const paper = useTool<{ citations: PaperCitation[] }>(tab === 'records' ? 'paper.read' : null);
  const recordRows = newest<Row>(
    [
      // Support work, a merge of deliveries, is no unit of work anyone names.
      ...(home.data?.tasks ?? [])
        .filter((task) => !isResolution(task.title))
        .map((task) => workRow('Tasks', 'Task', task.id, task.title, task.workflow)),
      ...(home.data?.experiments ?? []).map((item) =>
        workRow('Experiments', 'Experiment', item.id, item.name, item.workflow),
      ),
      ...(paper.data?.citations ?? []).flatMap(paperRow),
    ],
    (row) => row.at,
  );
  const all = {
    boards: boardRows,
    files: fileRows,
    records: recordRows,
    collection: newest([...boardRows, ...fileRows], (row) => row.at),
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
  const isPicked = (row: Row) => picked.some((p) => p.target === row.target);
  const finish = (items: CardPick[]) => {
    lastTab = tab;
    add(items);
    close();
  };
  const choose = (row: Row) =>
    tab !== 'collection'
      ? finish([row])
      : setPicked((now) => {
          const kept = now.filter((p) => p.target !== row.target);
          return kept.length < now.length ? kept : [...now, row];
        });
  const open = (next: Adding) => {
    if (busy) return;
    setSent(undefined);
    setTab(next);
    setKind('');
    setQuery('');
  };
  // Each file is kept in Files, then added: all that were kept, whatever became of the others,
  // whose reasons the panel stays open to say.
  const upload = async (chosen: File[]) => {
    if (!chosen.length || busy || readOnly()) return;
    const kept: Artifact[] = [];
    const refused: string[] = [];
    box.current?.focus();
    for (const [index, given] of chosen.entries()) {
      const name = `${given.name}${chosen.length > 1 ? ` (${index + 1} of ${chosen.length})` : ''}`;
      const told = (said: string, part?: number) =>
        setSent({ note: `${said} ${name}${part ? ` ${Math.round(part * 100)}%` : ''}` });
      try {
        const file = await sessionOf(given);
        told('Uploading');
        const available =
          file.size <= MAX_FILE ||
          (await call<{ available: boolean }>('artifact.read:storage', {})).available;
        const refusal = file.size ? refusalOf(file, available) : 'This file is empty';
        if (refusal) throw new Error(refusal);
        const stored =
          current() &&
          (await storeFile(file, {
            live: current,
            told,
            sending,
            pending: {},
            requestId: crypto.randomUUID(),
          }));
        if (stored) kept.push(stored);
      } catch (error) {
        refused.push(`${given.name}: ${error instanceof Error ? error.message : error}`);
      }
      // The panel gone, by Cancel or a change of project, nothing more is sent or added.
      if (!current()) return;
    }
    if (kept.length) {
      lastTab = 'files';
      add(kept.map(fileRow));
    }
    if (refused.length) setSent({ note: refused.join('\n'), failed: true });
    else close();
  };
  const dragging = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  // Arrows walk the list wherever the focus is but a field being written in, and from a button they
  // take the focus to the list; Enter adds the row they reached from the search, the list or the
  // panel itself; left and right change the tab; a letter typed at the panel starts a search. None
  // of it reaches Excalidraw, which hears keys from anywhere and acts on what is chosen.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (sent) {
      if (busy && event.key === 'Escape') close();
      return;
    }
    const target = event.target as HTMLElement;
    const searching =
      target === box.current ||
      !!target.closest('.search') ||
      target.getAttribute('role') === 'listbox';
    const writing = target instanceof HTMLInputElement;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const across = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step && (searching || !writing)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, at + step));
      setActive(next);
      list.current?.children[next]?.scrollIntoView?.({ block: 'nearest' });
      if (!searching) list.current?.focus();
    } else if (across && !writing) {
      event.preventDefault();
      open(TABS[(TABS.indexOf(tab) + across + TABS.length) % TABS.length]!);
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
      // Excalidraw rebinds a chosen arrow as an arrow key rises; a modifier's rise it must still hear.
      onKeyUp={(event) => event.key.startsWith('Arrow') && event.stopPropagation()}
      onDragOver={(event) => {
        if (!dragging(event)) return;
        event.preventDefault();
        setOver(!readOnly());
      }}
      onDragLeave={(event) => {
        if (!box.current?.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        if (!dragging(event)) return;
        event.preventDefault();
        setOver(false);
        void upload([...event.dataTransfer.files]);
      }}
    >
      {over && !busy && (
        <span className="upload-drop" aria-hidden="true">
          Drop to add
        </span>
      )}
      <Tabs
        label="What to add"
        options={[
          { value: 'boards', label: 'Boards', count: boards.data && boardRows.length },
          ...(keepsFiles
            ? [
                { value: 'files', label: 'Files', count: files.data && fileRows.length },
                { value: 'records', label: 'Records' },
                { value: 'collection', label: 'Collection' },
              ]
            : []),
          { value: 'link', label: 'Link' },
        ]}
        value={tab}
        onChange={open}
      />
      {sent ? (
        <div className="board-add-sending" role="status">
          <p className={sent.failed ? 'upload-note--bad' : undefined}>{sent.note}</p>
          <button
            type="button"
            className="btn-text"
            onClick={busy ? close : () => setSent(undefined)}
          >
            {busy ? 'Cancel' : 'Back'}
          </button>
        </div>
      ) : tab === 'link' ? (
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
          {(kinds.length > 1 || all.length > FEW || tab === 'files') && (
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
              {tab === 'files' && !readOnly() && (
                <label className="btn upload-pick board-add-upload">
                  Upload
                  <input
                    type="file"
                    className="sr-only"
                    multiple
                    onChange={(event) => {
                      void upload([...(event.target.files ?? [])]);
                      event.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          )}
          <div
            ref={list}
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
            {(tab === 'records' ? home.data : boards.data && (files.data || !keepsFiles)) &&
              rows.length === 0 && (
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
                onClick={() =>
                  finish([{ target: picked.map((p) => p.target), text: name.trim() || unnamed }])
                }
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
