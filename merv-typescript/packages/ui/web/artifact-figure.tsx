import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { Artifact, ArtifactContent } from '@merv/contracts/artifact-models';
import { useTool } from './api';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_BYTES = 16 * 1024 * 1024;

/** A retained artifact named in Markdown, read with the reader's own access to the project. */
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
  // A picture carried up from an agent's reply is kept 30 days: once it is gone, it says so in a line.
  if (metadata.error?.code === 'artifact_expired' || read.error?.code === 'artifact_expired')
    return (
      <span className="md-figure" role="status">
        Image expired{alt ? ` · ${alt}` : ''}
      </span>
    );
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

/**
 * A picture fits the column it stands in, however large it is; pressed, it opens over the page at
 * its own size (scrolling where it is larger than the screen), and a press or Escape puts it back.
 */
function FigureImage({
  src,
  alt,
  title,
  onFail,
}: {
  src: string;
  alt: string;
  title?: string;
  onFail?: () => void;
}) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!full) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFull(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [full]);
  if (failed) return onFail ? null : <span role="status">Figure could not be decoded · </span>;
  const fail = () => {
    setFailed(true);
    onFail?.();
  };
  return (
    <>
      <button
        type="button"
        className="file-image"
        aria-label={`Show ${alt} at full size`}
        title={title || 'Show at full size'}
        onClick={() => setFull(true)}
      >
        <img src={src} alt={alt} referrerPolicy="no-referrer" decoding="async" onError={fail} />
      </button>
      {full &&
        createPortal(
          <div
            className="md-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setFull(false)}
          >
            <img src={src} alt={alt} referrerPolicy="no-referrer" />
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A picture from the open web or written into the text: drawn as an image and nothing else, sent
 * no referrer. One that does not load reads as its words, linking to it where it has an address.
 */
export function WebFigure({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  const label = alt || 'Image';
  return (
    <span className="md-figure">
      {failed ? (
        <span role="status">
          Image unavailable ·{' '}
          {src.startsWith('https:') ? (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ) : (
            label
          )}
        </span>
      ) : (
        <FigureImage key={src} src={src} alt={label} title={title} onFail={() => setFailed(true)} />
      )}
    </span>
  );
}
