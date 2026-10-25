import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Artifact, ArtifactContent } from '@merv/contracts/artifact-models';
import { useTool } from './api';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_BYTES = 16 * 1024 * 1024;

/** Markdown names immutable artifacts, never an author-supplied image URL. */
export function ArtifactFigure({
  artifactId,
  alt,
  title,
}: {
  artifactId: string;
  alt: string;
  title?: string;
}) {
  const metadata = useTool<Artifact>('artifact.get', { artifactId });
  const artifact = metadata.data;
  const supported = artifact && IMAGE_TYPES.has(artifact.mediaType) && !artifact.files;
  const readable = supported && artifact.size > 0 && artifact.size <= MAX_BYTES;
  const read = useTool<ArtifactContent>(readable ? 'artifact.read:content' : null, {
    artifactId,
    length: Math.ceil((artifact?.size ?? 0) / 3) * 4,
  });
  // Decoding is pure; the object URL is made and revoked by one effect, so a render React
  // discards never leaves one behind.
  const decoded = useMemo(() => {
    if (!readable || !read.data) return undefined;
    const data = read.data;
    if (
      data.encoding !== 'base64' ||
      data.artifact.id !== artifactId ||
      data.artifact.mediaType !== artifact.mediaType ||
      (data.offset ?? 0) !== 0 ||
      (data.total ?? data.content.length) !== data.content.length
    )
      return { error: true as const };
    try {
      const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
      if (bytes.length !== artifact.size) return { error: true as const };
      return { blob: new Blob([bytes], { type: artifact.mediaType }) };
    } catch {
      return { error: true as const };
    }
  }, [read.data, readable, artifact, artifactId]);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!decoded?.blob) return setUrl(undefined);
    const made = URL.createObjectURL(decoded.blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [decoded]);
  const label = alt || artifact?.title || 'Figure';
  const status =
    metadata.error || read.error || decoded?.error
      ? 'Figure unavailable'
      : artifact && !readable
        ? supported
          ? 'Figure too large to preview'
          : 'Not a supported image'
        : 'Loading figure…';
  return (
    <span className="md-figure">
      {url && !decoded?.error ? (
        <FigureImage key={url} src={url} alt={label} title={title} />
      ) : (
        <span role="status">{status} · </span>
      )}
      <Link to={`/artifacts/${artifactId}`}>{label}</Link>
    </span>
  );
}

function FigureImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <span role="status">Figure could not be decoded · </span>;
  return (
    <button
      type="button"
      className="file-image"
      aria-pressed={full}
      aria-label={full ? `Fit ${alt} to width` : `Show ${alt} at full size`}
      title={title || (full ? 'Fit to width' : 'Show at full size')}
      onClick={() => setFull(!full)}
    >
      <img src={src} alt={alt} onError={() => setFailed(true)} />
    </button>
  );
}
