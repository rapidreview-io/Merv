import { useBackCloses } from '../board-app/phone-back';
import { useBoardView } from '../board-app/board-view';
/**
 * Pages on the canvas: a page is an ordinary rectangle that names its address, saved like
 * any shape, and the page itself is an iframe laid exactly over it, panning and zooming with the
 * board. It moves by its bar and resizes from its corner; full screen is the same page, enlarged in
 * place over the board. In Merv.app every link it opens stays in it, and its address follows it.
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
  sceneCoordsToViewportCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import './board-pages.css';
import { pageActivity, usePageActivity } from './board-page-activity';

import { AddressBar, HOME_PAGE, PUT_PAGE, pageSandbox, site } from './web-address';
const MIN = { width: 200, height: 125 };
/** A page is drawn as a desktop screen this wide, shrunk to its card: zoomed until the card fills
 *  the screen, it reads like the browser there. New cards are a 16:10 window large enough to read
 *  and work in as they stand. */
const DESK = Math.max(1280, screen.width);
const CARD = { width: 1440, height: 900 };
/** The card's own bar, in board units, outside the shrunk page (board-pages.css). */
const BAR = 40;
type Page = ExcalidrawElement & { customData: { browser: string; tab?: string; owner?: string } };
// Only a web address becomes a page: a saved javascript: or data: one would run as the board itself.
const isPage = (el: ExcalidrawElement): el is Page =>
  !el.isDeleted &&
  typeof el.customData?.browser === 'string' &&
  /^https?:\/\//i.test(el.customData.browser);
/** What Merv.app sees in a page's frame (named for its card): where it went, a link or popup it
 *  opened, Escape pressed in it. On the web nothing is heard, and links that leave the frame are lost. */
type Heard = {
  name: string;
  board?: string;
  url?: string;
  open?: string;
  inPage?: boolean;
  escape?: boolean;
  closed?: boolean;
  focused?: boolean;
};
const mervApp = (
  window as unknown as {
    mervApp?: {
      pageGuests?: boolean;
      pageState?(state: { id: number; name: string; board: string; active: boolean }): void;
      onPage?(heard: (what: Heard) => void): void;
      pages?(list: {
        board: string;
        cards: { card: string; url: string; tab?: string; owner?: string }[];
      }): void;
    };
  }
).mervApp;
const inApp = mervApp?.onPage;
const hearing = new Set<(heard: Heard) => boolean>();
/** What came for a card of a board before it was listening (the board just came back), for a
 *  minute: it hears it on mounting; a card its board no longer lists hears none of it. */
const missed = new Map<string, { at: number; heard: Heard[] }>();
const missedKey = (board: string | undefined, name: string) => `${board ?? ''}\n${name}`;
inApp?.((heard) => {
  let taken = false;
  hearing.forEach((hear) => void (hear(heard) && (taken = true)));
  for (const [key, { at }] of missed) if (Date.now() - at > 60_000) missed.delete(key);
  // Focus belongs to the current guest, never to a later remount of this card.
  if (!taken && typeof heard.focused === 'boolean') return;
  const key = missedKey(heard.board, heard.name);
  if (!taken && (missed.has(key) || missed.size < 200))
    missed.set(key, {
      at: Date.now(),
      heard: [...(missed.get(key)?.heard ?? []), heard].slice(-5),
    });
});

/** A new page in the middle of what the person is looking at, ready to type into; the view steps
 *  back to hold all of it where it would not fit. */
function addPage(api: ExcalidrawImperativeAPI, url = HOME_PAGE) {
  const { scrollX, scrollY, zoom, width, height } = api.getAppState();
  const { width: w, height: h } = CARD;
  const [made] = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x: -scrollX + width / zoom.value / 2 - w / 2,
      y: -scrollY + height / zoom.value / 2 - h / 2,
      width: w,
      height: h,
      strokeColor: '#868e96',
      backgroundColor: 'transparent',
      strokeWidth: 1,
      roundness: { type: 3 },
    },
  ]);
  const page = { ...made!, customData: { browser: url } };
  api.updateScene({
    elements: [...api.getSceneElements(), page],
    appState: { selectedElementIds: {} },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  pageToFocus = page.id;
  if (w * zoom.value > width * 0.9 || (h + BAR) * zoom.value > height * 0.9)
    api.scrollToContent(page, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });
}
let pageToFocus: string | undefined;

/** Every page on the board, each over its rectangle. */
export function BoardPages({ api, board }: { api: ExcalidrawImperativeAPI; board: string }) {
  const { elements, state } = useBoardView(api);
  const activity = useMemo(() => pageActivity(api), [api]);
  useEffect(activity.listen, [activity]);
  useEffect(activity.check);
  const pages = elements.filter(isPage),
    cards = useRef('');
  useEffect(() => {
    const next = pages;
    // A page's address is its own bar's; a link on it would draw a second way out beside it.
    if (next.some((el) => el.link))
      return void api.updateScene({
        elements: elements.map((el) =>
          isPage(el) && el.link ? newElementWith(el, { link: null }) : el,
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    // In Merv.app every page on the board is also a tab of its browser.
    const nextCards = JSON.stringify({
      board,
      cards: next.map((el) => ({
        card: el.id,
        url: el.customData.browser,
        tab: el.customData.tab,
        owner: el.customData.owner,
      })),
    });
    if (nextCards !== cards.current) {
      // News held for a card this board no longer has is news for nothing.
      const listed = new Set(next.map((el) => missedKey(board, `merv-page:${el.id}`)));
      for (const key of missed.keys())
        if (key.startsWith(`${board}\n`) && !listed.has(key)) missed.delete(key);
      mervApp?.pages?.(JSON.parse((cards.current = nextCards)));
    }
  }, [api, board, elements]);
  // On the web, mount only pages large enough to read and near the viewport. Once visited, keep
  // their document mounted so panning away never discards form/history state.
  const visited = useRef(new Set<string>());
  const ids = new Set(pages.map((page) => page.id));
  for (const id of visited.current) if (!ids.has(id)) visited.current.delete(id);
  for (const page of pages) {
    const at = sceneCoordsToViewportCoords({ sceneX: page.x, sceneY: page.y }, state);
    const width = page.width * state.zoom.value,
      height = page.height * state.zoom.value;
    if (
      width >= 80 &&
      height >= 50 &&
      at.x + width >= state.offsetLeft - 200 &&
      at.y + height >= state.offsetTop - 200 &&
      at.x <= state.offsetLeft + state.width + 200 &&
      at.y <= state.offsetTop + state.height + 200
    )
      visited.current.add(page.id);
  }
  // Leaving the board tells the app, so a tab that moves meanwhile is news for when it is back.
  useEffect(() => () => mervApp?.pages?.({ board: '', cards: [] }), [board]);
  if (!pages.length) return null;
  return (
    <div className="canvas-pages">
      {pages
        .filter((page) => !!inApp || visited.current.has(page.id))
        .map((page) => (
          <PageCard
            key={page.id}
            activity={activity}
            api={api}
            page={page}
            board={board}
            zoom={state.zoom.value}
            at={sceneCoordsToViewportCoords({ sceneX: page.x, sceneY: page.y }, state)}
          />
        ))}
    </div>
  );
}

function PageCard({
  api,
  page,
  board,
  zoom,
  at,
  activity,
}: {
  activity: Parameters<typeof usePageActivity>[0];
  api: ExcalidrawImperativeAPI;
  page: Page;
  board: string;
  zoom: number;
  at: { x: number; y: number };
}) {
  const name = `merv-page:${page.id}`;
  // The card's own history: where it has been, and the address its frame was last sent to.
  const [trail, setTrail] = useState({ urls: [page.customData.browser], at: 0 });
  const [load, setLoad] = useState({ url: page.customData.browser, n: 0 });
  const shown = trail.urls[trail.at]!;
  const [holding, setHolding] = useState(false);
  const [full, setFull] = useState(false);
  useBackCloses(full && !inApp, () => setFull(false));
  const [nativeFocus, setNativeFocus] = useState(false);
  const section = useRef<HTMLElement>(null);
  const strip = useRef<HTMLSpanElement>(null);
  // Over the bar's own dark they need no fill; pushed in from the screen's edge, over the page, they keep theirs.
  const want = {
    left: at.x + page.width * zoom - TOUCH_STRIP - 4,
    top: at.y + (BAR * zoom) / 2 - 22,
  };
  const place = stripPlace(want.left, want.top),
    onBar = BAR * zoom >= 40 && place.left === want.left && place.top === want.top;
  const { live, opened } = usePageActivity(activity, page.id, section, full, nativeFocus, strip);
  const native = !!mervApp?.pageGuests;
  const guest = useRef<HTMLElement & { getWebContentsId(): number }>(null);
  useEffect(() => {
    if (!native || !guest.current) return;
    const frame = guest.current;
    const report = () => {
      try {
        mervApp?.pageState?.({ id: frame.getWebContentsId(), name, board, active: live });
      } catch {
        /* Not attached yet. */
      }
    };
    frame.addEventListener('dom-ready', report);
    report();
    return () => frame.removeEventListener('dom-ready', report);
  }, [native, live, load.n, name, board]);
  const field = useRef<HTMLInputElement>(null);
  /** Whether the frame's next address is where it was just sent, redirected: it takes that place. */
  const sent = useRef(true);
  useEffect(() => {
    if (pageToFocus !== page.id) return;
    pageToFocus = undefined;
    field.current?.focus();
  }, [page.id]);
  /** The page's shape, changed and saved; `quiet` while it is being dragged. */
  const change = (fields: Partial<ExcalidrawElement>, quiet = false) =>
    api.updateScene({
      elements: api
        .getSceneElements()
        .map((el) => (el.id === page.id ? newElementWith(el, fields as never) : el)),
      captureUpdate: quiet ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
    });
  const keep = (url: string) => {
    const now = api.getSceneElements().find((el) => el.id === page.id);
    if (now && now.customData?.browser !== url)
      change({ customData: { ...now.customData, browser: url } }, true);
  };
  /** Sends the frame somewhere: a new place on the trail, or `step` along it. */
  const visit = (url: string, step?: number) => {
    sent.current = true;
    setTrail((now) =>
      step
        ? { ...now, at: now.at + step }
        : { urls: [...now.urls.slice(0, now.at + 1), url], at: now.at + 1 },
    );
    setLoad((now) => ({ url, n: now.n + 1 }));
    keep(url);
  };
  const visitRef = useRef(visit);
  visitRef.current = visit;
  useEffect(() => {
    const hear = (heard: Heard): boolean => {
      // A card with the same id on another board is not this one.
      if (heard.name !== name || (heard.board && heard.board !== board)) return false;
      hearHere(heard);
      return true;
    };
    const hearHere = (heard: Heard) => {
      if (typeof heard.focused === 'boolean') setNativeFocus(heard.focused);
      if (heard.escape) return setFull(false);
      if (heard.closed) return change({ isDeleted: true });
      if (heard.open && /^https?:\/\//i.test(heard.open)) return visitRef.current(heard.open);
      const url = heard.url;
      if (!url || !/^https?:\/\//i.test(url)) return;
      const replace = sent.current || heard.inPage;
      sent.current = false;
      setTrail((now) =>
        now.urls[now.at] === url
          ? now
          : replace
            ? { urls: now.urls.map((was, index) => (index === now.at ? url : was)), at: now.at }
            : { urls: [...now.urls.slice(0, now.at + 1), url], at: now.at + 1 },
      );
      keep(url);
    };
    hearing.add(hear);
    const key = missedKey(board, name);
    const waiting = missed.get(key);
    missed.delete(key);
    // Only what is still news: a minute on, a close may be about a card since put back.
    if (waiting && Date.now() - waiting.at <= 60_000) waiting.heard.forEach(hear);
    return () => void hearing.delete(hear);
  }, [name, board]);
  useEffect(() => {
    if (!full) return;
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setFull(false);
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [full]);
  /** Dragging the bar moves the page; dragging the corner resizes it. Both in board units. */
  const hold = (event: React.PointerEvent, resize: boolean) => {
    if (full || event.button !== 0 || (event.target as HTMLElement).closest('input, button'))
      return;
    event.preventDefault();
    const from = {
      x: event.clientX,
      y: event.clientY,
      left: page.x,
      top: page.y,
      width: page.width,
      height: page.height,
    };
    setHolding(true);
    const moved = (e: PointerEvent, last = false) => {
      const dx = (e.clientX - from.x) / zoom;
      const dy = (e.clientY - from.y) / zoom;
      change(
        resize
          ? {
              width: Math.max(MIN.width, from.width + dx),
              height: Math.max(MIN.height, from.height + dy),
            }
          : { x: from.left + dx, y: from.top + dy },
        !last,
      );
    };
    const move = (e: PointerEvent) => moved(e);
    const up = (e: PointerEvent) => {
      if (e.type !== 'pointercancel') moved(e, true);
      setHolding(false);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  return (
    <>
      <section
        ref={section}
        className={`canvas-page${live ? ' is-live' : ' is-resting'}${holding ? ' is-holding' : ''}${full ? ' is-full' : ''}`}
        aria-label={`Page: ${site(shown)}`}
        style={
          full
            ? undefined
            : {
                left: at.x,
                top: at.y,
                width: page.width,
                height: page.height,
                transform: `scale(${zoom})`,
              }
        }
      >
        <AddressBar
          className="canvas-page-bar"
          onPointerDown={(event) => hold(event, false)}
          trail={trail}
          visit={visit}
          reload={() => ((sent.current = true), setLoad((now) => ({ url: shown, n: now.n + 1 })))}
          field={field}
        >
          <button
            type="button"
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            title={full ? 'Exit full screen' : 'Full screen'}
            onClick={() => setFull(!full)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d={full ? 'M6.5 2.5v4h-4M9.5 13.5v-4h4' : 'M2.5 6.5v-4h4M13.5 9.5v4h-4'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Close page"
            title="Close page"
            onClick={() => change({ isDeleted: true })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </AddressBar>
        {!inApp && (
          <p className="canvas-page-fallback">
            Page blank?{' '}
            <a href={shown} target="_blank" rel="noopener noreferrer">
              Open in a new tab
            </a>
          </p>
        )}
        {native ? (
          createElement('webview', {
            key: load.n,
            ref: guest,
            src: load.url,
            partition: 'persist:merv-web',
            className: 'canvas-page-frame',
            style: full
              ? undefined
              : {
                  width: DESK,
                  height: ((page.height - BAR - (inApp ? 0 : 30)) * DESK) / page.width,
                  transform: `scale(${page.width / DESK})`,
                },
          })
        ) : opened || inApp ? (
          <iframe
            key={load.n}
            name={name}
            className="canvas-page-frame"
            style={
              full
                ? undefined
                : {
                    width: DESK,
                    height: ((page.height - BAR - (inApp ? 0 : 30)) * DESK) / page.width,
                    transform: `scale(${page.width / DESK})`,
                  }
            }
            src={load.url}
            title={site(shown)}
            // A framed page may run and sign in as itself, and a page on the board's own origin never
            // runs as the board. A link it opens at the top is Merv.app's to catch and keep in the card;
            // on the web, nothing may take the board's own window away.
            sandbox={pageSandbox(load.url, !!inApp)}
            allow="clipboard-write; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div
            className="canvas-page-waiting"
            title="On the web, opened pages stay live to preserve their state."
          >
            {noHover() ? 'Tap' : 'Hover or click'} to open {site(shown)}
          </div>
        )}
        {!full && (
          <span
            className="canvas-page-corner"
            aria-label="Resize page"
            onPointerDown={(event) => hold(event, true)}
          />
        )}
      </section>
      {/* A finger: the bar's own small buttons scale with the board, so a woken page offers its two that matter at the
        screen's own size, apart, over its top right corner. */}
      {live && !full && coarse() && (
        <span ref={strip} className={`canvas-page-touch${onBar ? ' is-on-bar' : ''}`} style={place}>
          <button
            type="button"
            aria-label="Full screen"
            title="Full screen"
            onClick={() => setFull(true)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.5 6.5v-4h4M13.5 9.5v4h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Close page"
            title="Close page"
            onClick={() => change({ isDeleted: true })}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </span>
      )}
    </>
  );
}

/** A finger has no hover: a phone is told to tap. */
/** A coarse pointer (a finger): the page's controls are offered at the screen's size. Two of them, 44 wide, 8 apart. */
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const TOUCH_STRIP = 44 * 2 + 8;
/** How far the screen's own edges (the notch, the home bar) reach in, measured once from the page's safe-area insets. */
let insets: { top: number; right: number; bottom: number; left: number } | undefined;
function safeInsets() {
  if (insets || typeof document === 'undefined' || typeof getComputedStyle !== 'function')
    return insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  // Turned, a phone's safe areas move: measured again at the next look.
  addEventListener(
    'resize',
    () => {
      insets = undefined;
    },
    { once: true },
  );
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const style = getComputedStyle(probe),
    px = (value: string) => parseFloat(value) || 0;
  insets = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  probe.remove();
  return insets;
}
/** Where a finger's two page controls stand: at the card's top right, but never past the screen's seen edges or its
 *  safe areas, 8px in, however far the card itself reaches beyond them. */
function stripPlace(
  left: number,
  top: number,
  view = { width: innerWidth, height: innerHeight },
  safe = safeInsets(),
) {
  const clamp = (value: number, low: number, high: number) =>
    Math.max(low, Math.min(value, Math.max(low, high)));
  return {
    left: clamp(left, safe.left + 8, view.width - safe.right - TOUCH_STRIP - 8),
    top: clamp(top, safe.top + 8, view.height - safe.bottom - 44 - 8),
  };
}
const noHover = () => typeof matchMedia === 'function' && !matchMedia('(hover: hover)').matches;

const GLOBE =
  'M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4ZM2.8 10h14.4M10 2.8c2.3 2.3 2.3 12.1 0 14.4M10 2.8c-2.3 2.3-2.3 12.1 0 14.4';

export function PageTool({ api }: { api: ExcalidrawImperativeAPI | null }) {
  // The browser beside the board hands over the page it is on.
  useEffect(() => {
    const put = (event: Event) => {
      const url = (event as CustomEvent<string>).detail;
      if (api && /^https?:\/\//i.test(url)) addPage(api, url);
    };
    addEventListener(PUT_PAGE, put);
    return () => removeEventListener(PUT_PAGE, put);
  }, [api]);
  return (
    <button
      key="merv-browse"
      type="button"
      className="ToolIcon_type_button ToolIcon_size_medium ToolIcon board-browse"
      title="A web page, on the board"
      aria-label="Add a web page"
      onClick={() => api && addPage(api)}
    >
      <div className="ToolIcon__icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 20 20">
          <path d={GLOBE} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    </button>
  );
}
