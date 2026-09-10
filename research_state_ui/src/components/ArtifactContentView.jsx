import { useCallback } from 'react';
import { api } from '../api';
import { AuthedImg, RawLink } from './AuthedMedia';
import FileRenderer from './FileRenderer';
import PdfView from './PdfView';
import { extOf, formatBytes, isMarkdown } from '../utils/format';
import { useAsyncData } from '../store/usePolling';

// Drop a leading "# <title>" from markdown when it just repeats a name already
// shown elsewhere (the panel header). Only the very first heading, and only on
// an exact (trimmed, case-insensitive) match — otherwise the file keeps its own
// title untouched.
function stripMatchingH1(md, title) {
  if (!md || !title) return md;
  const m = md.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
  if (m && m[1].trim().toLowerCase() === String(title).trim().toLowerCase()) {
    return md.slice(m[0].length).replace(/^\s+/, '');
  }
  return md;
}

// Drop the doc's leading "# <title>" unconditionally — used when the panel
// already labels the section (e.g. the reflection doc under its "Reflection"
// eyebrow), so the file's self-title would just be a redundant third header
// before the real content. The raw-file link still serves the untouched bytes.
function stripLeadingH1(md) {
  if (!md) return md;
  const m = md.match(/^\s*#\s+.+?\s*#*\s*(?:\r?\n|$)/);
  return m ? md.slice(m[0].length).replace(/^\s+/, '') : md;
}

function isPdfPath(path) {
  return extOf(path) === 'pdf';
}

// Raster images render inline straight from the file endpoint (like PDFs) —
// no /content fetch. SVG is deliberately absent: it is text, so it flows
// through FileRenderer → SvgView (which also offers a source toggle).
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'avif',
]);
function isImagePath(path) {
  return IMAGE_EXTS.has(extOf(path));
}

// Extensions we never try to render as text. Some backends return the raw
// bytes of these as a (huge) decoded string with no is_binary flag — e.g. a
// 29 MB .pt checkpoint comes back as ~27 MB of "text" — which locks up the
// renderer. Short-circuit by extension (like PDFs) so we never fetch or render
// them inline; the raw-file link is the escape hatch.
const BINARY_EXTS = new Set([
  'pt', 'pth', 'ckpt', 'safetensors', 'bin', 'pkl', 'pickle', 'npy', 'npz',
  'onnx', 'h5', 'hdf5', 'pb', 'model', 'weights', 'joblib',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'so', 'o', 'a', 'dylib', 'dll', 'exe', 'wasm', 'class', 'jar',
  'parquet', 'feather', 'arrow', 'db', 'sqlite', 'sqlite3',
  'wav', 'mp3', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm',
]);
function isBinaryPath(path) {
  return BINARY_EXTS.has(extOf(path));
}

// Hard cap on how much text we hand to the renderers. A genuine text file can
// still be enormous (a 15 MB results CSV); slicing before render keeps the tab
// responsive. The raw-file link serves the untruncated bytes.
const MAX_PREVIEW_CHARS = 200_000;

export default function ArtifactContentView({
  projectId, artifactId, size, path,
  // Panel-context trims: drop a leading H1 that just echoes the title shown in
  // the panel header (dedupeTitle), or drop the leading H1 unconditionally when
  // the panel already labels the section (stripTitle).
  dedupeTitle = null, stripTitle = false,
}) {
  // PDFs render directly via the file endpoint (the browser's PDF viewer
  // streams the bytes). Known-binary types (model weights, archives, media)
  // never render inline at all. Both skip /content — for PDFs it would just
  // return is_binary:true with no payload; for binaries it could return many
  // MB of useless decoded text (see isBinaryPath).
  const renderPdf = isPdfPath(path);
  const renderImage = !renderPdf && isImagePath(path);
  const renderBinary = !renderPdf && !renderImage && isBinaryPath(path);

  // PDFs, images and known-binaries skip /content entirely — the iframe, the
  // <img> and the raw link handle them.
  const skipFetch = renderPdf || renderImage || renderBinary;
  const [content, error] = useAsyncData(
    skipFetch ? null : () => api.getArtifactContent(projectId, artifactId),
    [projectId, artifactId, skipFetch],
  );
  const loading = !skipFetch && !content && !error;

  // Stable identity: MarkdownView keys its `img` component (and its memo) on
  // this — an inline arrow here would remount every figure per re-render.
  const resolveImageSrc = useCallback(
    (src) => api.artifactFigureUrl(projectId, artifactId, src),
    [projectId, artifactId],
  );

  if (renderPdf) {
    return (
      <div>
        <PdfView projectId={projectId} artifactId={artifactId} path={path} />
      </div>
    );
  }

  if (renderImage) {
    return (
      <div className="image-view">
        {/* Not lazy: inside a small overflow:auto preview panel a lazy image
            sits "below the fold" of the scroll box and never loads. */}
        <AuthedImg
          className="image-view-img"
          src={api.artifactFileUrl(projectId, artifactId)}
          alt={path || 'image'}
        />
      </div>
    );
  }

  if (renderBinary) {
    return (
      <div className="empty">
        Binary file{size != null ? ` (${formatBytes(size)})` : ''}.{' '}
        <RawLink href={api.artifactFileUrl(projectId, artifactId)}>Open raw</RawLink>
      </div>
    );
  }

  if (loading) return <div className="empty">Loading…</div>;
  if (error) {
    return (
      <div>
        <div className="error-message">{error}</div>
        <RawLink href={api.artifactFileUrl(projectId, artifactId)}>Open raw file</RawLink>
      </div>
    );
  }
  if (!content) return null;

  // Canonical wire shape: { content, is_binary, size_bytes, content_type, available }.
  if (content.available === false) {
    return (
      <div className="empty">
        No submitted content is available for this artifact yet.
      </div>
    );
  }

  const isBinary = Boolean(content.is_binary);
  const fullText = content.content ?? '';
  const overCap = fullText.length > MAX_PREVIEW_CHARS;
  let text = overCap ? fullText.slice(0, MAX_PREVIEW_CHARS) : fullText;
  if (isMarkdown(path)) {
    if (dedupeTitle) text = stripMatchingH1(text, dedupeTitle);
    else if (stripTitle) text = stripLeadingH1(text);
  }
  const meta = content.size_bytes ?? size;

  return (
    <div>
      {overCap && (
        <div className="content-truncated-note">File is large — preview is truncated.</div>
      )}
      {isBinary ? (
        <div className="empty">
          Binary file ({formatBytes(meta)}).{' '}
          <RawLink href={api.artifactFileUrl(projectId, artifactId)}>Open raw</RawLink>
        </div>
      ) : (
        <FileRenderer
          text={text}
          path={path}
          resolveImageSrc={resolveImageSrc}
        />
      )}
    </div>
  );
}
