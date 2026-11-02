/**
 * Bringing things onto a board: the + at the end of Excalidraw's shape toolbar, or ⌘K, and the panel
 * they open. One field and a few rows: Upload and the three most recent things, or the best matches
 * of what is typed, or Add link for an address. A file dropped on the panel or uploaded from it is
 * kept in the project's Files and added too. Shift-click or Space gathers several into one card that
 * holds them all. An app with nothing to list (speech.boardOnly) has no rows: a large Upload, a field
 * for a link, and its other boards. Board draws each one (board.write), so what a person adds and what an agent adds
 * are the same shapes: a card, or for a JPEG, PNG or WebP the picture itself.
 */
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { BoardSummary } from '@merv/board/models';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import type { PaperCitation } from '@merv/paper/models';
import { isResolution } from '@merv/tasks/resolution';
import { call, readOnly, useTool } from '../api';
import { SearchField, useDismiss, words } from '../components';
import { Icon } from '../icons';
import { speech } from '../speech';
import { matches } from '../list-filters';
import { useCurrent } from '../mutations';
import { NotSession, readTranscript } from '@merv/board/transcript';
import { bytes, fileType, MAX_FILE, refusalOf, storeFile, type FileType } from './artifacts';
import { newest, useHome } from './map-data';

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
/** Rows shown of what is recent, and of what matches. */
const RECENT = 3;
const MOST = 5;
/** Other boards shown where nothing else is listed. */
const BOARDS = 12;
/** What a card can open but a collection cannot hold. */
const LONE = ['Tasks', 'Experiments', 'Papers', 'Link'];

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
  dropped,
}: {
  board: string;
  close(): void;
  add(items: CardPick[]): void;
  /** Files let go on the canvas: they go at once, as if let go on this panel. */
  dropped?: File[];
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  /** What is being uploaded, or why it was not. The panel holds on to its upload until it is done. */
  const [sent, setSent] = useState<{ note: string; failed?: boolean }>();
  const busy = !!sent && !sent.failed;
  const current = useCurrent();
  const sending = useRef<XMLHttpRequest>();
  const box = useRef<HTMLDivElement>(null);
  const device = useRef<HTMLInputElement>(null);
  useDismiss(!busy, box, close, true);
  // An upload whose panel goes is abandoned with it, and so are the bytes it was still sending.
  useEffect(() => () => sending.current?.abort(), []);
  useEffect(() => box.current?.focus(), []);
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const files = useTool<Artifact[]>(speech.boardOnly ? null : 'artifact.read:list', { limit: 200 });
  // What the rail already reads, and what the paper cites, where there is one.
  const home = useHome();
  const paper = useTool<{ citations: PaperCitation[] }>(speech.boardOnly ? null : 'paper.read');
  const listing = !speech.boardOnly;
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
      ...(files.data ?? []).map(fileRow),
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
  const others = all.filter((row) => row.kind === 'Boards').slice(0, BOARDS);
  const search = query.trim().toLowerCase();
  const web = webPick(query.trim());
  const rows: Row[] = web
    ? [{ ...web, target: web.target as string, kind: 'Link', meta: '', at: '' }]
    : !listing
      ? []
      : search
        ? all
            .filter((row) => matches(search, [row.text, row.meta, row.kind], [row.target]))
            .slice(0, MOST)
        : all.slice(0, RECENT);
  const uploads = !search && !readOnly();
  const count = rows.length + (uploads ? 1 : 0);
  const at = Math.min(active, count - 1);
  useEffect(() => setActive(0), [search]);
  const isPicked = (row: Row) => picked.some((p) => p.target === row.target);
  const pick = (row: Row) =>
    !LONE.includes(row.kind) &&
    setPicked((now) =>
      isPicked(row) ? now.filter((p) => p.target !== row.target) : [...now, row],
    );
  const choose = (row: Row) => {
    if (picked.length) return void pick(row);
    add([row]);
    close();
  };
  const unnamed = picked.length > 1 ? `${picked[0]!.text} and ${picked.length - 1} more` : '';
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
    if (kept.length) add(kept.map(fileRow));
    if (refused.length) setSent({ note: refused.join('\n'), failed: true });
    else close();
  };
  useEffect(() => void (dropped && upload(dropped)), []); // eslint-disable-line react-hooks/exhaustive-deps
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
    } else if (event.key === ' ' && !writing) {
      event.preventDefault();
      if (row) pick(row);
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
      className={`board-add-panel finder-panel${listing ? '' : ' board-add-panel--plain'}`}
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
      ) : !listing ? (
        <div className="board-add-sections">
          {!readOnly() && (
            <label className="board-add-upload board-add-drop">
              <Icon name="upload" size={24} />
              <span>Upload</span>
              {deviceInput}
            </label>
          )}
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
      ) : (
        <>
          <SearchField
            label="Search or paste a link"
            placeholder="Search or paste a link"
            value={query}
            onChange={setQuery}
          />
          <div className="finder-list" role="listbox" aria-label="Add" aria-multiselectable>
            {uploads && (
              <label
                role="option"
                aria-selected={at === 0}
                className="finder-row board-add-row board-add-upload"
                onMouseMove={() => at !== 0 && setActive(0)}
              >
                <Icon name="upload" size={14} />
                <span className="finder-name">Upload</span>
                {deviceInput}
              </label>
            )}
            {rows.map((row, index) => {
              const place = index + (uploads ? 1 : 0);
              return (
                <div
                  key={row.target}
                  role="option"
                  aria-selected={place === at}
                  aria-checked={isPicked(row) || undefined}
                  className="finder-row board-add-row"
                  onMouseMove={() => place !== at && setActive(place)}
                  onClick={(event) => (event.shiftKey ? pick(row) : choose(row))}
                >
                  {isPicked(row) && <Icon name="check" size={14} />}
                  <span className="finder-name">{row.kind === 'Link' ? 'Add link' : row.text}</span>
                </div>
              );
            })}
            {search && !rows.length && <p className="finder-none">Nothing matches.</p>}
          </div>
          {picked.length > 1 && (
            <div className="board-add-foot">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  add([{ target: picked.map((p) => p.target), text: unnamed }]);
                  close();
                }}
              >
                Add {picked.length} as one card
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
