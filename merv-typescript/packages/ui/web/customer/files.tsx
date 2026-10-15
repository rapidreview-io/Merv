import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { customerRequest, said } from './api';
import { formatBytes, fromDrop, LIVE, type Uploader } from './uploads';

/**
 * The request's files: the braziliano bucket UI (merv-sandboxes/deploy/r2-upload) in React —
 * breadcrumbs, folders with their sizes, upload with progress, rename, delete and download —
 * over the request's /files routes, with the notice of when the files are deleted.
 */

export interface Listing {
  folders: { prefix: string; size: number; count: number }[];
  files: { key: string; size: number; uploaded: string }[];
  cursor: string | null;
  totalBytes: number;
  limitBytes: number;
  deleteAt: string | null;
  /** When the sweeper deleted them; set once they are gone. */
  deletedAt?: string | null;
  deletionPolicy?: string | null;
}

const svg = (d: ReactNode, width = 1.4) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);
export const ICONS = {
  folder: svg(
    <path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h2.9l1.5 1.5H13c.7 0 1.25.55 1.25 1.25v6.25c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" />,
  ),
  file: svg(
    <>
      <path d="M3.75 2.25c0-.28.22-.5.5-.5h4.9l3.1 3.1v8.9c0 .28-.22.5-.5.5h-7.5a.5.5 0 0 1-.5-.5z" />
      <path d="M9 1.75v3.25h3.25" />
    </>,
  ),
  download: svg(<path d="M8 2.75v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />),
  rename: svg(<path d="M10.25 2.75l3 3-7.5 7.5h-3v-3z" />),
  trash: svg(
    <path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 8.6c.04.5.45.9.95.9h4.4c.5 0 .91-.4.95-.9l.6-8.6" />,
  ),
  x: svg(<path d="M4 4l8 8M12 4l-8 8" />, 1.6),
  retry: svg(<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />, 1.6),
  chevron: svg(<path d="M4 6l4 4 4-4" />, 1.6),
  upload: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  ),
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const thisYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const otherYear = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const formatDate = (value: string) => {
  const date = new Date(value);
  return (date.getFullYear() === new Date().getFullYear() ? thisYear : otherYear).format(date);
};
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const POLICY = 'Deleted 48 hours after the experiment ends';
/** When the files go, in words: the policy until the experiment ends, then the moment. */
export function deletionNotice(
  listing: Pick<Listing, 'deleteAt' | 'deletedAt' | 'deletionPolicy'>,
): {
  text: string;
  deleted: boolean;
} {
  if (listing.deletedAt)
    return { text: `Files deleted on ${exact.format(new Date(listing.deletedAt))}`, deleted: true };
  if (!listing.deleteAt) return { text: listing.deletionPolicy || POLICY, deleted: false };
  const at = new Date(listing.deleteAt);
  return at.getTime() <= Date.now()
    ? { text: `Files deleted on ${exact.format(at)}`, deleted: true }
    : { text: `Files are deleted on ${exact.format(at)}`, deleted: false };
}

type Entry =
  | { kind: 'folder'; key: string; name: string; size: number; count: number }
  | { kind: 'file'; key: string; name: string; size: number; uploaded: string };

/** The folder the page shows and what is in it, read again on `reload` and as uploads land. */
export function useListing(prefix: string, version: number) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const load = async (append = false) => {
    const at = ++seq.current;
    setLoading(true);
    try {
      const cursor = append ? listing?.cursor : null;
      const next = await customerRequest<Listing>(
        `/files?${query({ prefix, ...(cursor ? { cursor } : {}) })}`,
      );
      if (at !== seq.current) return;
      setError('');
      setListing((before) =>
        append && before
          ? {
              ...next,
              folders: [...before.folders, ...next.folders],
              files: [...before.files, ...next.files],
            }
          : next,
      );
    } catch (cause) {
      if (at === seq.current) setError(said(cause, 'Couldn’t load files'));
    } finally {
      if (at === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, version]);
  return { listing, loading, error, load };
}

export function FileManager({ uploader, frozen }: { uploader: Uploader; frozen: boolean }) {
  const [prefix, setPrefix] = useState('');
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((value) => value + 1);
  const { listing, loading, error, load } = useListing(prefix, version);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Entry | null>(null);
  const [toast, setToast] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const uploads = useSyncExternalStore(uploader.subscribe, uploader.snapshot);
  // A file that lands is listed: the listing is read again shortly after the last one.
  const landed = useRef(uploads.finished);
  useEffect(() => {
    if (uploads.finished === landed.current) return;
    landed.current = uploads.finished;
    const timer = setTimeout(reload, 600);
    return () => clearTimeout(timer);
  }, [uploads.finished]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const element = folder.current;
    if (element) element.setAttribute('webkitdirectory', '');
  }, []);

  const notice = listing ? deletionNotice(listing) : null;
  const editable = !frozen && !notice?.deleted;
  const entries: Entry[] = listing
    ? [
        ...listing.folders
          .map((f) => ({
            kind: 'folder' as const,
            key: f.prefix,
            name: f.prefix.slice(prefix.length).replace(/\/$/, ''),
            size: f.size,
            count: f.count,
          }))
          .sort((a, b) => collator.compare(a.key, b.key)),
        ...listing.files
          .filter((f) => f.key !== prefix)
          .map((f) => ({
            kind: 'file' as const,
            key: f.key,
            name: f.key.slice(prefix.length),
            size: f.size,
            uploaded: f.uploaded,
          }))
          .sort((a, b) => collator.compare(a.key, b.key)),
      ]
    : [];
  const folders = entries.filter((e) => e.kind === 'folder').length;
  const shownFiles = entries.length - folders;
  const bytes = entries.reduce((n, e) => n + e.size, 0);

  const mark = (key: string, label: string | null) =>
    setBusy((now) => {
      const next = { ...now };
      if (label) next[key] = label;
      else delete next[key];
      return next;
    });
  const download = async (entry: Entry) => {
    try {
      const { url } = await customerRequest<{ url: string }>(
        `/files/download?${query({ key: entry.key })}`,
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.name.split('/').pop() ?? entry.name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      setToast(said(cause, 'Download failed'));
    }
  };
  const rename = async (entry: Entry, next: string) => {
    const parent = entry.key.slice(
      0,
      entry.key.length - entry.name.length - (entry.kind === 'folder' ? 1 : 0),
    );
    mark(entry.key, 'Renaming…');
    try {
      await customerRequest('/files/rename', {
        method: 'POST',
        body: {
          from: entry.key,
          to: entry.kind === 'folder' ? `${parent}${next}/` : parent + next,
        },
      });
    } catch (cause) {
      setToast(said(cause, 'Rename failed'));
    } finally {
      mark(entry.key, null);
      reload();
    }
  };
  const remove = async (entry: Entry) => {
    setConfirm(null);
    mark(entry.key, 'Deleting…');
    try {
      await customerRequest(
        `/files?${query(entry.kind === 'folder' ? { prefix: entry.key } : { key: entry.key })}`,
        { method: 'DELETE' },
      );
    } catch (cause) {
      setToast(said(cause, 'Delete failed'));
    } finally {
      mark(entry.key, null);
      reload();
    }
  };
  const segments = prefix.split('/').slice(0, -1);

  return (
    <section
      className="cx-files"
      onDragOver={(event) => {
        if (editable) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!editable) return;
        event.preventDefault();
        const at = prefix;
        void fromDrop(event.dataTransfer).then((entries) => uploader.add(entries, at));
      }}
    >
      <header className="cx-files-head">
        <nav className="cx-crumbs mono" aria-label="Folder">
          {[
            { label: 'Files', at: '' },
            ...segments.map((segment, index) => ({
              label: segment,
              at: `${segments.slice(0, index + 1).join('/')}/`,
            })),
          ].map((crumb, index, all) => (
            <span key={crumb.at} className="cx-crumb">
              {index > 0 && <span className="cx-sep">/</span>}
              <button
                type="button"
                aria-current={index === all.length - 1 ? 'page' : undefined}
                onClick={() => crumb.at !== prefix && setPrefix(crumb.at)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="cx-tools">
          <button type="button" className="cx-icon" aria-label="Refresh" onClick={reload}>
            {ICONS.retry}
          </button>
          {editable && (
            <>
              <button type="button" className="btn" onClick={() => folder.current?.click()}>
                Upload folder
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => files.current?.click()}
              >
                Upload
              </button>
            </>
          )}
        </div>
      </header>
      {notice && (
        <p className={`cx-deletion${notice.deleted ? ' cx-deletion--done' : ''}`} role="note">
          {notice.text}
        </p>
      )}
      {error && !listing && <p className="pi-error">{error}</p>}
      {entries.length > 0 && (
        <div className="cx-cols mono">
          <span>Name</span>
          <span className="r">Size</span>
          <span className="r d">Modified</span>
        </div>
      )}
      <ul className={`cx-entries${loading ? ' loading' : ''}`}>
        {entries.map((entry) => (
          <li key={entry.key} className={`cx-entry ${entry.kind}${busy[entry.key] ? ' busy' : ''}`}>
            <span className="kind">{ICONS[entry.kind]}</span>
            {renaming === entry.key ? (
              <RenameInput
                entry={entry}
                done={(next) => {
                  setRenaming(null);
                  if (next && next !== entry.name) void rename(entry, next);
                }}
              />
            ) : (
              <button
                type="button"
                className="name mono"
                title={entry.name}
                onClick={() =>
                  entry.kind === 'folder' ? setPrefix(entry.key) : void download(entry)
                }
              >
                {entry.name}
              </button>
            )}
            <span
              className="size mono"
              title={entry.kind === 'folder' ? plural(entry.count, 'file') : undefined}
            >
              {formatBytes(entry.size)}
            </span>
            <span className="date mono">
              {busy[entry.key] ?? (entry.kind === 'file' ? formatDate(entry.uploaded) : '')}
            </span>
            <span className="row-actions">
              {entry.kind === 'file' && (
                <button
                  type="button"
                  className="cx-icon"
                  aria-label="Download"
                  onClick={() => void download(entry)}
                >
                  {ICONS.download}
                </button>
              )}
              {editable && (
                <>
                  <button
                    type="button"
                    className="cx-icon"
                    aria-label="Rename"
                    onClick={() => setRenaming(entry.key)}
                  >
                    {ICONS.rename}
                  </button>
                  <button
                    type="button"
                    className="cx-icon rm"
                    aria-label="Delete"
                    onClick={() => setConfirm(entry)}
                  >
                    {ICONS.trash}
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {listing && !entries.length && editable && (
        <button type="button" className="cx-empty" onClick={() => files.current?.click()}>
          {ICONS.upload}
          <span>Drop files or folders</span>
        </button>
      )}
      {listing?.cursor && (
        <div className="cx-more">
          <button type="button" className="btn" onClick={() => void load(true)}>
            Load more
          </button>
        </div>
      )}
      {entries.length > 0 && (
        <p className="cx-totals mono">
          {[
            folders && plural(folders, 'folder'),
            shownFiles && plural(shownFiles, 'file'),
            formatBytes(bytes),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {confirm && (
        <div className="cx-scrim" onClick={() => setConfirm(null)}>
          <div
            className="cx-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cx-confirm-text"
            onClick={(event) => event.stopPropagation()}
          >
            <p id="cx-confirm-text">
              {confirm.kind === 'folder'
                ? `Delete ${confirm.name}/ and everything in it?`
                : `Delete ${confirm.name}?`}
            </p>
            <p className="muted">
              This can’t be undone. Merv no longer has the{' '}
              {confirm.kind === 'folder' ? 'files' : 'file'} for this experiment.
            </p>
            <div className="cx-dialog-actions">
              <button type="button" className="btn" autoFocus onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void remove(confirm)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="cx-toast" role="status">
          {toast}
        </div>
      )}
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          uploader.add(
            [...(event.target.files ?? [])].map((file) => ({ file, path: file.name })),
            prefix,
          );
          event.target.value = '';
        }}
      />
      <input
        ref={folder}
        type="file"
        hidden
        onChange={(event) => {
          uploader.add(
            [...(event.target.files ?? [])].map((file) => ({
              file,
              path: file.webkitRelativePath || file.name,
            })),
            prefix,
          );
          event.target.value = '';
        }}
      />
    </section>
  );
}

function RenameInput({ entry, done }: { entry: Entry; done(next: string | null): void }) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    element.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = (input.current?.value ?? '').trim().replace(/^\/+|\/+$/g, '');
    done(commit && next ? next : null);
  };
  return (
    <input
      ref={input}
      className="cx-rename mono"
      defaultValue={entry.name}
      spellCheck={false}
      aria-label="New name"
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(false)}
    />
  );
}

/** The uploads under way and ended, over every screen, as the braziliano tray draws them. */
export function UploadTray({ uploader }: { uploader: Uploader }) {
  const view = useSyncExternalStore(uploader.subscribe, uploader.snapshot);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (!uploader.busy()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [uploader]);
  // A clean finish clears itself after a moment; a failure stays until it is dismissed.
  const settled = view.items.length > 0 && !view.live && !view.failed;
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => uploader.clear(), 4000);
    return () => clearTimeout(timer);
  }, [settled, view.items.length, uploader]);
  if (!view.items.length) return null;
  const counted = view.items.filter((item) => item.state !== 'cancelled').length;
  return (
    <aside className={`cx-tray${collapsed ? ' collapsed' : ''}`} aria-label="Uploads">
      <div className="cx-tray-head">
        <span className="cx-tray-title">
          {view.live
            ? `Uploading ${view.finished} of ${counted}`
            : `${view.finished} of ${counted} uploaded${view.failed ? ` · ${view.failed} failed` : ''}`}
        </span>
        <span className="cx-tray-bytes mono">
          {view.live
            ? `${formatBytes(view.loaded)} / ${formatBytes(view.total)}`
            : formatBytes(view.total)}
        </span>
        <button
          type="button"
          className="cx-icon cx-tray-toggle"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {ICONS.chevron}
        </button>
        {!view.live && (
          <button
            type="button"
            className="cx-icon"
            aria-label="Clear"
            onClick={() => uploader.clear()}
          >
            {ICONS.x}
          </button>
        )}
      </div>
      <div className="cx-bar">
        <i style={{ width: `${view.total ? (view.loaded / view.total) * 100 : 0}%` }} />
      </div>
      {!collapsed && (
        <ul className="cx-uploads">
          {view.items.map((item) => {
            const size = item.file.size;
            const percent = size ? Math.floor((item.loaded / size) * 100) : 0;
            const live = (LIVE as readonly string[]).includes(item.state);
            const ended = item.state === 'failed' || item.state === 'cancelled';
            const slash = item.key.lastIndexOf('/');
            return (
              <li key={item.id} className={`cx-upload ${item.state}`}>
                <span className="name mono" title={item.key}>
                  {slash >= 0 && <span className="dir">{item.key.slice(0, slash + 1)}</span>}
                  {item.key.slice(slash + 1)}
                </span>
                <span className="state mono" title={item.error || undefined}>
                  {item.state === 'uploading'
                    ? `${Math.min(percent, 99)}%`
                    : (
                        {
                          queued: 'Waiting',
                          starting: '0%',
                          done: 'Done',
                          cancelled: 'Cancelled',
                          failed: 'Failed',
                        } as Record<string, string>
                      )[item.state]}
                </span>
                {live || ended ? (
                  <button
                    type="button"
                    className="cx-icon"
                    aria-label={ended ? 'Retry' : 'Cancel'}
                    onClick={() => (ended ? uploader.retry(item.id) : uploader.cancel(item.id))}
                  >
                    {ended ? ICONS.retry : ICONS.x}
                  </button>
                ) : (
                  <span />
                )}
                <div className="cx-bar">
                  <i style={{ width: `${size ? (item.loaded / size) * 100 : 0}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
