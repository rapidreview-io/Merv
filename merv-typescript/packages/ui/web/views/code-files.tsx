/**
 * Code's files, read the way GitHub shows a repository: whose code (main, or a task's or an
 * experiment's) beside where in it, then a folder's entries or a file's text. The address is the
 * place: `/code/tree/<ref>/<path>` is a folder and `/code/blob/<ref>/<path>` a file, so a link
 * anywhere can name a line of work's file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { CodeProjectStatus } from '@merv/code-work/models';
import type { CodeBrowsed } from '@merv/code/models';
import { ApiError, codeFile, useTool } from '../api';
import { filesPath } from '../code-paths';
import { EmptyState, LoadState, useDismiss } from '../components';
import { Icon } from '../icons';
import { Markdown, recordNames, type NamedHome } from '../markdown';
import { bytes, fileType, FileView } from './artifacts';
import type { ViewProps } from './index';

type Browsed = CodeBrowsed & { ref: string };
/** Where the address points: whose code, and where in it. */
export function placeIn(pathname: string, root: string) {
  const [kind, ref, ...rest] = pathname.slice(root.length).split('/').filter(Boolean);
  if (kind !== 'tree' && kind !== 'blob') return { ref: 'main', path: '', file: false };
  return {
    ref: decodeURIComponent(ref ?? 'main'),
    path: rest.map(decodeURIComponent).join('/'),
    file: kind === 'blob',
  };
}
export { filesPath };

/** Whose code a reader may choose: main, then every task and experiment that has code. */
function useRefs(row: ViewProps['row'], shell: ViewProps['shell']) {
  const read = useTool<{ status?: CodeProjectStatus }>(
    'ui.read',
    { rowId: row.id },
    { every: 30_000 },
  );
  const home = useTool<NamedHome>('ui.home');
  return useMemo(() => {
    const names = recordNames(null, home.data, shell.rows);
    const units = (read.data?.status?.units ?? [])
      .filter((unit) => unit.acceptance?.reference || unit.canonicalHead)
      .map((unit) => ({
        ref: unit.unitId,
        label: names.get(unit.unitId)?.name ?? unit.unitId,
        kind: unit.workflow,
        accepted: !!unit.acceptance?.reference,
      }));
    return { units, main: read.data?.status?.project?.main ?? null, names };
  }, [read.data, home.data, shell.rows]);
}

function RefPicker({
  current,
  refs,
  onPick,
}: {
  current: string;
  refs: ReturnType<typeof useRefs>;
  onPick(ref: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  const label =
    current === 'main'
      ? 'main'
      : (refs.units.find((u) => u.ref === current)?.label ?? current.slice(0, 12));
  const shown = refs.units.filter((u) =>
    u.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pick = (ref: string) => {
    setOpen(false);
    setQuery('');
    onPick(ref);
  };
  return (
    <div className="file-menu code-ref" ref={box}>
      <button
        type="button"
        className="btn code-ref-open"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="code-ref-mark" aria-hidden>
          ⎇
        </span>
        <span className="code-ref-label">{label}</span>
        <Icon name="chevrons" size={13} />
      </button>
      {open && (
        <div className="file-menu-panel code-ref-panel" role="listbox" aria-label="Whose code">
          <input
            className="input"
            autoFocus
            placeholder="Find a task or experiment"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            role="option"
            aria-selected={current === 'main'}
            className="file-menu-item"
            onClick={() => pick('main')}
          >
            <strong>main</strong>
            <span className="muted">all accepted work</span>
          </button>
          {shown.map((unit) => (
            <button
              type="button"
              role="option"
              key={unit.ref}
              aria-selected={current === unit.ref}
              className="file-menu-item"
              onClick={() => pick(unit.ref)}
            >
              <span className="code-ref-kind">{unit.kind}</span>
              <span className="code-ref-name">{unit.label}</span>
              {!unit.accepted && <span className="muted">in progress</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Crumbs({
  root,
  place,
  base,
}: {
  root: string;
  place: ReturnType<typeof placeIn>;
  base: string;
}) {
  const parts = place.path ? place.path.split('/') : [];
  return (
    <nav className="code-crumbs" aria-label="Where in the code">
      <Link to={filesPath(root, place.ref, '')}>{base}</Link>
      {parts.map((part, at) => (
        <span key={at}>
          <span className="code-crumbs-sep">/</span>
          {at === parts.length - 1 ? (
            <strong>{part}</strong>
          ) : (
            <Link to={filesPath(root, place.ref, parts.slice(0, at + 1).join('/'))}>{part}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function Folder({ root, data }: { root: string; data: Extract<Browsed, { kind: 'folder' }> }) {
  const readme = data.entries.find(
    (entry) => entry.kind === 'file' && /^readme(\.md|\.markdown)?$/i.test(entry.name),
  );
  const up = data.path.split('/').slice(0, -1).join('/');
  return (
    <>
      <div className="code-tree" role="table" aria-label="Files">
        {data.path && (
          <Link className="code-tree-row" role="row" to={filesPath(root, data.ref, up)}>
            <Icon name="folder" size={15} />
            <span>..</span>
          </Link>
        )}
        {data.entries.map((entry) => (
          <Link
            key={entry.name}
            role="row"
            className="code-tree-row"
            to={filesPath(
              root,
              data.ref,
              data.path ? `${data.path}/${entry.name}` : entry.name,
              entry.kind !== 'folder',
            )}
          >
            <Icon name={entry.kind === 'folder' ? 'folder' : 'file'} size={15} />
            <span className="code-tree-name">{entry.name}</span>
            <span className="code-tree-size tabular">
              {entry.size !== undefined ? bytes(entry.size) : ''}
            </span>
          </Link>
        ))}
      </div>
      {readme && (
        <Readme refName={data.ref} path={data.path ? `${data.path}/${readme.name}` : readme.name} />
      )}
    </>
  );
}

function Readme({ refName, path }: { refName: string; path: string }) {
  const read = useTool<Browsed>('code.files', { ref: refName, path });
  const text = read.data?.kind === 'file' ? read.data.text : undefined;
  if (!text) return null;
  return (
    <section className="code-readme">
      <header className="code-readme-head">{path.split('/').at(-1)}</header>
      <div className="md">
        <Markdown source={text} />
      </div>
    </section>
  );
}

/** What the page reads as more than its text, so a press shows its source instead. */
const READ_AS = new Set(['markdown', 'json', 'jsonl', 'csv', 'tsv', 'notebook', 'mermaid']);
/** Past this a file's text is shown as written: parsing it whole would hold the page. */
const MOST_READ_AS = 2_000_000;

/**
 * A file's bytes, fetched whole where its summary did not carry them: a picture or a PDF, and
 * text too long to send in one answer (read as text).
 */
function useWhole(ref: string, path: string, wanted: 'bytes' | 'text' | null) {
  const [got, setGot] = useState<{ blob?: Blob; text?: string; error?: ApiError }>({});
  useEffect(() => {
    setGot({});
    if (!wanted) return;
    let live = true;
    void codeFile(ref, path)
      .then(async (blob) => (wanted === 'text' ? { text: await blob.text() } : { blob }))
      .then(
        (whole) => live && setGot(whole),
        (error: ApiError) => live && setGot({ error }),
      );
    return () => {
      live = false;
    };
  }, [ref, path, wanted]);
  return got;
}

async function download(ref: string, path: string, name: string) {
  const url = URL.createObjectURL(await codeFile(ref, path));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function File({ data }: { data: Extract<Browsed, { kind: 'file' }> }) {
  const name = data.path.split('/').at(-1) ?? data.path;
  const type = useMemo(() => fileType({ title: name }), [name]);
  // A picture or a PDF is drawn from its bytes, whatever its summary carried; an SVG is text.
  const drawn = (!!type.image && type.image !== 'image/svg+xml') || type.reads === 'pdf';
  const wanted = drawn ? 'bytes' : data.withheld === 'too_large' ? 'text' : null;
  const whole = useWhole(data.ref, data.path, wanted);
  const text = drawn ? undefined : (data.text ?? whole.text);
  const readAs =
    (READ_AS.has(type.reads) || type.image === 'image/svg+xml') && data.size <= MOST_READ_AS;
  const [source, setSource] = useState(false);
  const [busy, setBusy] = useState(false);
  // Full screen is the file alone over the whole window, as a modal: Escape or the button ends it.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const leave = (event: KeyboardEvent) => event.key === 'Escape' && setFull(false);
    document.addEventListener('keydown', leave);
    document.documentElement.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', leave);
      document.documentElement.classList.remove('modal-open');
    };
  }, [full]);
  const waiting = !!wanted && !whole.blob && whole.text === undefined && !whole.error;
  return (
    <section
      className={`code-file${full ? ' code-file--full' : ''}`}
      {...(full && { role: 'dialog', 'aria-modal': true, 'aria-label': name })}
    >
      <header className="code-file-head">
        <span className="tabular muted">
          {full && <strong className="code-file-name">{name} · </strong>}
          {type.label} ·{' '}
          {text !== undefined && `${text.split('\n').length.toLocaleString()} lines · `}
          {bytes(data.size)}
        </span>
        <span className="code-file-tools">
          {readAs && text !== undefined && (
            <span className="code-file-switch" role="group" aria-label="Show as">
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
                Preview
              </button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
                Code
              </button>
            </span>
          )}
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void download(data.ref, data.path, name)
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Preparing…' : 'Download'}
          </button>
          <button
            type="button"
            className="btn-icon btn-icon--inline"
            aria-pressed={full}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            title={full ? 'Exit full screen (Esc)' : 'Full screen'}
            onClick={() => setFull(!full)}
          >
            <Icon name={full ? 'close' : 'expand'} size={15} />
          </button>
        </span>
      </header>
      {whole.error ? (
        <p className="muted code-file-note">{whole.error.message}</p>
      ) : waiting ? (
        <LoadState loading />
      ) : (
        <div className={`code-file-body${readAs && !source && !drawn ? ' code-file-preview' : ''}`}>
          <FileView
            type={type}
            title={name}
            size={data.size}
            text={text}
            blob={whole.blob}
            source={source || (!readAs && !drawn)}
          />
        </div>
      )}
    </section>
  );
}

export function CodeFiles({ row, shell, root }: ViewProps & { root: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const place = placeIn(pathname, root);
  const refs = useRefs(row, shell);
  const read = useTool<Browsed>('code.files', { ref: place.ref, path: place.path });
  const empty =
    read.error?.code === 'code_ref_empty' ||
    (read.data?.kind === 'folder' && !read.data.entries.length && !place.path);
  const base =
    place.ref === 'main' ? 'main' : (refs.names.get(place.ref)?.name ?? place.ref.slice(0, 12));
  return (
    <div className="code-files stack">
      <div className="code-files-bar">
        <RefPicker
          current={place.ref}
          refs={refs}
          onPick={(ref) => navigate(filesPath(root, ref, place.path, place.file))}
        />
        <Crumbs root={root} place={place} base={base} />
      </div>
      {empty ? (
        <EmptyState
          kind="code"
          title={place.ref === 'main' ? 'main has no files yet' : 'No files here yet'}
          hint={
            place.ref === 'main'
              ? refs.units.length
                ? `Accepted work lands on main. Until it does, choose one of the ${refs.units.length} tasks and experiments with code above.`
                : 'Accepted work lands on main.'
              : 'This work has no code yet.'
          }
        />
      ) : !read.data ? (
        <LoadState {...read} />
      ) : read.data.kind === 'folder' ? (
        <Folder root={root} data={read.data} />
      ) : (
        <File data={read.data} />
      )}
    </div>
  );
}
