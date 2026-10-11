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
import { useTool } from '../api';
import { CodeBlock } from '../code-block';
import { EmptyState, LoadState } from '../components';
import { Icon } from '../icons';
import { Markdown, recordNames, type NamedHome } from '../markdown';
import { bytes } from './artifacts';
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
export const filesPath = (root: string, ref: string, path: string, file = false) =>
  `${root}/${file ? 'blob' : 'tree'}/${encodeURIComponent(ref)}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;

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
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !box.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', away, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', away, true);
    };
  }, [open]);
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

function File({ data }: { data: Extract<Browsed, { kind: 'file' }> }) {
  const markdown = /\.(md|markdown)$/i.test(data.path);
  const [preview, setPreview] = useState(markdown);
  const name = data.path.split('/').at(-1) ?? data.path;
  return (
    <section className="code-file">
      <header className="code-file-head">
        <span className="tabular muted">
          {data.text !== undefined && `${data.text.split('\n').length} lines · `}
          {bytes(data.size)}
        </span>
        {markdown && data.text !== undefined && (
          <span className="code-file-switch" role="group" aria-label="Show as">
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Code
            </button>
          </span>
        )}
      </header>
      {data.withheld === 'binary' ? (
        <p className="muted code-file-note">A binary file; nothing here to read as text.</p>
      ) : data.withheld === 'too_large' ? (
        <p className="muted code-file-note">Over 1 MiB, too large to show here.</p>
      ) : preview ? (
        <div className="md code-file-preview">
          <Markdown source={data.text ?? ''} />
        </div>
      ) : (
        <CodeBlock code={data.text ?? ''} lang={name} numbered />
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
