import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { call, useScopeVersion, useTool } from '../api';
import { Ago, KV, LoadState, RecordPage, stamp } from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';
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

function InlineArtifact({ artifactId }: { artifactId: string }) {
  const read = useTool<ArtifactContent>('artifact.read', { artifactId });
  if (!read.data) return <LoadState loading={read.loading} error={read.error} />;
  return read.data.encoding === 'utf8' ? (
    <pre className="doc">{read.data.content}</pre>
  ) : (
    <div className="empty">Binary file · {bytes(read.data.artifact.size)}</div>
  );
}

/** The one move a file offers: take a copy of it, where storage can serve one. */
function Take({ artifact }: { artifact: Artifact }) {
  const scope = useScopeVersion();
  if (!artifact.downloadAvailable) return null;
  return <ArtifactDownload key={`${scope}:${artifact.id}`} artifactId={artifact.id} />;
}

/**
 * Only small files enter the inline content path; a large one is taken from
 * storage by the control that sits with the file it copies.
 */
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
      {artifact.size <= 2_000_000 && (
        <InlineArtifact key={`${scope}:${artifactId}`} artifactId={artifactId} />
      )}
      <Take artifact={artifact} />
    </div>
  );
}

function ArtifactList() {
  const list = useTool<Artifact[]>('artifact.list', {}, { every: 10000 });
  const nameOf = useActorNames();
  const { actor } = useSession();
  const filter = useListFilter(list.data, {
    mine: (a) => a.createdBy === actor.id,
    labels: (a) => [a.title, a.mediaType, nameOf(a.createdBy)],
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
      emptyTitle="No files"
      // A file has no state; what it stands as is its type, its exact weight and its keeper.
      line={(a) => ({
        name: <strong>{a.title}</strong>,
        standing: (
          <ThreeStates
            meta={
              <>
                <span className="mono wrap">{a.mediaType}</span> · {bytes(a.size)} ·{' '}
                {nameOf(a.createdBy)} · <Ago at={a.createdAt} />
              </>
            }
          />
        ),
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
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={a.title}
      title="Document"
      content={<ArtifactBody artifactId={a.id} metadata={a} />}
      details={
        <KV
          rows={[
            ['Media type', <span className="mono">{a.mediaType}</span>],
            ['Size', bytes(a.size)],
            ['Hash', <span className="mono faint">{a.hash.slice(0, 16)}…</span>],
            ['Created by', nameOf(a.createdBy)],
            ['Created', stamp(a.createdAt)],
          ]}
        />
      }
    />
  );
}

export const ArtifactsView = splitRoutes(ArtifactList, ArtifactDetail);
