/**
 * The page's side of screen.look and screen.show. When the agent asks to see the screen, the page
 * the person is on answers with a snapshot of itself exactly as it stands, which Main has drawn and
 * read (packages/pi/src/screen.ts); when it asks to show something, the page goes there as a link
 * would. Nothing runs in the drawing: its scripts are left out, its styles
 * are inlined, what was typed and how far each box was scrolled travel as attributes, and the
 * agent's own window and every password field stay behind.
 */
import type { UiRowDescription } from '@merv/ui/rows';
import type { PiShow } from '@merv/pi/models';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { call } from '../api';
import { routeOf, type Reference } from '../markdown';
import { useRows } from '../navigation';
import type { Conversation } from './pi-conversation';

/** A canvas as an image no larger than it is drawn on the page, which Cloudflare can draw. */
function pictured(canvas: HTMLCanvasElement, doc: Document): HTMLImageElement | null {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const small = doc.createElement('canvas');
  small.width = Math.round(box.width);
  small.height = Math.round(box.height);
  try {
    small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
    const image = doc.createElement('img');
    image.src = small.toDataURL('image/webp', 0.85);
    image.setAttribute('style', canvas.getAttribute('style') ?? '');
    image.className = canvas.className;
    image.style.width = `${box.width}px`;
    image.style.height = `${box.height}px`;
    return image;
  } catch {
    // A canvas that drew something from elsewhere cannot be read; it is left blank.
    return null;
  }
}

/** The page in `win` as it stands, for Cloudflare to draw: see the top of this file. */
export function snapshotPage(win: Window = window) {
  const doc = win.document;
  // Each scrolled box is marked on the live page for as long as the clone takes.
  const scrolled = [...doc.querySelectorAll<HTMLElement>('body *')].filter(
    (element) => element.scrollTop || element.scrollLeft,
  );
  for (const element of scrolled)
    element.setAttribute('data-merv-scroll', `${element.scrollTop},${element.scrollLeft}`);
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const element of scrolled) element.removeAttribute('data-merv-scroll');
  clone.setAttribute('data-merv-page-scroll', `${win.scrollY},${win.scrollX}`);
  // A clone keeps attributes, not what was typed: the values are written into it.
  const fields = doc.querySelectorAll('input, textarea, select');
  const copies = clone.querySelectorAll('input, textarea, select');
  // Tags, not classes: a page in a frame makes its elements from the frame's own classes.
  fields.forEach((field, at) => {
    const copy = copies[at];
    if (!copy) return;
    if (field.tagName === 'TEXTAREA') copy.textContent = (field as HTMLTextAreaElement).value;
    else if (field.tagName === 'SELECT')
      copy.querySelectorAll('option').forEach((option, index) => {
        option.toggleAttribute('selected', index === (field as HTMLSelectElement).selectedIndex);
      });
    else {
      const input = field as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio')
        copy.toggleAttribute('checked', input.checked);
      else if (input.type !== 'password' && input.type !== 'file')
        copy.setAttribute('value', input.value);
    }
  });
  // A clone of a canvas is blank: what a board or a chart drew goes as a picture of it.
  const canvases = doc.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((copy, at) => {
    const image = canvases[at] && pictured(canvases[at], doc);
    if (image) copy.replaceWith(image);
  });
  clone
    .querySelectorAll(
      'script, link[rel="stylesheet"], link[rel="modulepreload"], style, .pi-dock, input[type="password"]',
    )
    .forEach((node) => node.remove());
  const css = [...doc.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const head =
    clone.querySelector('head') ?? clone.insertBefore(doc.createElement('head'), clone.firstChild);
  const style = doc.createElement('style');
  style.textContent = css;
  head.prepend(style);
  // Images and fonts the page names by path load from where the page does.
  const base = doc.createElement('base');
  base.href = `${win.location.origin}/`;
  head.prepend(base);
  return {
    path: `${win.location.pathname}${win.location.search}`.slice(0, 2_000),
    html: `<!doctype html>${clone.outerHTML}`,
    width: Math.max(200, Math.min(8_000, Math.round(win.innerWidth))),
    height: Math.max(200, Math.min(8_000, Math.round(win.innerHeight))),
  };
}

/** Until nothing on the page has changed for `quiet` ms, at least `least` and at most `most`. */
function settled(doc: Document, { quiet = 800, least = 1500, most = 9000 } = {}) {
  return new Promise<void>((resolve) => {
    const began = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      watch.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    };
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.max(quiet, least - (Date.now() - began)));
    };
    const watch = new MutationObserver(wait);
    watch.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    const cap = setTimeout(done, most);
    wait();
  });
}

/** Another page of this app, opened out of the person's sight at their window's size, as it
 *  stands once it has loaded, the way they would see it. */
async function snapshotAt(path: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${window.innerWidth}px`,
    height: `${window.innerHeight}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  try {
    const loaded = new Promise((resolve) =>
      frame.addEventListener('load', resolve, { once: true }),
    );
    frame.src = `/ui${path}`;
    document.body.append(frame);
    await loaded;
    let win: Window;
    try {
      win = frame.contentWindow!;
      if (!win.location.pathname.startsWith('/ui')) throw new Error();
    } catch {
      throw new Error('the page refused to open in a frame');
    }
    await settled(win.document);
    return snapshotPage(win);
  } finally {
    frame.remove();
  }
}

/** Where a show goes on this composition's rows: a page by its row's id, name, path or kind, or a
 *  record wherever project.references says it opens. A miss says what there is instead. */
export async function placeOf(
  show: PiShow,
  rows: readonly UiRowDescription[],
): Promise<{ path: string; title: string } | string> {
  const place = await placed(show, rows);
  // A part to bring into view travels in the address, for whichever page names its parts.
  return typeof place === 'string' || !show.focus
    ? place
    : { ...place, path: `${place.path}?focus=${encodeURIComponent(show.focus)}` };
}
async function placed(
  { record, page }: PiShow,
  rows: readonly UiRowDescription[],
): Promise<{ path: string; title: string } | string> {
  if (page) {
    const name = page.toLowerCase().replace(/^\//, '');
    const row = rows.find((row) =>
      [row.id, row.label, row.path.slice(1), row.view.kind].some((it) => it.toLowerCase() === name),
    );
    return row
      ? { path: row.path, title: row.label }
      : `There is no page called "${page}". The pages are: ${rows.map((row) => row.label).join(', ')}.`;
  }
  // A row that owns an id's prefix opens it without asking anyone what it is.
  const owner = rows.find((row) => row.opens && record!.startsWith(row.opens));
  if (owner) return { path: `${owner.path}/${record}`, title: owner.label };
  const [found] = await call<Reference[]>('project.references', { refs: [record] });
  const path = found?.status === 'resolved' && routeOf(found, rows);
  return path
    ? { path, title: found.label ?? found.id ?? record! }
    : `No record "${record}" opens in this project${found?.status ? ` (${found.status})` : ''}.`;
}

/** Answers what the agent asks of the screen, once, from the page in view: a look with its
 *  snapshot, a show by going there as a link would, so the person's back returns them. */
export function useScreenAnswer(pi: Conversation | null) {
  const navigate = useNavigate();
  const rows = useRows();
  const [shown, setShown] = useState<{ title: string; at: number } | null>(null);
  const answered = useRef<string>();
  const asked = pi?.snapshot?.screen;
  const id = pi?.snapshot?.conversation.id;
  useEffect(() => {
    if (!asked || !id || answered.current === asked.id || document.visibilityState === 'hidden')
      return;
    answered.current = asked.id;
    const answer = (said: object) =>
      call('pi.screen', { id, askId: asked.id, ...said }).catch(() => undefined);
    if (asked.at) {
      void placeOf(asked.at, rows)
        .then(async (place) =>
          typeof place === 'string'
            ? answer({ missing: place })
            : answer({
                shot:
                  place.path === location.pathname.replace(/^\/ui/, '')
                    ? snapshotPage()
                    : await snapshotAt(place.path),
              }),
        )
        .catch((error: Error) =>
          answer({
            missing: `That page could not be drawn: ${error.message || 'it did not load'}.`,
          }),
        );
      return;
    }
    if (!asked.show) return void answer({ shot: snapshotPage() });
    void placeOf(asked.show, rows)
      .catch(() => 'The record could not be looked up.')
      .then((place) => {
        if (typeof place === 'string') return answer({ missing: place });
        navigate(place.path);
        setShown({ title: place.title, at: Date.now() });
        return answer({ opened: place });
      });
    // The rows are read when the ask comes, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, id]);
  return shown;
}
