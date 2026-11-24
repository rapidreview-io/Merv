/**
 * The page's side of screen.look and screen.show. When the agent asks to see the screen, the page
 * the person is on answers with a snapshot of itself exactly as it stands, which Main has drawn and
 * read (packages/pi/src/screen.ts); when it asks to show something, the page goes there as a link
 * would. Nothing runs in the drawing: its scripts are left out, its styles
 * are inlined, what was typed and how far each box was scrolled travel as attributes, and the
 * agent's own window, every password field and what the page shows the person alone
 * (data-merv-secret: a secret call's result, a credential shown once) stay behind.
 */
import type { UiRowDescription } from '@merv/ui/rows';
import type { PiShow } from '@merv/pi/models';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { call, safely } from '../api';
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
function snapshotPage(win: Window = window) {
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
      'script, link[rel="stylesheet"], link[rel="modulepreload"], style, .pi-dock, input[type="password"], [data-merv-secret]',
    )
    .forEach((node) => node.remove());
  const css = [...doc.styleSheets]
    .map((sheet) => safely(() => [...sheet.cssRules].map((rule) => rule.cssText).join('\n'), ''))
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

/** Only a board record has a page in this app. */
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
  if (page) return `There is no page called "${page}". Open a board by its record id.`;
  const owner = rows.find(
    (row) => row.view.kind === 'boards' && row.opens && record?.startsWith(row.opens),
  );
  if (owner) return { path: `${owner.path}/${record}`, title: owner.label };
  return `No record "${record}" opens in this project.`;
}

/** Answers what the agent asks of the screen, once, from the page in view: a look with its
 *  snapshot, a show by going there as a link would, so the person's back returns them. */
export function useScreenAnswer(pi: Conversation | null) {
  const navigate = useNavigate();
  const rows = useRows();
  const [shown, setShown] = useState<{ title: string; at: number } | null>(null);
  const answered = useRef<string>();
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const asked = pi?.snapshot?.screen;
  const id = pi?.snapshot?.conversation.id;
  useEffect(() => {
    if (!asked || !id || answered.current === asked.id || document.visibilityState === 'hidden')
      return;
    answered.current = asked.id;
    const send = (said: object) => call('pi.screen', { id, askId: asked.id, ...said });
    // A snapshot that could not be sent (too large, refused) is said to the agent, not left as
    // silence it would read as no page at all.
    const answer = (said: object) =>
      send(said).catch((error: Error) =>
        'shot' in said
          ? send({
              missing: `This page could not be sent: ${error.message || 'it was refused'}.`,
            }).catch(() => undefined)
          : undefined,
      );
    if (asked.at) {
      void placeOf(asked.at, rows)
        .then(async (place) =>
          typeof place === 'string'
            ? answer({ missing: place })
            : answer(
                place.path.split('?')[0] === location.pathname.replace(/^\/ui/, '')
                  ? { shot: snapshotPage() }
                  : { missing: 'Open that board before asking to see it.' },
              ),
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
  }, [asked, id, visible]);
  return shown;
}
