import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { linkArtifactId, linkExpansionMode } from './board-link-layout';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { ArtifactBody } from './artifacts';
import { MetricsCharts } from './metrics';
import { useTool } from '../api';
import { Icon } from '../icons';
import { Markdown, useReferences } from '../markdown';
import { rowOf, useRows } from '../navigation';
import { Link } from 'react-router-dom';
import type { BoardSummary } from '@merv/board/models';
import './board-link-details.css';

/** The small, persisted payload of board.draw's link operation. No remote HTML is embedded. */
export type LinkDetails = {
  title?: string;
  text?: string;
  preview?: { title: string; description?: string };
  artifactId?: string;
};

/** A page card opens only its own words: it has no address to show, edit or follow. */
export const PAGE_LINK = 'merv:page';

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
  // A card that holds several things lists them; its link is only the first of them.
  const target = element.customData?.target;
  const members =
    Array.isArray(target) && target.length > 1 && target.every((one) => typeof one === 'string')
      ? (target as string[])
      : undefined;
  const page = link === PAGE_LINK;
  const web = !members && /^https?:\/\//i.test(link);
  const artifactId = members ? undefined : linkArtifactId(details.artifactId, link);
  // An experiment's card shows its runs' curves, where the Metrics plugin keeps them.
  const record = !members && !page && link.startsWith('merv:') ? link.slice(5) : '';
  const opens = useReferences(useMemo(() => (record ? [record] : []), [record])).get(record)?.to;
  const rows = useRows();
  const experiments = rowOf(rows, 'experiment')?.path;
  const { data: runs } = useTool<unknown[]>(
    rows.some((row) => row.id === 'metrics') && experiments && opens === `${experiments}/${record}`
      ? 'metrics.read:runs'
      : null,
    { experimentId: record },
  );
  const charted = !artifactId && !!runs?.length;
  const written = linkExpansionMode(details.text, artifactId);
  const mode = charted && written === 'none' ? 'reading' : written;
  const dialog = useRef<HTMLElement>(null);
  const expandControl = useRef<HTMLButtonElement>(null);
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
      ref={expanded ? dialog : undefined}
      className={`board-link-details board-reference-${theme}${page ? ' is-page' : ''}${expanded ? ` is-expanded is-${mode}` : ''}`}
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
              <div className="board-reference-notes">
                <Markdown source={details.text} />
              </div>
            ) : undefined,
          }}
        />
      ) : (
        <>
          {header(members ? `${members.length} items` : '')}

          <div className="board-link-details-body">
            {!web && !artifactId && details.title && <h3>{details.title}</h3>}
            {details.text && (
              <div className="board-reference-notes">
                <Markdown source={details.text} />
              </div>
            )}
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
            {members ? (
              <CardMembers targets={members} />
            ) : charted ? (
              <MetricsCharts experimentId={record} compact={expanded ? 4 : 1} />
            ) : (
              !web &&
              !artifactId &&
              !details.text && <p>Open this Merv record using the link below.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
  if (!expanded) return content;
  return (
    <>
      <section className="board-link-details" aria-hidden="true" />
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

/** What a card holds, each named as its record is and opening where it lives. */
function CardMembers({ targets }: { targets: string[] }) {
  const records = targets.filter((target) => !/^https?:/.test(target));
  const names = useReferences(useMemo(() => records, [records.join()]));
  // Boards are named by their own list; project.references does not know them.
  const boards = useTool<{ boards: BoardSummary[] }>(
    records.some((target) => target.startsWith('board_')) ? 'board.read' : null,
    {},
  ).data?.boards;
  return (
    <ul className="board-card-members">
      {targets.map((target) => {
        const board = boards?.find((b) => b.id === target);
        const named =
          names.get(target) ?? (board && { name: board.title, to: `/boards/${board.id}` });
        const icon = /^https?:/.test(target)
          ? 'link'
          : target.startsWith('board_')
            ? 'boards'
            : target.startsWith('art_')
              ? 'file'
              : 'work';
        const label = (
          <>
            <Icon name={icon} size={14} />
            <span>{named?.name ?? target.replace(/^https?:\/\//, '')}</span>
          </>
        );
        return (
          <li key={target}>
            {/^https?:/.test(target) ? (
              <a href={target} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : named?.to ? (
              <Link to={named.to}>{label}</Link>
            ) : (
              <span>{label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
