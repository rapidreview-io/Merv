import {
  createElement as el,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type PointerEventHandler,
} from 'react';

/** What was typed, as somewhere to go: an address, or a search. */
export const addressOf = (typed: string) => {
  const text = typed.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(text)}`;
};
/** An address as its bar shows it at rest: the site, and where on it. */
export const site = (url: string) => {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname === '/' || pathname === '/webhp' ? '' : pathname}`;
  } catch {
    return url;
  }
};
/** A search page that lets itself be framed. */
export const HOME_PAGE = 'https://www.google.com/webhp?igu=1';
/** Asks the open board to take a page, where a browser outside the board has one worth keeping. */
export const PUT_PAGE = 'merv:put-page';

export const pageSandbox = (url: string, topNavigation: boolean) =>
  `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads${topNavigation ? ' allow-top-navigation-by-user-activation' : ''}${URL.parse(url)?.origin === location.origin ? '' : ' allow-same-origin'}`;

export function AddressBar({
  className,
  trail,
  visit,
  reload,
  field: supplied,
  onPointerDown,
  spellCheck,
  children,
}: {
  className: string;
  trail: { urls: string[]; at: number };
  visit(url: string, step?: number): void;
  reload(): void;
  field?: RefObject<HTMLInputElement>;
  onPointerDown?: PointerEventHandler<HTMLFormElement>;
  spellCheck?: boolean;
  children?: ReactNode;
}) {
  const local = useRef<HTMLInputElement>(null),
    field = supplied ?? local;
  const [typing, setTyping] = useState<string>();
  const shown = trail.urls[trail.at]!;
  const button = (name: string, path: string, disabled: boolean, onClick: () => void) =>
    el(
      'button',
      { type: 'button', 'aria-label': name, title: name, disabled, onClick },
      el(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true },
        el('path', {
          d: path,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ),
    );
  return el(
    'form',
    {
      className,
      onPointerDown,
      onSubmit: (event) => {
        event.preventDefault();
        if (typing?.trim()) visit(addressOf(typing));
        setTyping(undefined);
        field.current?.blur();
      },
    },
    button('Back', 'M10 3L5 8l5 5', !trail.at, () => visit(trail.urls[trail.at - 1]!, -1)),
    button('Forward', 'M6 3l5 5-5 5', trail.at === trail.urls.length - 1, () =>
      visit(trail.urls[trail.at + 1]!, 1),
    ),
    button('Reload', 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5', false, reload),
    el('input', {
      ref: field,
      'aria-label': 'Address',
      placeholder: 'Search or go to a site',
      value: typing ?? site(shown),
      spellCheck,
      onFocus: (event) => {
        setTyping(shown);
        requestAnimationFrame(() => event.target.select());
      },
      onBlur: () => setTyping(undefined),
      onChange: (event) => setTyping(event.target.value),
      onKeyDown: (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') field.current?.blur();
      },
    }),
    children,
  );
}
