/**
 * Bringing things onto a board: the + at the end of Excalidraw's shape toolbar, or ⌘K, and the panel
 * they open: Upload, a field for a link, and its other boards. A file dropped on the panel or
 * uploaded from it is kept in the project's Files and added too. Board draws each one (board.write),
 * so what a person adds and what an agent adds are the same shapes: a card, or for a JPEG, PNG or WebP the picture itself.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { BoardSummary } from '@merv/board/models';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import { call, useTool } from '../api';
import { useDismiss } from '../components';
import { Icon } from '../icons';
import { useCurrent } from '../mutations';
import { NotSession, readTranscript } from '@merv/board/transcript';
import { bytes, fileType, MAX_FILE, refusalOf, storeFile, type FileType } from './artifacts';
const newest = <T,>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));

/** What is drawn for one thing added: what it opens (several, for a collection), its title and fact. */
export interface CardPick {
  target: string | string[];
  text: string;
  fact?: string;
  /** A file the board can show: it lands as the picture, and as a card should that fail. */
  picture?: boolean;
}
/** A row of the panel: the one thing it adds, the words that find it, how recent. */
type Row = CardPick & { target: string; kind: string; meta: string; at: string };

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
    title={`Add to board — ${ADD_KEY}`}
    aria-label="Add to board"
    onClick={onClick}
  >
    <div className="ToolIcon__icon" aria-hidden="true">
      <Icon name="plus" size={18} />
    </div>
  </button>
);

/** The word a search finds a file by, by how the file is read. */
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
/** Other boards shown where nothing else is listed. */
const BOARDS = 12;

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
const sessionOf = async (file: File): Promise<File> => {
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
    meta: fact,
    at: file.createdAt,
    ...(PICTURED.test(file.mediaType) && { picture: true }),
  };
};
/** Room kept between the panel and the window's edges. */
const EDGE = 16;
/**
 * Where the panel's middle goes, from its offset parent's left: under the toolbar's middle, moved
 * in only as far as keeps the whole panel inside the window.
 */
const underToolbar = (
  toolbar: { left: number; width: number },
  panel: number,
  parentLeft: number,
  viewport: number,
) => {
  const half = panel / 2;
  const middle = toolbar.left + toolbar.width / 2;
  const kept =
    panel + 2 * EDGE > viewport
      ? viewport / 2
      : Math.max(EDGE + half, Math.min(viewport - EDGE - half, middle));
  return kept - parentLeft;
};

/** Keeps the panel centred under the board's toolbar however the window or the board resize. */
const useUnderToolbar = (box: { current: HTMLDivElement | null }) =>
  useLayoutEffect(() => {
    const panel = box.current;
    const parent = panel?.offsetParent;
    const toolbar = parent?.querySelector<HTMLElement>('.App-toolbar');
    if (!panel || !parent || !toolbar) return;
    const place = () => {
      const bar = toolbar.getBoundingClientRect();
      if (!bar.width) return panel.style.removeProperty('left');
      const at = underToolbar(
        bar,
        panel.offsetWidth,
        parent.getBoundingClientRect().left,
        document.documentElement.clientWidth,
      );
      panel.style.left = `${at}px`;
    };
    place();
    const watch = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    for (const seen of [toolbar, parent, panel]) watch?.observe(seen);
    addEventListener('resize', place);
    return () => {
      watch?.disconnect();
      removeEventListener('resize', place);
    };
  }, [box]);

export function CardPicker({
  board,
  close,
  add,
}: {
  board: string;
  close(): void;
  add(items: CardPick[]): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [over, setOver] = useState(false);
  /** What is being uploaded, or why it was not. The panel holds on to its upload until it is done. */
  const [sent, setSent] = useState<{ note: string; failed?: boolean }>();
  const busy = !!sent && !sent.failed;
  const current = useCurrent();
  const sending = useRef<XMLHttpRequest>();
  const box = useRef<HTMLDivElement>(null);
  const device = useRef<HTMLInputElement>(null);
  useDismiss(!busy, box, close, true);
  useUnderToolbar(box);
  // An upload whose panel goes is abandoned with it, and so are the bytes it was still sending.
  useEffect(() => () => sending.current?.abort(), []);
  useEffect(() => box.current?.focus(), []);
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const all = newest<Row>(
    [
      ...(boards.data?.boards ?? [])
        .filter((b) => b.id !== board)
        .map((b) => ({
          target: b.id,
          text: b.title,
          fact: 'Board',
          kind: 'Boards',
          meta: 'Board',
          at: b.updatedAt,
        })),
    ],
    (row) => row.at,
  );
  const others = all.filter((row) => row.kind === 'Boards').slice(0, BOARDS);
  const search = query.trim().toLowerCase();
  const web = webPick(query.trim());
  const rows: Row[] = web
    ? [{ ...web, target: web.target as string, kind: 'Link', meta: '', at: '' }]
    : [];
  const uploads = !search;
  const count = rows.length + (uploads ? 1 : 0);
  const at = Math.min(active, count - 1);
  useEffect(() => setActive(0), [search]);
  const choose = (row: Row) => {
    add([row]);
    close();
  };
  // Each file is kept in Files, then added: all that were kept, whatever became of the others,
  // whose reasons the panel stays open to say.
  const upload = async (chosen: File[]) => {
    if (!chosen.length || busy) return;
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
    if (kept.length) add(kept.map(fileRow));
    if (refused.length) setSent({ note: refused.join('\n'), failed: true });
    else close();
  };
  const dragging = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const field = () => box.current?.querySelector<HTMLInputElement>('input:not([type=file])');
  // Arrows walk the rows wherever the focus is; Enter takes the row they reached; Space outside the
  // field gathers it; a letter typed at the panel starts a search. None of it reaches Excalidraw,
  // which hears keys from anywhere and acts on what is chosen.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (sent) {
      if (busy && event.key === 'Escape') close();
      return;
    }
    const writing = event.target === field();
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const row = rows[at - (uploads ? 1 : 0)];
    if (step) {
      event.preventDefault();
      setActive(Math.max(0, Math.min(count - 1, at + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (row) choose(row);
      else if (uploads) device.current?.click();
    } else if (!writing && event.key.length === 1 && !event.metaKey && !event.ctrlKey)
      field()?.focus();
  };
  const paste = (event: ClipboardEvent) => {
    if (event.target === field()) return;
    event.preventDefault();
    setQuery(event.clipboardData.getData('text'));
    field()?.focus();
  };
  const deviceInput = (
    <input
      ref={device}
      type="file"
      className="sr-only"
      tabIndex={-1}
      multiple
      onChange={(event) => {
        void upload([...(event.target.files ?? [])]);
        event.target.value = '';
      }}
    />
  );
  return (
    <div
      className="board-add-panel finder-panel board-add-panel--plain"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label="Add to board"
      onKeyDown={keys}
      onPaste={paste}
      // Excalidraw rebinds a chosen arrow as an arrow key rises; a modifier's rise it must still hear.
      onKeyUp={(event) => event.key.startsWith('Arrow') && event.stopPropagation()}
      onDragOver={(event) => {
        if (!dragging(event)) return;
        event.preventDefault();
        setOver(true);
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
      ) : (
        <div className="board-add-sections">
          <label className="board-add-upload board-add-drop">
            <Icon name="upload" size={24} />
            <span>Upload</span>
            {deviceInput}
          </label>
          <label className="board-add-address">
            <span className="board-add-label">URL link</span>
            <span className="board-add-field">
              <input
                className="input"
                type="url"
                placeholder="https://"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {web && (
                <button type="button" className="btn" onClick={() => choose(rows[0]!)}>
                  Add
                </button>
              )}
            </span>
          </label>
          {!!others.length && (
            <section className="board-add-others" aria-label="Other boards">
              <span className="board-add-label">Other boards</span>
              <div className="board-add-boards">
                {others.map((row) => (
                  <button key={row.target} type="button" onClick={() => choose(row)}>
                    <Icon name="boards" size={16} />
                    <span>{row.text}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
