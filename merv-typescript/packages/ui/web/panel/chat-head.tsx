import { providerName } from '@merv/protocol/runtime';
import { createContext, useContext, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

import { useDismiss } from './use-dismiss';
import { useDeskCall } from './desk-calls';
import { type State, StateMark, ProviderMark } from './marks';
import { type Provider } from './rows';

/** The same title and menu live in the panel's first row at every width. */
export const ChatHeadSlot = createContext<HTMLElement | null>(null);
export function ChatHead(props: React.ComponentProps<typeof ChatHeadContent>) {
  const slot = useContext(ChatHeadSlot);
  const head = <ChatHeadContent {...props} />;
  return slot ? createPortal(head, slot) : head;
}

/** Every chat's head, Merv's or an agent's: who, what it is about, where, and how it stands. */
function ChatHeadContent({
  kind = 'main thread',
  mark,
  title,
  where,
  project,
  status,
  thread,
  cwd,
  terminal,
  onTerminal,
  branch,
  onError,
  named,
  plain,
  more,
  remote,
}: {
  remote?: boolean;
  /** The title is not the session's own name, so it is not renamed here. */ named?: boolean;
  /** A project's main thread: the head is the project's name, that it is the main thread, and the word "menu". Pressed, it opens the one menu where everything a head otherwise shows lives. */
  plain?: boolean;
  /** With `plain`: what kind of thread, after the name; empty for none. */
  kind?: React.ReactNode;
  /** With `plain`: what the head would have shown beside the name, as rows of that menu. */
  more?: { label: string; hint?: string; disabled?: boolean; title?: string; press(): void }[];
  branch?: string;
  onError?(message: string): void;
  mark: React.ReactNode;
  title: string;
  where?: string;
  project?: React.ReactNode;
  status?: React.ReactNode;
  thread?: string;
  cwd?: string;
  terminal?: { open: boolean; toggle(): void };
  onTerminal?(): void;
}) {
  const call = useDeskCall();
  const [menu, setMenu] = useState(false);
  const menuAt = useDismiss<HTMLSpanElement>(menu, () => setMenu(false));
  const [copied, setCopied] = useState(false);
  const [naming, setNaming] = useState<string>();
  const [namingBranch, setNamingBranch] = useState(false);
  const rename = (name: string) => {
    setNaming(undefined);
    if (thread && namingBranch) {
      setNamingBranch(false);
      if (name.trim() && name.trim() !== branch)
        void call(`threads/${thread}/branch`, { name: name.trim() }).catch((error) =>
          onError?.(error.message),
        );
    } else if (thread && name.trim() && name.trim() !== title)
      void call(`threads/${thread}/title`, { title: name.trim() }).catch((error) =>
        onError?.(error.message),
      );
  };
  // Where a session works is a way into it: the editor, Finder, or its path.
  const reveal = (how: 'editor' | 'finder') =>
    void call(`threads/${thread}/reveal`, { how })
      .catch(() => undefined)
      .finally(() => setMenu(false));
  const places = (
    <>
      <button disabled={remote} onClick={() => reveal('editor')}>
        Open in editor
      </button>
      <button disabled={remote} onClick={() => reveal('finder')}>
        Show in Finder
      </button>
      {onTerminal && (
        <button
          onClick={() => {
            setMenu(false);
            onTerminal();
          }}
        >
          Continue in terminal
        </button>
      )}
      <button
        disabled={!cwd}
        onClick={() =>
          void navigator.clipboard
            .writeText(cwd ?? '')
            .then(
              () => (setCopied(true), setTimeout(() => (setCopied(false), setMenu(false)), 900)),
            )
        }
      >
        {copied ? 'Copied' : 'Copy path'}
      </button>
    </>
  );
  // A plain head with nothing to offer (Merv's own thread, a job's page): the name alone, in the same place and type.
  if (plain && !more?.length && !terminal && !project && !cwd)
    return (
      <div className="thread-head is-plain">
        {mark}
        <span className="head-text">
          <span className="thread-title head-still" title={title}>
            <span className="head-name">
              {title}
              {kind && <span className="head-kind"> · {kind}</span>}
            </span>
          </span>
        </span>
        {status}
      </div>
    );
  if (plain)
    return (
      <div className="thread-head is-plain">
        {mark}
        <span className="head-text">
          <span className="plus" ref={menuAt}>
            <button
              type="button"
              className="thread-title is-button head-menu"
              aria-haspopup="true"
              aria-expanded={menu}
              aria-label={`${title}: terminal, project and folder`}
              title={typeof where === 'string' && where ? `${title} · ${where}` : title}
              onClick={() => setMenu(!menu)}
            >
              {/* Whose thread this is and what kind, then the word that says the line opens something: one press target. */}
              <span className="head-name">
                {title}
                {kind && <span className="head-kind"> · {kind}</span>}
              </span>
              <span className="head-word">menu</span>
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                {terminal && (
                  <button
                    aria-pressed={terminal.open}
                    onClick={() => {
                      setMenu(false);
                      terminal.toggle();
                    }}
                  >
                    <span>{terminal.open ? 'Hide terminal' : 'Terminal'}</span>
                    <kbd>⌘T</kbd>
                  </button>
                )}
                {more?.map((row) => (
                  <button
                    key={row.label}
                    disabled={row.disabled}
                    title={row.title}
                    onClick={() => {
                      setMenu(false);
                      row.press();
                    }}
                  >
                    <span>{row.label}</span>
                    {row.hint && <kbd>{row.hint}</kbd>}
                  </button>
                ))}
                {project}
                {/* Where a session works; a job's page has no folder of its own to offer. */}
                {(thread || cwd || remote) && places}
              </div>
            )}
          </span>
        </span>
      </div>
    );
  return (
    <div className="thread-head">
      {mark}
      <span className="head-text">
        {naming !== undefined ? (
          <input
            className="thread-title"
            aria-label={namingBranch ? 'Branch name' : 'Session name'}
            autoFocus
            value={naming}
            maxLength={120}
            onChange={(e) => setNaming(e.target.value)}
            onBlur={() => rename(naming)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') rename(naming);
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNaming(undefined);
                setNamingBranch(false);
              }
            }}
          />
        ) : thread && !named ? (
          <button
            className="thread-title is-button"
            title="Rename"
            onClick={() => setNaming(title)}
          >
            {title}
          </button>
        ) : (
          <span className="thread-title" title={title}>
            {title}
          </span>
        )}
        {(where || !!more?.length) &&
          (thread || more?.length ? (
            <span className="plus" ref={menuAt}>
              <button className="thread-where is-button" onClick={() => setMenu(!menu)}>
                {where || 'menu'}
              </button>
              {menu && (
                <div className="menu" onMouseLeave={() => setMenu(false)}>
                  {more?.map((row) => (
                    <button
                      key={row.label}
                      disabled={row.disabled}
                      onClick={() => {
                        setMenu(false);
                        row.press();
                      }}
                    >
                      {row.label}
                    </button>
                  ))}
                  {branch && (
                    <button
                      onClick={() => {
                        setMenu(false);
                        setNamingBranch(true);
                        setNaming(branch);
                      }}
                    >
                      Rename branch
                    </button>
                  )}
                  {places}
                </div>
              )}
            </span>
          ) : (
            <span className="thread-where">{where}</span>
          ))}
        {project}
      </span>
      {terminal && (
        <button
          type="button"
          className="terminal-toggle quiet"
          title="Terminal"
          aria-label="Toggle terminal"
          aria-pressed={terminal.open}
          onClick={terminal.toggle}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
          >
            <path d="m3 4 4 4-4 4m6 0h4" />
          </svg>
        </button>
      )}
      {status}
    </div>
  );
}

/** When each turn was first seen running, so a reconnect never starts its clock again. */
const turnStarted = new Map<string, number>();

/** How a session stands, in a word: working with how long, else its mark. */
export function Status({
  state,
  turn,
  replying,
}: {
  state: State;
  turn: string | null;
  replying?: { provider: Provider; title: string };
}) {
  if (turn && !turnStarted.has(turn)) turnStarted.set(turn, Date.now());
  const since = (turn && turnStarted.get(turn)) || Date.now();
  const [, tick] = useState(0);
  useEffect(() => {
    if (state !== 'running') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  // Always a slot of one width, so the head never shifts as a turn starts and ends.
  if (state !== 'running')
    return <span className="status">{state !== 'idle' && <StateMark state={state} />}</span>;
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <span className="status is-running">
      {replying ? (
        <span title={`Replying to ${providerName(replying.provider)} · ${replying.title}`}>
          <ProviderMark provider={replying.provider} size={12} />
        </span>
      ) : (
        <StateMark state="running" />
      )}{' '}
      {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`}
    </span>
  );
}
