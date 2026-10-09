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

export function snapshotPage() {
  // Each scrolled box is marked on the live page for as long as the clone takes.
  const scrolled = [...document.querySelectorAll<HTMLElement>('body *')].filter(
    (element) => element.scrollTop || element.scrollLeft,
  );
  for (const element of scrolled)
    element.setAttribute('data-merv-scroll', `${element.scrollTop},${element.scrollLeft}`);
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  for (const element of scrolled) element.removeAttribute('data-merv-scroll');
  clone.setAttribute('data-merv-page-scroll', `${window.scrollY},${window.scrollX}`);
  // A clone keeps attributes, not what was typed: the values are written into it.
  const fields = document.querySelectorAll('input, textarea, select');
  const copies = clone.querySelectorAll('input, textarea, select');
  fields.forEach((field, at) => {
    const copy = copies[at];
    if (!copy) return;
    if (field instanceof HTMLTextAreaElement) copy.textContent = field.value;
    else if (field instanceof HTMLSelectElement)
      copy.querySelectorAll('option').forEach((option, index) => {
        option.toggleAttribute('selected', index === field.selectedIndex);
      });
    else if (field instanceof HTMLInputElement) {
      if (field.type === 'checkbox' || field.type === 'radio')
        copy.toggleAttribute('checked', field.checked);
      else if (field.type !== 'password' && field.type !== 'file')
        copy.setAttribute('value', field.value);
    }
  });
  clone
    .querySelectorAll(
      'script, link[rel="stylesheet"], link[rel="modulepreload"], style, .pi-dock, input[type="password"]',
    )
    .forEach((node) => node.remove());
  const css = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const head =
    clone.querySelector('head') ??
    clone.insertBefore(document.createElement('head'), clone.firstChild);
  const style = document.createElement('style');
  style.textContent = css;
  head.prepend(style);
  // Images and fonts the page names by path load from where the page does.
  const base = document.createElement('base');
  base.href = `${window.location.origin}/`;
  head.prepend(base);
  return {
    path: `${window.location.pathname}${window.location.search}`.slice(0, 2_000),
    html: `<!doctype html>${clone.outerHTML}`,
    width: Math.max(200, Math.min(8_000, Math.round(window.innerWidth))),
    height: Math.max(200, Math.min(8_000, Math.round(window.innerHeight))),
  };
}

/** Where a show goes on this composition's rows: a page by its row's id, name, path or kind, or a
 *  record wherever project.references says it opens. A miss says what there is instead. */
export async function placeOf(
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
