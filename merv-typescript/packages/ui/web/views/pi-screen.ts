/**
 * The page's side of screen.look: when the agent asks to see the screen, the page the person is
 * on answers with a snapshot of itself exactly as it stands, which Main has drawn and read
 * (packages/pi/src/screen.ts). Nothing runs in the drawing: its scripts are left out, its styles
 * are inlined, what was typed and how far each box was scrolled travel as attributes, and the
 * agent's own window and every password field stay behind.
 */
import { useEffect, useRef } from 'react';
import { call } from '../api';
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

/** Answers each look the conversation's snapshot shows, once, from the page in view. */
export function useScreenAnswer(pi: Conversation | null) {
  const answered = useRef<string>();
  const look = pi?.snapshot?.look?.id;
  const id = pi?.snapshot?.conversation.id;
  useEffect(() => {
    if (!look || !id || answered.current === look || document.visibilityState === 'hidden') return;
    answered.current = look;
    void call('pi.screen', { id, lookId: look, ...snapshotPage() }).catch(() => undefined);
  }, [look, id]);
}
