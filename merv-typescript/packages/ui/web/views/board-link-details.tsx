import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useTool } from '../api';
import { Icon } from '../icons';
import { Markdown } from '../markdown';
import { DiagramTheme } from '../mermaid';
import { Link } from 'react-router-dom';
import type { BoardSummary } from '@merv/board/models';
import './board-link-details.css';

/** The small, persisted payload of board.draw's link operation. No remote HTML is embedded. */
type LinkDetails = {
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
        // On a phone the toolbar and the voice's chip hold the canvas's foot: the reader stays above them.
        foot = parseFloat(getComputedStyle(popup).getPropertyValue('--reader-foot')) || 16,
        room = { x: stage.clientWidth - 16, y: stage.clientHeight - foot };
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
  const boards = useTool<{ boards: BoardSummary[] }>(
    records.some((target) => target.startsWith('board_')) ? 'board.read' : null,
    {},
  ).data?.boards;
  return (target: string) =>
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
  // A PDF is read at full size or not at all: its card opens the reader at once, and leaving the
  // reader leaves the card, with no small picture of a page in between.
  const [direct, setDirect] = useState(false);
  const loaded = useCallback((reads: string) => {
    if (reads !== 'pdf') return;
    setDirect(true);
    setExpanded(true);
  }, []);
  const collapse = () => (direct ? close() : setExpanded(false));
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
  // A record's card is named for the record and opens it.
  const record = !members && !page && !artifactId && link.startsWith('merv:') ? link.slice(5) : '';
  const named = useNamed(record ? [record] : (members ?? []));
  const opens = named(record);
  const mode = linkExpansionMode(details.text, artifactId);
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
        // A picture or diagram shown at full size over the card closes first, on its own.
        if (document.querySelector('.md-lightbox')) return;
        event.preventDefault();
        event.stopPropagation();
        if (expanded && !direct) setExpanded(false);
        else close();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [close, expanded, direct]);
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
            onClick={() => (expanded ? collapse() : setExpanded(true))}
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
  // A diagram is drawn in the board's theme, which may not be the page's.
  const notes = details.text && (
    <div className="board-reference-notes">
      <DiagramTheme.Provider value={theme}>
        <Markdown source={details.text} />
      </DiagramTheme.Provider>
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
          embedded={{ header, hideMatchingHeading: true, before: notes || undefined, loaded }}
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
            {members && <CardMembers targets={members} named={named} />}
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
            if (event.target === event.currentTarget) collapse();
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
