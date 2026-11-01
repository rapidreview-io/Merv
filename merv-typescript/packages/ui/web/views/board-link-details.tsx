import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
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

/**
 * Where the reader stands: beside its card, 12px off its right edge and level with its top, or
 * off its left edge when the right has no room, or under it on a screen too narrow for either;
 * always wholly on the canvas, 16px in from its edges. Excalidraw's patched popup is placed at
 * the card's top-left corner with the card's size in `--card-width`/`--card-height`; this moves
 * it from there by its own measured size, and again whenever the reader or the canvas changes.
 */
function usePlacement(anchor: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const popup = anchor.current?.closest<HTMLElement>('.merv-rich-hyperlink');
    const stage = popup?.offsetParent;
    if (!popup || !(stage instanceof HTMLElement)) return;
    const place = () => {
      const px = (value: string) => parseFloat(value) || 0;
      const left = px(popup.style.left),
        top = px(popup.style.top),
        width = px(popup.style.getPropertyValue('--card-width')),
        height = px(popup.style.getPropertyValue('--card-height'));
      const w = popup.offsetWidth,
        h = popup.offsetHeight,
        room = { x: stage.clientWidth - 16, y: stage.clientHeight - 16 };
      let x = left + width + 12,
        y = top;
      if (x + w > room.x) x = left - 12 - w;
      if (x < 16) {
        x = Math.min(Math.max(left, 16), room.x - w);
        y = top + height + 12 + h <= room.y ? top + height + 12 : top - 12 - h;
      }
      y = Math.max(16, Math.min(y, room.y - h));
      popup.style.setProperty('--merv-dx', `${x - left}px`);
      popup.style.setProperty('--merv-dy', `${y - top}px`);
    };
    place();
    const watching = new ResizeObserver(place);
    watching.observe(popup);
    watching.observe(stage);
    return () => watching.disconnect();
  });
}

/** What each target is called and where it opens; boards are named by their own list. */
function useNamed(targets: string[]) {
  const records = targets.filter((target) => !/^https?:/.test(target));
  const names = useReferences(useMemo(() => records, [records.join()]));
  const boards = useTool<{ boards: BoardSummary[] }>(
    records.some((target) => target.startsWith('board_')) ? 'board.read' : null,
    {},
  ).data?.boards;
  return (target: string) =>
    names.get(target) ??
    (() => {
      const board = boards?.find((b) => b.id === target);
      return board && { name: board.title, to: `/boards/${board.id}` };
    })();
}

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
  const anchor = useRef<HTMLElement>(null);
  usePlacement(anchor);
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
  // A record's card is named for the record and opens it; an experiment's shows its runs' curves.
  const record = !members && !page && !artifactId && link.startsWith('merv:') ? link.slice(5) : '';
  const named = useNamed(record ? [record] : (members ?? []));
  const opens = named(record);
  const rows = useRows();
  const experiments = rowOf(rows, 'experiment')?.path;
  const { data: runs } = useTool<unknown[]>(
    rows.some((row) => row.id === 'metrics') &&
      experiments &&
      opens?.to === `${experiments}/${record}`
      ? 'metrics.read:runs'
      : null,
    { experimentId: record },
  );
  const charted = !!record && !!runs?.length;
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
  // A web card's address is the row Excalidraw keeps under this; with nothing written about
  // it there is nothing to add, and only the reader's place beside the card is kept.
  if (web && !details.text && !details.preview) return <span ref={anchor} hidden />;
  const controls = (mode !== 'none' ? 1 : 0) + 1;
  // The head: the title, which opens the record it names, then the controls in the corner.
  const header = (title: ReactNode, actions?: ReactNode) => (
    <header
      className={title ? undefined : 'is-bare'}
      style={{ '--controls': controls } as CSSProperties}
    >
      {title && <h3>{opens?.to ? <Link to={opens.to}>{title}</Link> : title}</h3>}
      <div className="board-reference-actions">
        {actions}
        {mode !== 'none' && (
          <button
            ref={expandControl}
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Back to the board' : 'Read in full'}
            title={expanded ? 'Back to the board' : 'Read in full'}
          >
            <Icon name={expanded ? 'restore' : 'expand'} size={16} />
          </button>
        )}
        <button type="button" onClick={close} aria-label="Close" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
  );
  const notes = details.text && (
    <div className="board-reference-notes">
      <Markdown source={details.text} />
    </div>
  );
  const content = (
    <section
      ref={expanded ? dialog : anchor}
      className={`board-link-details board-reference-${theme}${web ? '' : ' is-own'}${expanded ? ` is-expanded is-${mode}` : ''}`}
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
          embedded={{ header, hideMatchingHeading: true, before: notes || undefined }}
        />
      ) : (
        <>
          {header(page ? details.title : members ? `${members.length} items` : (opens?.name ?? ''))}
          <div className="board-link-details-body">
            {notes}
            {web && details.preview && (
              <a
                className="board-url-preview"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <strong>{details.preview.title}</strong>
                {details.preview.description && <p>{details.preview.description}</p>}
              </a>
            )}
            {members ? (
              <CardMembers targets={members} named={named} />
            ) : (
              charted && <MetricsCharts experimentId={record} compact={expanded ? 4 : 1} />
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

/** What a card holds, each named as its record is and opening where it lives. */
function CardMembers({
  targets,
  named,
}: {
  targets: string[];
  named: (target: string) => { name: string; to?: string } | undefined;
}) {
  return (
    <ul className="board-card-members">
      {targets.map((target) => {
        const one = named(target);
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
            <span>{one?.name ?? target.replace(/^https?:\/\//, '')}</span>
          </>
        );
        return (
          <li key={target}>
            {/^https?:/.test(target) ? (
              <a href={target} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : one?.to ? (
              <Link to={one.to}>{label}</Link>
            ) : (
              <span>{label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
