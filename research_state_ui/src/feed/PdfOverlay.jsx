import { pdfByline, pdfFallbackLabel } from './pdfModel';
import { cx } from '../utils/format';

export function PdfOverlay({
  info,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  showZoom,
  persistent,
  visible,
}) {
  const classes = cx(
    'postcard-pdf-overlay',
    persistent ? 'postcard-pdf-overlay--persistent' : '',
    visible ? 'postcard-pdf-overlay--visible' : '',
  );
  const zoomLabel = zoom === 'fit' ? 'fit' : `${Math.round(zoom * 100)}%`;
  return (
    <div className={classes}>
      <div className="postcard-pdf-overlay-meta">
        <span className="postcard-pdf-overlay-title">{info.title}</span>
        <span className="postcard-pdf-overlay-byline">{pdfByline(info)}</span>
      </div>
      <div className="postcard-pdf-overlay-actions">
        {showZoom && (
          <div className="postcard-pdf-zoom">
            <button
              type="button"
              className="postcard-pdf-zoom-btn"
              aria-label="Zoom out"
              onClick={onZoomOut}
            >
              −
            </button>
            <button
              type="button"
              className="postcard-pdf-zoom-label"
              aria-label="Reset zoom"
              onClick={onZoomReset}
            >
              {zoomLabel}
            </button>
            <button
              type="button"
              className="postcard-pdf-zoom-btn"
              aria-label="Zoom in"
              onClick={onZoomIn}
            >
              +
            </button>
          </div>
        )}
        <a
          className="postcard-pdf-open"
          href={info.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label="Open on arxiv"
        >
          open ↗
        </a>
      </div>
    </div>
  );
}

export function PdfFallbackOverlay({ info, persistent, visible }) {
  const classes = cx(
    'postcard-pdf-overlay',
    persistent ? 'postcard-pdf-overlay--persistent' : '',
    visible ? 'postcard-pdf-overlay--visible' : '',
  );
  return (
    <div className={classes}>
      <div className="postcard-pdf-overlay-meta">
        <span className="postcard-pdf-overlay-byline">
          {pdfFallbackLabel(info)}
        </span>
      </div>
      <div className="postcard-pdf-overlay-actions">
        <a
          className="postcard-pdf-open"
          href={info.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label="Open on arxiv"
        >
          open ↗
        </a>
      </div>
    </div>
  );
}
