/** The panel's small shared parts: one row, one head button, one send button, drawn the same in
 *  Merv.app and in the web's sidebar. They show what they are given and call nothing themselves. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { MervMark, ProviderMark, StateMark, type State } from './marks';

export const BACK = 'M11 4 6 9l5 5';
export const PLUS = 'M9 3.5v11M3.5 9h11';
/** The chat takes the window, the board beside it (Merv.app's ⌘\). */
export const CHAT_FIRST =
  'M3.5 4h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM7 4v10';

/** A button in the panel's head: the way back, or a new session. */
export function HeadButton({
  label,
  path,
  title,
  ...button
}: { label: string; path: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className="icon" aria-label={label} title={title ?? label} {...button}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** One session in the list: whose it is, what it is about, when it last moved and how it stands.
 *  `quiet` greys a name that only repeats its folder's; `where` is the folder, after a lone row's name;
 *  `aside` is what stands before the state mark: the row's age, or its pin and controls. */
export function SessionRow({
  provider,
  title,
  quiet,
  where,
  more,
  aside,
  state,
  past,
  className,
  ...button
}: {
  provider: 'claude' | 'codex';
  title: string;
  quiet?: boolean;
  where?: string | false;
  more?: ReactNode;
  aside?: ReactNode;
  state: State;
  past?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>) {
  return (
    <button
      {...button}
      className={`row${past ? ' is-past' : ''}${state === 'running' ? ' is-working' : ''}${className ? ` ${className}` : ''}`}
    >
      <ProviderMark provider={provider} />
      <span className="row-title">
        <span className={`row-text${quiet ? ' row-quiet' : ''}`}>{title}</span>
        {where && (
          <span className="row-more" title={where}>
            {' '}
            · {where}
          </span>
        )}
        {more}
      </span>
      {aside}
      <StateMark state={state} />
    </button>
  );
}

/** Merv heads the list: the board's own agent, its orb and, when it waits on the person, a word. */
export function MervRow({
  working,
  note,
  ...button
}: { working?: boolean; note?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...button} className="row merv-row">
      <MervMark working={working} />
      <span className="row-title">Merv</span>
      <span className="row-age">{note}</span>
    </button>
  );
}

/** The composer's one button: send while idle, stop while a turn runs. */
export function Send({
  running,
  ready,
  onStop,
  title,
  stopTitle,
  disabled,
}: {
  running?: boolean;
  ready: boolean;
  onStop?(): void;
  title?: string;
  stopTitle?: string;
  disabled?: boolean;
}) {
  const stop = running && onStop;
  return (
    <button
      type={stop ? 'button' : 'submit'}
      className={`send${stop ? ' is-stop' : ''}`}
      aria-label={stop ? 'Stop' : 'Send'}
      title={stop ? (stopTitle ?? 'Stop (⌘.)') : (title ?? 'Send (⏎)')}
      disabled={stop ? disabled : disabled || !ready}
      onClick={stop ? onStop : undefined}
    >
      {stop ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M7 11.5V2.5M3 6.5l4-4 4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/** A turn under way with nothing moving on the page, no step running and no words arriving, still says it is alive.
 *  answered: the turn's answer is already on the page, so what still runs is not the model thinking
 *  but what it left running (background commands, background helpers, hooks). */
export function Thinking({
  provider,
  answered,
}: {
  provider?: 'claude' | 'codex';
  answered?: boolean;
}) {
  return (
    <p className="turn-thinking" role="status">
      <span className={`trail-live${provider ? ` is-${provider}` : ''}`} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {answered ? 'Working in the background' : 'Thinking'}
    </p>
  );
}
/** Whether the last thing on the page is the agent's own words, set down whole: a quiet session
 *  after that is finishing work in the background, not thinking of what to say. */
export const answered = (last: { type?: string; role?: string; text?: string } | undefined) =>
  (last?.type ?? last?.role) === 'assistant' && !!last?.text?.trim();
