import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { call, useScopeVersion, useTool } from '../api';
import { Ago, KV, Listing, LoadState, PageHeader, col, recordRoutes, stamp } from '../components';
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
      : `${(n / 1_048_576).toFixed(1)} MB`;

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
        {busy ? 'Preparing…' : download ? 'Refresh download link' : 'Prepare download'}
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

function InlineArtifact({ artifactId }: { artifactId: string }) {
  const read = useTool<ArtifactContent>('artifact.read', { artifactId });
  if (!read.data) return <LoadState loading={read.loading} error={read.error} />;
  return read.data.encoding === 'utf8' ? (
    <pre className="doc">{read.data.content}</pre>
  ) : (
    <div className="empty">Binary file · {bytes(read.data.artifact.size)}</div>
  );
}

/** Only small files enter the inline content path. Large files download directly from storage. */
export function ArtifactBody({
  artifactId,
  metadata,
}: {
  artifactId: string;
  metadata?: Artifact;
}) {
  const scope = useScopeVersion();
  const meta = useTool<Artifact>(metadata ? null : 'artifact.get', { artifactId });
  const artifact = metadata ?? meta.data;
  if (!artifact) return <LoadState loading={meta.loading} error={meta.error} />;
  return (
    <div className="doc-frame">
      <div className="doc-head">
        <Link to={`/artifacts/${artifact.id}`}>{artifact.title}</Link>
        <span className="faint">
          {artifact.mediaType} · {bytes(artifact.size)}
        </span>
      </div>
      {artifact.size <= 2_000_000 ? (
        <InlineArtifact key={`${scope}:${artifactId}`} artifactId={artifactId} />
      ) : (
        <div className="empty">This file is too large for an inline preview.</div>
      )}
      {artifact.downloadAvailable ? (
        <ArtifactDownload key={`${scope}:${artifactId}`} artifactId={artifactId} />
      ) : (
        artifact.size > 2_000_000 && (
          <div className="empty">Direct downloads are unavailable with this storage provider.</div>
        )
      )}
    </div>
  );
}

function ArtifactList() {
  const list = useTool<Artifact[]>('artifact.list', {}, { every: 10000 });
  const nameOf = useActorNames();
  // What an inventory is asked first: how much of this is there. Both numbers are
  // exact — the count and every file's own `size` — so neither is hedged.
  const files = list.data ?? [];
  const held = files.reduce((sum, file) => sum + file.size, 0);
  return (
    <div className="page-stage stack">
      {list.data && (
        <p className="list-totals">
          {files.length} {files.length === 1 ? 'file' : 'files'} · {bytes(held)}
          <span className="muted"> · every file retained in this project, whoever retained it</span>
        </p>
      )}
      <Listing
        load={list}
        rows={[...files].reverse()}
        opens
        emptyTitle="No artifacts"
        emptyHint="Briefs, deliveries and evidence files land here as agents retain them; their contents never change afterwards."
        columns={[
          col<Artifact>('title', 'Title', (a) => <strong>{a.title}</strong>),
          col<Artifact>(
            'type',
            'Type',
            (a) => <span className="mono faint">{a.mediaType}</span>,
            '150px',
          ),
          col<Artifact>('size', 'Size', (a) => bytes(a.size), '90px'),
          col<Artifact>('by', 'Created by', (a) => nameOf(a.createdBy)),
          col<Artifact>('when', 'When', (a) => <Ago at={a.createdAt} />, '90px'),
        ]}
      />
    </div>
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
      <PageHeader
        eyebrow={<Link to={row.path}>← {row.label}</Link>}
        kind={row.view.kind}
        title={a.title}
      />
      <KV
        rows={[
          ['Media type', <span className="mono">{a.mediaType}</span>],
          ['Size', bytes(a.size)],
          ['Hash', <span className="mono faint">{a.hash.slice(0, 16)}…</span>],
          ['Created by', nameOf(a.createdBy)],
          ['Created', stamp(a.createdAt)],
        ]}
      />
      <ArtifactBody artifactId={a.id} metadata={a} />
    </div>
  );
}

export const ArtifactsView = recordRoutes(ArtifactList, ArtifactDetail);
