import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Hash } from 'fast-sha256';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { call, refreshTools, useScopeVersion, useTool } from '../api';
import { Ago, ErrorBoundary, LoadState, SearchField, Short } from '../components';
import { ArrowRightIcon, Icon, SourceIcon, fileIcon, type IconName } from '../icons';
import { ListPage, splitRoutes, typing, useListFilter } from '../list-filters';
import { CodeBlock } from '../code-block';
import { DelimitedTable, parseDelimited } from '../csv';
import { languageOf } from '../highlight';
import { JsonLines, JsonView, readJson } from '../json-view';
import { MAX_READ, Markdown, useRecordNames } from '../markdown';
import { useCurrent } from '../mutations';
import { Mermaid } from '../mermaid';
import { NotebookView, readNotebook } from '../notebook';
import { useSession } from '../session';
import { useActorNames } from './people';
import type { ViewProps } from './index';
import type { ArtifactContent, ArtifactListing as Artifact } from '@merv/contracts/artifact-models';

export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1_048_576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1_073_741_824
        ? `${(n / 1_048_576).toFixed(1)} MB`
        : // A file never reaches this, but a repository's quota does, and a size a
          // person cannot read at a glance is no size at all.
          `${(n / 1_073_741_824).toFixed(1)} GB`;

/** artifact.create keeps a file of one byte to this many, and nothing outside that. */
export const MAX_FILE = 2_000_000;
/** MAX_OBJECT_BYTES in @merv/contracts: begin refuses a larger file, so it is not hashed first. */
const MAX_UPLOAD = 512 * 1024 * 1024;
/** What the end of a name says of a file the browser could not type. */
const ENDING_TYPES: [RegExp, string][] = [
  [/\.(md|markdown|mdx)$/i, 'text/markdown'],
  [/\.json$/i, 'application/json'],
  [/\.csv$/i, 'text/csv'],
  [/\.tsv$/i, 'text/tab-separated-values'],
  [/\.(txt|log|jsonl|ndjson|ya?ml|toml|py|r|sh|tex|rst|diff|patch)$/i, 'text/plain'],
];
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
/** Bytes as base64, a stretch at a time: one call takes far fewer arguments than a file has bytes. */
const base64 = (data: Uint8Array) => {
  let binary = '';
  for (let at = 0; at < data.length; at += 0x8000)
    binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
  return btoa(binary);
};
/**
 * A file from the reader's own disk, as artifact.create takes it. The bytes travel as
 * base64 whatever they are, so nothing here guesses at an encoding and the server
 * keeps exactly what was chosen. The type is the browser's word for it; where the
 * browser has none the end of the name says it, because a file retained as text is
 * one the app can read in place, and what neither names is plain bytes.
 */
export async function fileInput(file: File) {
  const said = file.type.toLowerCase().split(';')[0]!.trim();
  return {
    title: file.name.trim().slice(0, 300) || 'File',
    content: base64(new Uint8Array(await file.arrayBuffer())),
    encoding: 'base64',
    mediaType: MEDIA_TYPE.test(said)
      ? said
      : (ENDING_TYPES.find(([ending]) => ending.test(file.name))?.[1] ??
        'application/octet-stream'),
  };
}

type UploadPlan = {
  uploadId: string;
  parts: { url: string; headers: Record<string, string> }[];
};

async function fileHash(file: File, progress: (value: number) => void): Promise<string> {
  const hash = new Hash();
  for (let at = 0; at < file.size; at += 8 * 1024 * 1024) {
    hash.update(new Uint8Array(await file.slice(at, at + 8 * 1024 * 1024).arrayBuffer()));
    progress(Math.min(1, (at + 8 * 1024 * 1024) / file.size));
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function putFile(
  upload: UploadPlan['parts'][number],
  file: File,
  progress: (loaded: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', upload.url);
    for (const [name, value] of Object.entries(upload.headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => progress(event.loaded);
    request.onerror = () => reject(new Error('Object storage is unreachable'));
    request.onabort = () => reject(new Error('File upload was interrupted'));
    // The signed PUT is conditional: 412 means another upload stored this content address.
    // upload_complete still verifies storage before recording or returning the artifact.
    request.onload = () =>
      (request.status >= 200 && request.status < 300) || request.status === 412
        ? resolve()
        : reject(new Error(`Object storage refused the file (HTTP ${request.status})`));
    request.send(file);
  });
}

export function UploadForm({ available, close }: { available: boolean; close(): void }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [fraction, setFraction] = useState(0);
  const pending = useRef<{ file: File; uploadId: string }>();
  const requestId = useRef(crypto.randomUUID());
  const submit = async () => {
    if (!file || file.size < 1) return;
    setBusy(true);
    setMessage('');
    try {
      if (file.size <= MAX_FILE) {
        await call('artifact.create', await fileInput(file));
      } else {
        if (!available) throw new Error('Large-file storage is unavailable for this project');
        if (file.size > MAX_UPLOAD) throw new Error('Files up to 512 MiB can be uploaded');
        let plan: UploadPlan;
        if (pending.current?.file === file) {
          plan = await call<UploadPlan>('artifact.upload_resume', {
            uploadId: pending.current.uploadId,
          });
        } else {
          setMessage('Hashing file…');
          const sha256 = await fileHash(file, (value) => setFraction(value * 0.1));
          const said = file.type.toLowerCase().split(';')[0]!.trim();
          plan = await call<UploadPlan>('artifact.upload_begin', {
            title: file.name.trim().slice(0, 300) || 'File',
            size: file.size,
            sha256,
            mediaType: MEDIA_TYPE.test(said)
              ? said
              : (ENDING_TYPES.find(([ending]) => ending.test(file.name))?.[1] ??
                'application/octet-stream'),
            requestId: requestId.current,
          });
          pending.current = { file, uploadId: plan.uploadId };
        }
        const upload = plan.parts[0];
        if (upload) {
          setMessage('Uploading file…');
          await putFile(upload, file, (loaded) => setFraction(0.1 + 0.9 * (loaded / file.size)));
        }
        setFraction(1);
        setMessage('Verifying file…');
        await call('artifact.upload_complete', { uploadId: plan.uploadId });
      }
      refreshTools('artifact.list');
      close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy}>
        <label>
          File{' '}
          <input
            type="file"
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              pending.current = undefined;
              requestId.current = crypto.randomUUID();
              setFraction(0);
              setMessage('');
            }}
          />
        </label>
        <p className="muted">
          {available
            ? 'Large files upload directly to project storage.'
            : 'Files over 2 MB need project storage, which is unavailable.'}
        </p>
        <button
          className="btn btn--primary"
          type="submit"
          disabled={!file || (file.size > MAX_FILE && !available)}
        >
          {pending.current ? 'Resume upload' : 'Upload file'}
        </button>
      </fieldset>
      {busy && <progress max={1} value={fraction} aria-label="Upload progress" />}
      {message && <p role="status">{message}</p>}
    </form>
  );
}

/** Everything on a file's page that is not the file: its facts, its raw text, a download, its hash. */
function FileMenu({
  artifact,
  facts,
  raw,
}: {
  artifact: Artifact;
  facts?: ReactNode;
  raw?: { on: boolean; flip(): void };
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const take = useDownload(artifact.id);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
      } else if (box.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', away, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', away, true);
    };
  }, [open]);
  const item = (label: string, act: () => void) => (
    <button type="button" role="menuitem" className="file-menu-item" onClick={act}>
      {label}
    </button>
  );
  return (
    <div className="file-menu" ref={box}>
      <button
        type="button"
        className="btn-icon file-menu-open"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="file-menu-panel" role="menu">
          <p className="file-menu-facts">
            {facts}
            <span>{fileType(artifact).label}</span>
            <span className="tabular">{bytes(artifact.size)}</span>
          </p>
          {raw &&
            item(raw.on ? 'Rendered view' : 'Raw view', () => {
              raw.flip();
              setOpen(false);
            })}
          {artifact.downloadAvailable &&
            !artifact.files &&
            (take.download ? (
              <a
                role="menuitem"
                className="file-menu-item"
                href={take.download.url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                onClick={() => setOpen(false)}
              >
                Save file ↗
              </a>
            ) : (
              item(take.busy ? 'Preparing download…' : 'Download', () => void take.prepare())
            ))}
          {take.error && <p className="file-menu-facts">{take.error}</p>}
          {item('Copy hash', () => {
            void navigator.clipboard?.writeText(artifact.hash);
            setOpen(false);
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The way back to Files, and the way to any other file: a pointer resting on the link
 * (or the `t` key) drops a floating search over the project's files, as GitHub's `t`
 * and an editor's quick open do. The search keeps the cursor, the arrows move the row
 * in hand, Enter opens it; Escape, a click away or the pointer leaving shuts it.
 */
function FileFinder() {
  const [open, setOpen] = useState(false);
  const hover = useRef<ReturnType<typeof setTimeout>>();
  // The pointer has to rest a moment, so passing over the link on the way elsewhere opens nothing.
  const rest = (next: boolean) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => setOpen(next), next ? 150 : 250);
  };
  useEffect(() => () => clearTimeout(hover.current), []);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const list = useTool<Artifact[]>(open ? 'artifact.list' : null, { limit: FILE_PAGE });
  const search = query.trim().toLowerCase();
  const files = (list.data ?? [])
    .filter((file) => file.title.toLowerCase().includes(search))
    .slice(0, 50);
  const at = Math.min(active, files.length - 1);
  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 't' && !open && !typing(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === 'Escape' && open) {
        // Shutting the finder is all this Escape means: the file stays open.
        event.preventDefault();
        setOpen(false);
      }
    };
    const away = (event: MouseEvent) => {
      if (open && !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', away);
    };
  }, [open]);
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);
  const go = (file: Artifact) => {
    setOpen(false);
    setQuery('');
    navigate(`/artifacts/${file.id}`);
  };
  return (
    <div
      className="finder"
      ref={box}
      onMouseEnter={() => rest(true)}
      // What was typed keeps the finder open; a pointer only passing by does not.
      onMouseLeave={() => !query && rest(false)}
    >
      <Link to="/artifacts" className="finder-back" title="Files · t finds a file">
        ← Files
      </Link>
      {open && (
        <div className="finder-panel" role="dialog" aria-label="Go to file">
          <SearchField
            label="Find a file by name"
            placeholder="Go to file"
            value={query}
            onChange={setQuery}
            autoFocus
            onKeyDown={(event) => {
              const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
              if (step) {
                event.preventDefault();
                setActive(Math.max(0, Math.min(files.length - 1, at + step)));
              } else if (event.key === 'Enter' && files[at]) {
                event.preventDefault();
                go(files[at]);
              }
            }}
          />
          <div className="finder-list" role="listbox" aria-label="Files">
            {files.map((file, index) => (
              <button
                key={file.id}
                type="button"
                role="option"
                aria-selected={index === at}
                className="finder-row"
                onMouseMove={() => index !== at && setActive(index)}
                onClick={() => go(file)}
              >
                <TypeGlyph type={fileType(file)} size={14} />
                <span className="finder-name">{file.title}</span>
                <Ago at={file.createdAt} className="finder-when" />
              </button>
            ))}
            {list.data && files.length === 0 && <p className="finder-none">No files match.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** URLs are issued on demand and discarded when their account/project or artifact changes. */
function useDownload(artifactId: string, fileName?: string) {
  const [download, setDownload] = useState<{ url: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = useCurrent();
  useEffect(() => {
    if (!download) return;
    const timer = setTimeout(
      () => setDownload(undefined),
      Math.max(0, Date.parse(download.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [download]);
  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    setDownload(undefined);
    try {
      const result = await call<{ download: { url: string; expiresAt: string } }>('artifact.read', {
        artifactId,
        mode: 'download',
        ...(fileName === undefined ? {} : { fileName }),
      });
      if (current() && Date.parse(result.download.expiresAt) > Date.now())
        setDownload(result.download);
    } catch (failure) {
      if (current())
        setError(failure instanceof Error ? failure.message : 'Download could not be prepared');
    } finally {
      if (current()) setBusy(false);
    }
  };
  return { download, busy, error, prepare };
}

function ArtifactDownload({ artifactId, fileName }: { artifactId: string; fileName?: string }) {
  const { download, busy, error, prepare } = useDownload(artifactId, fileName);
  return (
    <div className="empty">
      <button className="btn btn--sm" disabled={busy} onClick={() => void prepare()}>
        {busy
          ? 'Preparing…'
          : download
            ? 'Refresh download link'
            : fileName
              ? `Download ${fileName}`
              : 'Download file'}
      </button>
      {download && (
        <p>
          <a
            className="btn btn--sm"
            href={download.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Download {fileName ?? 'file'}
          </a>{' '}
          <span className="faint">Private link expires in one minute.</span>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** What a media type is called by a person, where the subtype alone would not say it. */
const TYPE_NAMES: Record<string, string> = {
  'text/markdown': 'Markdown',
  'text/x-markdown': 'Markdown',
  'text/plain': 'Text',
  'text/csv': 'CSV',
  'text/tab-separated-values': 'TSV',
  'text/javascript': 'JavaScript',
  'application/javascript': 'JavaScript',
  'application/json': 'JSON',
  'application/jsonl': 'JSON Lines',
  'application/x-ndjson': 'JSON Lines',
  'application/x-ipynb+json': 'Notebook',
  'application/octet-stream': 'Binary',
  'application/zip': 'ZIP archive',
  'application/gzip': 'Gzip archive',
  'application/x-tar': 'Tar archive',
  'image/svg+xml': 'SVG image',
};
/** A type that says nothing of the kind leaves the end of the name to say it. */
const ENDING_NAMES: [RegExp, string][] = [
  [/\.(md|markdown|mdx)$/i, 'Markdown'],
  [/\.(jsonl|ndjson)$/i, 'JSON Lines'],
  [/\.json$/i, 'JSON'],
  [/\.csv$/i, 'CSV'],
  [/\.tsv$/i, 'TSV'],
  [/\.ya?ml$/i, 'YAML'],
  [/\.ipynb$/i, 'Notebook'],
  [/\.py$/i, 'Python'],
  [/\.log$/i, 'Log'],
  [/\.svg$/i, 'SVG image'],
  [/\.(mmd|mermaid)$/i, 'Mermaid'],
  [/\.png$/i, 'PNG image'],
  [/\.jpe?g$/i, 'JPEG image'],
  [/\.gif$/i, 'GIF image'],
  [/\.webp$/i, 'WEBP image'],
];
const VAGUE = new Set(['', 'text/plain', 'application/octet-stream']);
/** The pictures a file is drawn as, from its own bytes: the four raster types and SVG. */
const IMAGES: Record<string, string> = {
  'PNG image': 'image/png',
  'JPEG image': 'image/jpeg',
  'GIF image': 'image/gif',
  'WEBP image': 'image/webp',
  'SVG image': 'image/svg+xml',
};
/** What a file read as each word is shown as. */
const READS: Record<string, FileType['reads']> = {
  Markdown: 'markdown',
  JSON: 'json',
  'JSON Lines': 'jsonl',
  CSV: 'csv',
  TSV: 'tsv',
  Notebook: 'notebook',
  Mermaid: 'mermaid',
};
/** The language each of these is written in, for its source. */
const SOURCE_LANGS: Partial<Record<FileType['reads'], string>> = {
  markdown: 'markdown',
  json: 'json',
  notebook: 'json',
};

interface FileType {
  /** The short human word for it: Markdown, JSON, PNG image. */
  label: string;
  icon: IconName;
  /**
   * How the body is read where it is shown: as a document, a tree, lines of trees, a
   * table, a notebook, a diagram or a picture; as code in `lang`; or as text, which
   * may be a terminal's.
   */
  reads:
    | 'markdown'
    | 'json'
    | 'jsonl'
    | 'csv'
    | 'tsv'
    | 'notebook'
    | 'mermaid'
    | 'image'
    | 'code'
    | 'text';
  /** What its text is written in, for colour, where that is a language this page colours. */
  lang?: string;
  /** The media type a picture is drawn as. */
  image?: string;
}
/**
 * What a file is, said once for the list, the record and the document head: a glyph
 * and a short word instead of the media type, which stays in hover titles for whoever
 * needs the machine's name for it. A type nobody listed is named from its own subtype
 * (`image/png` is a PNG image, `text/x-python` is Python), so nothing reads as a MIME string.
 * It is also the one place that decides how a file is shown.
 */
export function fileType(file: { mediaType?: string | null; title?: string | null }): FileType {
  const type = (file.mediaType ?? '').toLowerCase().split(';')[0]!.trim();
  const name = file.title ?? '';
  const vague = VAGUE.has(type);
  const ending = vague && ENDING_NAMES.find(([pattern]) => pattern.test(name))?.[1];
  const [family = '', subtype = ''] = type.split('/');
  const bare = subtype.replace(/^(x-|vnd\.)/, '').replace(/\+\w+$/, '');
  const word = bare.length <= 4 ? bare.toUpperCase() : bare[0]!.toUpperCase() + bare.slice(1);
  const derived = /\+json$/.test(subtype)
    ? 'JSON'
    : /\+xml$/.test(subtype)
      ? 'XML'
      : ['image', 'audio', 'video', 'font'].includes(family) && word
        ? `${word} ${family}`
        : word.replaceAll(/[._-]+/g, ' ') || 'File';
  // Code is known by the end of its name where its type is vague, and by its subtype where not.
  const language = vague ? languageOf(name) : languageOf(bare);
  const label =
    ending || (vague && language?.label) || TYPE_NAMES[type] || language?.label || derived;
  const image = IMAGES[label];
  const reads = READS[label] ?? (image ? 'image' : language ? 'code' : 'text');
  const lang =
    SOURCE_LANGS[reads] ??
    (image === IMAGES['SVG image'] ? 'xml' : language && (vague ? name : bare));
  return {
    label,
    icon: fileIcon(type, name),
    reads,
    ...(lang ? { lang } : {}),
    ...(image ? { image } : {}),
  };
}

/** The glyph says the type; the word for it is its name and its hover title. */
const TypeGlyph = ({ type, size }: { type: FileType; size?: number }) => (
  <span className="file-glyph" role="img" aria-label={type.label} title={type.label}>
    <Icon name={type.icon} size={size} />
  </span>
);

/** A picture fitted to the column; a press shows it at its own size, and another fits it again. */
function FileImage({ src, title }: { src: string; title: string }) {
  const [full, setFull] = useState(false);
  return (
    <button
      type="button"
      className="file-image"
      aria-pressed={full}
      title={full ? 'Fit to width' : 'Show at full size'}
      onClick={() => setFull(!full)}
    >
      <img src={src} alt={title} />
    </button>
  );
}

function InlineArtifact({
  artifactId,
  type,
  title,
  source,
  onUnread,
}: {
  artifactId: string;
  type: FileType;
  title: string;
  /** Shown as the text its author typed rather than as what it reads as. */
  source: boolean;
  /** Told once a file that should parse turns out not to: what is shown is already its source. */
  onUnread: () => void;
}) {
  const read = useTool<ArtifactContent>('artifact.read', { artifactId });
  const content = read.data?.encoding === 'utf8' ? read.data.content : undefined;
  const { reads } = type;
  // Parsed whichever way it is being shown, so turning to the source and back reads it once.
  const parsed = useMemo(() => {
    if (content === undefined) return undefined;
    if (reads === 'json') return { json: readJson(content) };
    if (reads === 'csv' || reads === 'tsv')
      return { table: parseDelimited(content, reads === 'csv' ? ',' : '\t') };
    if (reads === 'notebook') return { notebook: readNotebook(content) };
    return {};
  }, [content, reads]);
  const unread = !!parsed && Object.values(parsed).some((value) => value === undefined);
  const names = useRecordNames(
    !source && !unread && (reads === 'json' || reads === 'jsonl') && content ? content : '',
  );
  useEffect(() => {
    if (unread) onUnread();
  }, [unread, onUnread]);
  if (!read.data) return <LoadState loading={read.loading} error={read.error} />;
  const { encoding } = read.data;
  // A picture is drawn from the file's own bytes, never from an address: an SVG as an
  // image, where its scripts do not run, and never into the page.
  if (type.image && !source && (encoding === 'base64' || type.image === 'image/svg+xml'))
    return (
      <FileImage
        title={title}
        src={
          encoding === 'base64'
            ? `data:${type.image};base64,${read.data.content}`
            : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(read.data.content)}`
        }
      />
    );
  if (content === undefined)
    return <div className="empty">Binary file · {bytes(read.data.artifact.size)}</div>;
  // A file that does not parse stays exactly as it was written.
  if (source || unread || reads === 'code' || reads === 'text' || reads === 'image')
    return <CodeBlock code={content} lang={type.lang} label={type.label} numbered />;
  if (reads === 'markdown')
    return (
      <div className="doc-read">
        <Markdown source={content} />
      </div>
    );
  if (reads === 'mermaid') return <Mermaid source={content} />;
  if (reads === 'jsonl') return <JsonLines content={content} names={names} />;
  if (parsed?.json) return <JsonView value={parsed.json.value} names={names} />;
  if (parsed?.table) return <DelimitedTable rows={parsed.table} />;
  return parsed?.notebook ? <NotebookView notebook={parsed.notebook} /> : null;
}

/** Native capture receipts keep useful files even when their finalizer did not finish. */
function CaptureStatus({ metadata }: { metadata?: Record<string, unknown> }) {
  const state = metadata?.captureState;
  const label =
    state === 'failed'
      ? 'Capture failed'
      : state === 'cancelled'
        ? 'Capture cancelled'
        : state === 'skipped'
          ? 'Capture skipped'
          : state === 'succeeded'
            ? 'Capture complete'
            : null;
  if (!label) return null;
  const limitations = Array.isArray(metadata?.evidenceLimitations)
    ? metadata.evidenceLimitations
        .flatMap((value: unknown) => {
          if (!value || typeof value !== 'object') return [];
          const row = value as Record<string, unknown>;
          const message = row.message ?? row.reason;
          return typeof message === 'string' && message.trim()
            ? [message.trim().slice(0, 1000)]
            : [];
        })
        .slice(0, 10)
    : [];
  return (
    <div role="status">
      <p>
        {label}
        {metadata?.outputState === 'partial' ? ' · partial outputs' : ''}.
      </p>
      {limitations.map((message, index) => (
        <p className="muted" key={index}>
          {message}
        </p>
      ))}
    </div>
  );
}

/** The one move a file offers: take a copy of it, where storage can serve one. */
function Take({ artifact }: { artifact: Artifact }) {
  const scope = useScopeVersion();
  if (artifact.files)
    return (
      <div className="empty">
        <CaptureStatus metadata={artifact.metadata} />
        <p>
          {artifact.files.length} retained {artifact.files.length === 1 ? 'file' : 'files'}
        </p>
        <ul>
          {artifact.files.map((file) => (
            <li key={file.name}>
              <strong>{file.name}</strong> <span className="faint tabular">{bytes(file.size)}</span>{' '}
              <Short value={file.hash} copy="Copy hash" />
              <ArtifactDownload
                key={`${scope}:${artifact.id}:${file.name}`}
                artifactId={artifact.id}
                fileName={file.name}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  if (!artifact.downloadAvailable) return null;
  return <ArtifactDownload key={`${scope}:${artifact.id}`} artifactId={artifact.id} />;
}

/**
 * A file read where it stands. Only small files enter the inline content path; a
 * large one is taken from storage by the control that sits with the file it copies.
 * The head names the file by its glyph and its title, and keeps its weight quiet at
 * the far end. Where something above it has already said the name, the head says the
 * word for the type instead: the file's own page, whose heading is the title, and a
 * cited file, whose disclosure is — that one keeps the way to the file's page as a
 * glyph. A file is read as what it is (`fileType`): Markdown as a document, JSON as a
 * tree, a table as a table, a notebook as its cells, a diagram or a picture as drawn,
 * code and logs as code; and the one control on the head turns any of them that is
 * drawn as something else back into the text its author typed. How one file is being
 * read (its source shown, its failure to parse) never carries over to the next.
 */
export function ArtifactBody(props: FileProps) {
  return <FileBody key={props.artifactId} {...props} />;
}

interface FileProps {
  artifactId: string;
  metadata?: Artifact;
  /** Who has already said the title: the file's own `page`, or the disclosure that `cited` it. */
  named?: 'page' | 'cited';
  /** On the file's own page: who made it and when, said on the one line under its title. */
  facts?: ReactNode;
}

function FileBody({ artifactId, metadata, named, facts }: FileProps) {
  const scope = useScopeVersion();
  const [source, setSource] = useState(false);
  const [unread, setUnread] = useState(false);
  const meta = useTool<Artifact>(metadata ? null : 'artifact.get', { artifactId });
  const markUnread = useCallback(() => setUnread(true), []);
  const artifact = metadata ?? meta.data;
  if (!artifact) return <LoadState loading={meta.loading} error={meta.error} />;
  const type = fileType(artifact);
  const inline = artifact.size <= 2_000_000;
  const sourced =
    type.reads === 'markdown'
      ? artifact.size <= MAX_READ
      : type.reads === 'image'
        ? type.image === 'image/svg+xml'
        : type.reads !== 'code' && type.reads !== 'text' && !unread;
  // Past the length a document is read at, for code and text, and where a file does
  // not parse, the source is already what is shown.
  const sourceToggle = inline && sourced && (
    <button
      type="button"
      className="btn-icon"
      aria-pressed={source}
      aria-label="View source"
      title="View source"
      onClick={() => setSource(!source)}
    >
      <SourceIcon />
    </button>
  );
  return (
    <div className={named === 'page' ? 'file-page' : 'doc-frame'}>
      {named === 'page' ? (
        // The file's own page is the file: its name, one quiet line of what it is, then it.
        // One line: the way back, the file's name, and everything else behind ⋯.
        <header className="file-page-head">
          <FileFinder />
          <h1 className="file-page-title" title={artifact.title}>
            <TypeGlyph type={type} size={16} />
            <span className="file-title">{artifact.title}</span>
          </h1>
          <FileMenu
            artifact={artifact}
            facts={facts}
            raw={inline && sourced ? { on: source, flip: () => setSource(!source) } : undefined}
          />
        </header>
      ) : (
        <div className="doc-head">
          <span className="doc-name">
            <TypeGlyph type={type} />
            {named ? (
              <span className="muted" title={artifact.mediaType}>
                {type.label}
              </span>
            ) : (
              <Link to={`/artifacts/${artifact.id}`}>{artifact.title}</Link>
            )}
          </span>
          <span className="doc-tools">
            <span className="faint tabular">{bytes(artifact.size)}</span>
            {sourceToggle}
            {named === 'cited' && (
              <Link
                className="btn-icon"
                to={`/artifacts/${artifact.id}`}
                aria-label={`Open ${artifact.title}`}
                title="Open file"
              >
                <ArrowRightIcon />
              </Link>
            )}
          </span>
        </div>
      )}
      {inline && (
        // A file that fails to draw is still the file: its head, its source and its copy stand.
        <ErrorBoundary key={scope} reset={source}>
          <InlineArtifact
            artifactId={artifactId}
            type={type}
            title={artifact.title}
            source={source}
            onUnread={markUnread}
          />
        </ErrorBoundary>
      )}
      {/* On its own page a single file is downloaded from ⋯; a collection lists its files. */}
      {(named !== 'page' || artifact.files) && <Take artifact={artifact} />}
    </div>
  );
}

/**
 * A file's standing on a row: what it is, its exact weight, its keeper and its age, on
 * one line that never breaks inside a fact. Beside an open record the list is a
 * column wide, so the keeper's name is the one part that gives way, to an ellipsis;
 * each separator belongs to the fact after it, so none is ever left hanging.
 */
function FileMeta({ file, keeper }: { file: Artifact; keeper?: string }) {
  return (
    <span className="file-meta">
      <span className="tabular">{bytes(file.size)}</span>
      {/* Drawn empty where nobody is named, so the columns of a wide list stay in line. */}
      <span className="file-keeper">{keeper}</span>
      <Ago at={file.createdAt} />
    </span>
  );
}

const FileName = ({ file }: { file: Artifact }) => (
  <strong className="file-name">
    <TypeGlyph type={fileType(file)} size={15} />
    <span className="file-title">{file.title}</span>
  </strong>
);

/** What a wide list of files is ordered by: a column's head, pressed once more to turn it round. */
type Order = { by: 'name' | 'size' | 'added'; up: boolean };
const COLUMNS: [Order['by'] | undefined, string][] = [
  ['name', 'Name'],
  ['size', 'Size'],
  [undefined, 'Author'],
  ['added', 'Added'],
];
let chosenOrder: Order = { by: 'added', up: false };
const ordered = (files: Artifact[], { by, up }: Order) => {
  const sign = up ? 1 : -1;
  const key = (a: Artifact, b: Artifact) =>
    by === 'name'
      ? a.title.localeCompare(b.title)
      : by === 'size'
        ? a.size - b.size
        : a.createdAt.localeCompare(b.createdAt);
  return [...files].sort((a, b) => sign * key(a, b) || b.createdAt.localeCompare(a.createdAt));
};
/** The heads of a wide list's columns, which order it; a list a column wide has none. */
function FileHead({ order, onOrder }: { order: Order; onOrder(order: Order): void }) {
  return (
    <div className="file-head">
      {COLUMNS.map(([by, label]) =>
        by ? (
          <button
            key={label}
            type="button"
            aria-pressed={order.by === by}
            onClick={() => onOrder({ by, up: order.by === by ? !order.up : by === 'name' })}
          >
            {label}
            {order.by === by && <span aria-hidden="true">{order.up ? ' ↑' : ' ↓'}</span>}
          </button>
        ) : (
          <span key={label}>{label}</span>
        ),
      )}
    </div>
  );
}

/** The newest files the Artifacts page polls; older ones come a page at a time. */
const FILE_PAGE = 200;

function ArtifactList() {
  // Up to the thousand the tool holds at most; while a longer page loads, the rows shown stay.
  const [limit, setLimit] = useState(FILE_PAGE);
  const read = useTool<Artifact[]>('artifact.list', { limit }, { every: 10000 });
  const held = useRef(read.data);
  held.current = read.data ?? held.current;
  const list = { ...read, data: held.current, loading: read.loading && !held.current };
  const storage = useTool<{ available: boolean }>('artifact.storage_status', {});
  const nameOf = useActorNames();
  const { actor } = useSession();
  const filter = useListFilter(list.data, {
    mine: (a) => a.createdBy === actor.id,
    labels: (a) => [a.title, fileType(a).label, a.mediaType, nameOf(a.createdBy)],
    ids: (a) => [a.id, a.createdBy],
  });
  // The order outlives opening a file, which mounts this list again beside it.
  const [order, setOrder] = useState(chosenOrder);
  const choose = (next: Order) => setOrder((chosenOrder = next));
  return (
    <ListPage
      load={list}
      noun="files"
      placeholder="Title, type or person"
      filter={filter}
      rows={ordered(filter.rows, order)}
      drawn={filter.rows.length > 0 && <FileHead order={order} onOrder={choose} />}
      opens
      create={{
        label: 'Upload file',
        form: (close) => <UploadForm available={!!storage.data?.available} close={close} />,
      }}
      emptyTitle="No files"
      // A file has no state; what it stands as is its type, its exact weight and its keeper.
      line={(a) => ({
        // The glyph says the type, beside the name it belongs to; no word repeats it.
        name: <FileName file={a} />,
        standing: <FileMeta file={a} keeper={nameOf(a.createdBy)} />,
      })}
      after={
        list.data?.length === limit &&
        limit < 1000 && (
          <button
            type="button"
            className="btn-text"
            onClick={() => setLimit(Math.min(1000, limit + FILE_PAGE))}
          >
            Show older files
          </button>
        )
      }
    />
  );
}

function ArtifactDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const meta = useTool<Artifact>('artifact.get', { artifactId: id });
  const nameOf = useActorNames();
  if (!meta.data)
    return (
      <div className="page-stage">
        <LoadState {...meta} back={{ to: row.path, label: row.label }} />
      </div>
    );
  const a = meta.data;
  return (
    <div className="page-stage">
      <ArtifactBody
        artifactId={a.id}
        metadata={a}
        named="page"
        facts={
          <>
            {nameOf(a.createdBy) && <span>{nameOf(a.createdBy)}</span>}
            <Ago at={a.createdAt} />
          </>
        }
      />
    </div>
  );
}

export const ArtifactsView = splitRoutes(ArtifactList, ArtifactDetail, false);
