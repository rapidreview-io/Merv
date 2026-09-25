import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash } from 'fast-sha256';
import { Link, useParams } from 'react-router-dom';
import { call, refreshTools, useScopeVersion, useTool } from '../api';
import { Ago, KV, LoadState, RecordPage, Short, timeRows } from '../components';
import { ArrowRightIcon, Icon, SourceIcon, fileIcon, type IconName } from '../icons';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { JsonView, readJson } from '../json-view';
import { MAX_READ, Markdown, useRecordNames } from '../markdown';
import { useSession } from '../session';
import { useActorNames } from './people';
import type { ViewProps } from './index';

export interface Artifact {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
  createdAt: string;
  downloadAvailable?: boolean;
}
export interface ArtifactContent {
  artifact: Artifact;
  content: string;
  encoding: 'utf8' | 'base64';
}

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
  partSize: number;
  partCount: number;
  parts: { partNumber: number; url: string; size: number; headers: Record<string, string> }[];
  completedParts: number[];
  nextPart: number | null;
};

async function fileHash(file: File, progress: (value: number) => void): Promise<string> {
  const hash = new Hash();
  for (let at = 0; at < file.size; at += 8 * 1024 * 1024) {
    hash.update(new Uint8Array(await file.slice(at, at + 8 * 1024 * 1024).arrayBuffer()));
    progress(Math.min(1, (at + 8 * 1024 * 1024) / file.size));
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function putPart(
  part: UploadPlan['parts'][number],
  blob: Blob,
  progress: (loaded: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', part.url);
    for (const [name, value] of Object.entries(part.headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => progress(event.loaded);
    request.onerror = () => reject(new Error('Object storage is unreachable'));
    request.onabort = () => reject(new Error('Part upload was interrupted'));
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(
            new Error(`Object storage refused part ${part.partNumber} (HTTP ${request.status})`),
          );
    request.send(blob);
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
        let sent = 0;
        while (true) {
          for (const part of plan.parts) {
            if (plan.completedParts.includes(part.partNumber)) {
              sent += part.size;
              continue;
            }
            setMessage(`Uploading part ${part.partNumber} of ${plan.partCount}…`);
            const start = (part.partNumber - 1) * plan.partSize;
            await putPart(part, file.slice(start, start + part.size), (loaded) =>
              setFraction(0.1 + 0.9 * ((sent + loaded) / file.size)),
            );
            sent += part.size;
            setFraction(0.1 + 0.9 * (sent / file.size));
          }
          if (plan.nextPart === null) break;
          plan = await call<UploadPlan>('artifact.upload_resume', {
            uploadId: plan.uploadId,
            startPart: plan.nextPart,
          });
        }
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

/** URLs are issued on demand and discarded when their account/project or artifact changes. */
function ArtifactDownload({ artifactId }: { artifactId: string }) {
  const [download, setDownload] = useState<{ url: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
      });
      if (mounted.current && Date.parse(result.download.expiresAt) > Date.now())
        setDownload(result.download);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : 'Download could not be prepared');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="empty">
      <button className="btn btn--sm" disabled={busy} onClick={() => void prepare()}>
        {busy ? 'Preparing…' : download ? 'Refresh download link' : 'Download file'}
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
            Download file
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
];
const VAGUE = new Set(['', 'text/plain', 'application/octet-stream']);

export interface FileType {
  /** The short human word for it: Markdown, JSON, PNG image. */
  label: string;
  icon: IconName;
  /** How the body is read where it is shown: as a document, as a tree of JSON, or as it is. */
  reads: 'markdown' | 'json' | 'text';
}
/**
 * What a file is, said once for the list, the record and the document head: a glyph
 * and a short word instead of the media type, which stays in hover titles for whoever
 * needs the machine's name for it. A type nobody listed is named from its own subtype
 * (`image/png` is a PNG image, `text/x-python` is Python), so nothing reads as a MIME string.
 */
export function fileType(file: { mediaType?: string | null; title?: string | null }): FileType {
  const type = (file.mediaType ?? '').toLowerCase().split(';')[0]!.trim();
  const name = file.title ?? '';
  const ending = VAGUE.has(type) && ENDING_NAMES.find(([pattern]) => pattern.test(name))?.[1];
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
  const label = ending || TYPE_NAMES[type] || derived;
  return {
    label,
    icon: fileIcon(type, name),
    reads: label === 'Markdown' ? 'markdown' : label === 'JSON' ? 'json' : 'text',
  };
}

/** The glyph says the type; the word for it is its name and its hover title. */
const TypeGlyph = ({ type, size }: { type: FileType; size?: number }) => (
  <span className="file-glyph" role="img" aria-label={type.label} title={type.label}>
    <Icon name={type.icon} size={size} />
  </span>
);

function InlineArtifact({
  artifactId,
  reads,
  source,
  onUnread,
}: {
  artifactId: string;
  reads: FileType['reads'];
  /** Shown as the text its author typed rather than as what it reads as. */
  source: boolean;
  /** Told once a JSON file turns out not to parse: what is shown is already its source. */
  onUnread: () => void;
}) {
  const read = useTool<ArtifactContent>('artifact.read', { artifactId });
  const content = read.data?.encoding === 'utf8' ? read.data.content : undefined;
  // Parsed whichever way it is being shown, so turning to the source and back reads it once.
  const json = useMemo(
    () => (reads === 'json' && content !== undefined ? readJson(content) : undefined),
    [content, reads],
  );
  const tree = source ? undefined : json;
  const names = useRecordNames(tree && content ? content : '');
  const unread = reads === 'json' && content !== undefined && !json;
  useEffect(() => {
    if (unread) onUnread();
  }, [unread, onUnread]);
  if (!read.data) return <LoadState loading={read.loading} error={read.error} />;
  if (content === undefined)
    return <div className="empty">Binary file · {bytes(read.data.artifact.size)}</div>;
  return reads === 'markdown' && !source ? (
    <div className="doc-read">
      <Markdown source={content} />
    </div>
  ) : tree ? (
    <JsonView value={tree.value} names={names} />
  ) : (
    // JSON that does not parse stays exactly as it was written.
    <pre className="doc">{content}</pre>
  );
}

/** The one move a file offers: take a copy of it, where storage can serve one. */
function Take({ artifact }: { artifact: Artifact }) {
  const scope = useScopeVersion();
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
 * glyph. A Markdown file is read as a document and a JSON file as a tree, and the one
 * control on the head turns either back into the text its author typed.
 */
export function ArtifactBody({
  artifactId,
  metadata,
  named,
}: {
  artifactId: string;
  metadata?: Artifact;
  /** Who has already said the title: the file's own `page`, or the disclosure that `cited` it. */
  named?: 'page' | 'cited';
}) {
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
    type.reads === 'markdown' ? artifact.size <= MAX_READ : type.reads === 'json' && !unread;
  return (
    <div className="doc-frame">
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
          {/* Past the length a document is read at, and where JSON does not parse, the
              source is already what is shown. */}
          {inline && sourced && (
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
          )}
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
      {inline && (
        <InlineArtifact
          key={`${scope}:${artifactId}`}
          artifactId={artifactId}
          reads={type.reads}
          source={source}
          onUnread={markUnread}
        />
      )}
      <Take artifact={artifact} />
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
  const type = fileType(file);
  return (
    <span className="file-meta">
      <span className="file-type" title={file.mediaType}>
        <Icon name={type.icon} size={14} />
        {type.label}
      </span>
      <span className="tabular">{bytes(file.size)}</span>
      {keeper && <span className="file-keeper">{keeper}</span>}
      <Ago at={file.createdAt} />
    </span>
  );
}

function ArtifactList() {
  const list = useTool<Artifact[]>('artifact.list', {}, { every: 10000 });
  const storage = useTool<{ available: boolean }>('artifact.storage_status', {});
  const nameOf = useActorNames();
  const { actor } = useSession();
  const filter = useListFilter(list.data, {
    mine: (a) => a.createdBy === actor.id,
    labels: (a) => [a.title, fileType(a).label, a.mediaType, nameOf(a.createdBy)],
    ids: (a) => [a.id, a.createdBy],
  });
  return (
    <ListPage
      load={list}
      noun="files"
      placeholder="Title, type or person"
      filter={filter}
      rows={filter.rows}
      opens
      create={{
        label: 'Upload file',
        form: (close) => <UploadForm available={!!storage.data?.available} close={close} />,
      }}
      emptyTitle="No files"
      // A file has no state; what it stands as is its type, its exact weight and its keeper.
      line={(a) => ({
        name: <strong>{a.title}</strong>,
        standing: <FileMeta file={a} keeper={nameOf(a.createdBy)} />,
      })}
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
  const author = nameOf(a.createdBy);
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={a.title}
      title="Document"
      content={<ArtifactBody artifactId={a.id} metadata={a} named="page" />}
      // What the file is and what it weighs stand on the head of the document above.
      details={
        <KV
          rows={[
            !!author && ['Author', author],
            ...timeRows(a.createdAt),
            ['Hash', <Short value={a.hash} copy="Copy hash" />],
          ]}
        />
      }
    />
  );
}

export const ArtifactsView = splitRoutes(ArtifactList, ArtifactDetail);
