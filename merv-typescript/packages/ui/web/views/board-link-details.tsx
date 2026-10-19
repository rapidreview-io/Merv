import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { linkArtifactId, linkExpansionMode } from './board-link-layout';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { ArtifactBody } from './artifacts';
import './board-link-details.css';

/** The small, persisted payload of board.draw's link operation. No remote HTML is embedded. */
export type LinkDetails = {
  title?: string;
  text?: string;
  preview?: { title: string; description?: string };
  artifactId?: string;
};

export function BoardLinkDetails({
  element,
  close,
  theme,
}: {
  element: NonDeletedExcalidrawElement;
  close: () => void;
  theme: 'light' | 'dark';
}) {
  // Native scene JSON may come from hand-edited imports, bypassing board.draw's schema.
  const raw = element.customData?.details;
  const data = raw && typeof raw === 'object' ? raw : {};
  const preview = data.preview && typeof data.preview === 'object' ? data.preview : {};
  const details: LinkDetails = {
    title: typeof data.title === 'string' ? data.title : undefined,
    text: typeof data.text === 'string' ? data.text : undefined,
    artifactId: linkArtifactId(data.artifactId, ''),
    preview:
      typeof preview.title === 'string'
        ? {
            title: preview.title,
            description: typeof preview.description === 'string' ? preview.description : undefined,
          }
        : undefined,
  };
  const [expanded, setExpanded] = useState(false);
  const link = element.link ?? '';
  const web = /^https?:\/\//i.test(link);
  const artifactId = linkArtifactId(details.artifactId, link);
  const mode = linkExpansionMode(details.text, artifactId);
  const anchor = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const expandControl = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(16, Math.min(rect.left - 190, window.innerWidth - 776)),
          top: Math.max(16, Math.min(rect.top, window.innerHeight - 636)),
        });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      requestAnimationFrame(() => expandControl.current?.focus());
    };
  }, [expanded]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (expanded) setExpanded(false);
        else close();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [close, expanded]);
  let host = '';
  try {
    host = new URL(link).hostname;
  } catch {
    /* Merv record links have no hostname. */
  }
  const header = (title: string, actions?: ReactNode) => (
    <header>
      <span className="board-reference-title" title={title}>
        {title}
      </span>
      <div className="board-reference-actions">
        {actions}
        {mode !== 'none' && (
          <button
            ref={expandControl}
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            {expanded ? 'Collapse' : mode === 'fullscreen' ? 'Open full screen' : 'Expand'}
          </button>
        )}
        <button type="button" onClick={close} aria-label="Close reference details">
          ×
        </button>
      </div>
    </header>
  );
  const content = (
    <section
      ref={expanded ? dialog : anchor}
      className={`board-link-details${expanded ? ` is-expanded is-${mode}` : ''}`}
      style={expanded && mode === 'reading' ? position : undefined}
      role={expanded ? 'dialog' : 'region'}
      aria-modal={expanded || undefined}
      aria-label="Reference details"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (expanded && event.key === 'Tab') {
          const controls = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]',
            ) ?? [],
          );
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      {artifactId ? (
        <ArtifactBody
          artifactId={artifactId}
          embedded={{
            header,
            hideMatchingHeading: true,
            before: details.text ? (
              <p className="board-reference-notes">{details.text}</p>
            ) : undefined,
          }}
        />
      ) : (
        <>
          {header('Reference')}

          <div className="board-link-details-body">
            {!web && !artifactId && details.title && <h3>{details.title}</h3>}
            {details.text && <p className="board-reference-notes">{details.text}</p>}
            {web && (
              <a
                className="board-url-preview"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="board-url-host">{host} ↗</span>
                <strong>{details.preview?.title ?? host}</strong>
                {details.preview?.description ? (
                  <p>{details.preview.description}</p>
                ) : (
                  <p>Open the original source. No preview metadata is available for this link.</p>
                )}
              </a>
            )}
            {!web && !artifactId && !details.text && (
              <p>Open this Merv record using the link below.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
  if (!expanded) return content;
  return (
    <>
      <section ref={anchor} className="board-link-details" aria-hidden="true" />
      {createPortal(
        <div
          className={`board-reference-overlay board-reference-${theme}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
