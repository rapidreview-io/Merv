import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  call,
  currentToken,
  identityVersion,
  projectSelection,
  scopeVersion,
  useScopeVersion,
} from '../api';
import { Ago, useNow } from '../components';
import { ChevronsIcon } from '../icons';
import { Markdown } from '../markdown';
import {
  PiStreamError,
  readPiEvents,
  type PiConversation,
  type PiDelta,
  type PiEvent,
  type PiSnapshot,
} from '../pi-stream';
import { stepped } from '../record-picker';
import type { ViewProps } from './index';

/** The answer as it streams; `written` is the sequence of its latest words. */
type TransientResponse = { commandId: string; text: string; progress: string; written: number };

const inFlight = (status: string) =>
  status === 'waiting' || status === 'starting' || status === 'working' || status === 'saving';
const accumulateResponse = (before: TransientResponse | null, event: PiEvent) => {
  const previous =
    before?.commandId === event.commandId
      ? before
      : { commandId: event.commandId, text: '', progress: '', written: 0 };
  return event.type === 'text'
    ? { ...previous, text: (previous.text + event.text).slice(-16_384), written: event.sequence }
    : { ...previous, progress: event.text.slice(-300) };
};
const identifier = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;

/** A machine is found, then prepared, then the model answers and its memory is written. */
const STATUS: Record<string, string> = {
  ready: 'Ready',
  waiting: 'Waiting for a free machine',
  starting: 'Preparing a machine',
  working: 'Answering',
  saving: 'Saving',
  interrupted: 'Stopped',
};
/** What the person waits on, in a cold turn's order; the waits count their seconds. */
const STAGE: Record<string, string> = {
  idle: 'Idle',
  queued: 'Waiting for a free machine',
  machine: 'Starting a machine',
  agent: 'Loading the agent',
  ready: 'Agent ready',
  thinking: 'Thinking',
  tool: 'Using a tool',
  writing: 'Writing…',
  saving: 'Saving…',
};
const WAITS = ['queued', 'machine', 'agent', 'thinking'];
/** Why a turn ended early, with the step after it. Stopping it yourself needs no sentence. */
const STOPPED: Record<string, string> = {
  worker_interrupted: 'The agent stopped unexpectedly. Ask again.',
  runtime_lost: 'The agent’s machine went away. Ask again.',
  runtime_refused: 'No machine could be started for the agent. Ask again later.',
  runtime_stopped: 'The agent’s machine was stopped. Ask again.',
  turn_expired: 'The answer took too long. Ask again.',
  service_unavailable: 'The agent service is unavailable. Ask again later.',
  ambiguous_prompt: 'The question may not have reached the agent. Ask again.',
  checkpoint_unavailable: 'The answer could not be saved. Ask again.',
};
const NOT_SET_UP = 'Agent isn’t set up for this project yet.';
/** What the server calls a conversation until Pi names it; until then its first question does. */
const UNNAMED = 'New conversation';
const clip = (text: string) => (text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text);
const RECONNECTING = 'Reconnecting…';
/** A refusal in the server's own words where it wrote them for a person, otherwise one sentence. */
const said = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.code === 'pi_runtime_releasing')
    return 'The previous agent is still finishing. Send again in a moment.';
  if (cause.status === 0) return 'Merv didn’t answer. Try again.';
  if (cause.status >= 500 || cause.code.startsWith('http_') || cause.code === 'invalid_response')
    return 'Something went wrong on the server. Try again.';
  return cause.message;
};
/** The previous agent refuses for a moment while it is released; the same request asks again. */
async function whileReleasing<T>(
  request: () => Promise<T>,
  alive: () => boolean,
  waiting = () => {},
) {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      return await request();
    } catch (cause) {
      const releasing = cause instanceof ApiError && cause.code === 'pi_runtime_releasing';
      if (!releasing || Date.now() > until) throw cause;
      waiting();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!alive()) return null;
    }
  }
}
/** Starts the agent's machine before anything is sent, quietly: it never holds up a question. */
const warm = (id: string | null, alive: () => boolean, requestId = identifier()) => {
  const input = { requestId, ...(id ? { conversationId: id } : {}) };
  return whileReleasing(() => call<PiSnapshot>('pi.warm', input), alive).catch(() => null);
};
/** How long the current wait has lasted by the server's clock, `skew` ms ahead of this one; a
 * screen reader hears only what is waited on. */
function Seconds({ since, skew }: { since: string; skew: number }) {
  const now = useNow(1000);
  return (
    <span className="tabular" aria-hidden="true">
      {` · ${Math.max(0, Math.floor((now + skew - Date.parse(since)) / 1000)) || 0} s`}
    </span>
  );
}

function PiConversationPage() {
  const [conversations, setConversations] = useState<PiConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PiSnapshot | null>(null);
  const [response, setResponse] = useState<TransientResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const switcher = useRef<HTMLDivElement>(null);
  // The transcript follows new text until the reader scrolls away from its end.
  const following = useRef(true);
  const createId = useRef(identifier());
  const canonical = useRef<PiSnapshot | null>(null);
  // How far the server's clock ran ahead of this one when the latest snapshot arrived.
  const skew = useRef(0);
  const selection = useRef<string | null>(null);
  // The page's first conversation warms at once; another only once a question is begun in it.
  const eager = useRef(true);
  const warming = useRef<string | null>(null);
  const scope = useRef({
    epoch: scopeVersion(),
    identity: identityVersion(),
    project: projectSelection(),
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const valid = () =>
    mounted.current &&
    scope.current.epoch === scopeVersion() &&
    scope.current.identity === identityVersion() &&
    scope.current.project === projectSelection();

  const replace = (next: PiSnapshot) => {
    if (!valid() || selection.current !== next.conversation.id) return;
    const previous = canonical.current;
    if (previous?.streamId === next.streamId && previous.sequence > next.sequence) return;
    canonical.current = next;
    skew.current = Date.parse(next.now ?? '') - Date.now() || 0;
    setSnapshot(next);
    const tail = next.tail
      .filter((event) => event.type === 'text' || event.type === 'progress')
      .sort((left, right) => left.sequence - right.sequence);
    const commandId = next.conversation.activeCommandId;
    setResponse(
      commandId
        ? tail.reduce<TransientResponse>(
            (transient, event) =>
              event.commandId !== commandId ? transient : accumulateResponse(transient, event),
            { commandId, text: '', progress: '', written: 0 },
          )
        : null,
    );
    if (pending.current && next.commands.some((command) => command.id === pending.current?.id)) {
      setDraft((value) => (value.trim() === pending.current?.text ? '' : value));
      pending.current = null;
      setError('');
    }
    setConversations((items) =>
      items.map((item) => (item.id === next.conversation.id ? next.conversation : item)),
    );
    setStreamError('');
  };
  const choose = (id: string) => {
    selection.current = id;
    following.current = true;
    setSelected(id);
  };
  const adopt = (item: PiConversation) => {
    createId.current = identifier();
    setConversations((items) => [item, ...items.filter((other) => other.id !== item.id)]);
    choose(item.id);
  };
  /** Starts a machine for the open conversation if it has none; merely looking at one leaves the
   * person's warm machine where it is. */
  const warmUp = () => {
    const id = selection.current;
    const current = canonical.current;
    const item = current?.conversation;
    if (!id || warming.current === id || item?.id !== id || !current?.available) return;
    if (item.runtimeId || item.activeCommandId) return;
    warming.current = id;
    void warm(id, () => valid() && selection.current === id).then((next) => {
      if (warming.current === id) warming.current = null;
      if (next) replace(next);
    });
  };

  // Opening the page reads the conversations there are and opens the one whose machine is warm,
  // else the newest; with none, warming the agent opens one.
  useEffect(() => {
    let cancelled = false;
    const fresh = () => !cancelled && valid() && !selection.current;
    setError('');
    call<PiConversation[]>('pi.list').then(
      (items) => {
        if (cancelled || !valid()) return;
        setConversations(items);
        const kept =
          items.find((item) => item.id === selection.current) ??
          items.find((item) => item.runtimeId) ??
          items[0];
        if (kept) choose(kept.id);
        // A question sent while this waits out a release opens the same conversation, not another.
        else
          void warm(null, fresh, createId.current).then((next) => {
            if (next && fresh()) adopt(next.conversation);
          });
        setListed(true);
      },
      (cause) => {
        if (!cancelled && valid()) setError(said(cause, 'Could not open Agent.'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Consecutive failures space the next attempt out, up to half a minute.
    let failures = 0;
    const controller = new AbortController();
    const alive = () =>
      !stopped && !controller.signal.aborted && valid() && selection.current === selected;
    canonical.current = null;
    setSnapshot(null);
    setResponse(null);
    setStreamError('');
    setUnavailable(false);
    const refresh = async () => {
      const next = await call<PiSnapshot>('pi.snapshot', { id: selected });
      if (alive()) replace(next);
    };
    const connect = async () => {
      let busyStream = false;
      try {
        const since = Date.now();
        const rotated = await readPiEvents(
          selected,
          controller.signal,
          (next) => {
            failures = 0;
            if (alive()) replace(next);
          },
          (delta: PiDelta) => {
            if (!alive()) return;
            const current = canonical.current;
            if (!current || current.streamId !== delta.streamId)
              return void refresh().catch(() => {});
            if (delta.sequence <= current.sequence) return;
            canonical.current = { ...current, sequence: delta.sequence };
            if (delta.type === 'changed') void refresh().catch(() => {});
            else setResponse((before) => accumulateResponse(before, delta));
          },
        );
        if (!alive()) return;
        // The server closes every stream after a while and says so first: that is no news, and
        // a stream that lived is reopened at once.
        if (!rotated) setStreamError(RECONNECTING);
        else if (Date.now() - since > 5000) return void connect();
      } catch (cause) {
        if (!alive()) return;
        if (cause instanceof PiStreamError && [401, 403, 404, 410].includes(cause.status)) {
          setStreamError('This conversation isn’t available right now.');
          setUnavailable(true);
          return;
        }
        // Too many pages hold this conversation open: this one waits its turn quietly.
        busyStream = cause instanceof PiStreamError && cause.status === 429;
        if (!busyStream) setStreamError(RECONNECTING);
      }
      if (!alive()) return;
      timer = setTimeout(
        async () => {
          if (!alive()) return;
          await refresh().catch(() => {});
          if (alive()) void connect();
        },
        Math.min(30_000, (busyStream ? 5000 : 2000) * 2 ** failures++),
      );
    };
    void refresh()
      .catch(() => {})
      .then(() => {
        if (!alive()) return;
        void connect();
        // New conversation hands the composer the cursor, which begins a question there too.
        if (eager.current || document.activeElement === composer.current) warmUp();
        eager.current = false;
      });
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selected, snapshotRetry]);

  const command = snapshot?.commands.find(
    (item) => item.id === snapshot.conversation.activeCommandId,
  );
  const latest = snapshot?.commands.at(-1);
  const status = command?.status ?? (latest?.status === 'interrupted' ? 'interrupted' : 'ready');
  const active = inFlight(status);
  const blocked = refused || snapshot?.available === false;
  const alert =
    error ||
    (latest?.error && latest.error !== 'cancelled'
      ? (STOPPED[latest.error] ?? 'The agent stopped. Ask again.')
      : '');
  const visible =
    response &&
    active &&
    response.commandId === command?.id &&
    !command.messages.some((message) => message.role === 'assistant')
      ? response
      : null;
  const stage = snapshot?.stage;
  // Words streamed after the stage was read say the answer is being written before it does.
  const step =
    stage?.name === 'thinking' && snapshot && (visible?.written ?? 0) > snapshot.sequence
      ? 'writing'
      : (stage?.name ?? '');
  const phrase = (step === 'tool' && stage?.detail) || STAGE[step];
  // The words, their dot, and when the wait they name began: a wait counts its seconds, but not
  // while the stream that would end it is away.
  const [words, tone, since]: [string, string, string?] = unavailable
    ? ['Unavailable', '']
    : finishing
      ? ['Finishing the previous agent…', 'active']
      : !phrase
        ? [STATUS[status] ?? 'Ready', active ? 'active' : '']
        : WAITS.includes(step)
          ? [phrase, 'active', streamError ? undefined : stage?.since]
          : [phrase, active ? 'active' : step === 'ready' ? 'ready' : ''];
  const state = (
    <>
      <span className={`pi-state-dot${tone && ` pi-state-dot--${tone}`}`} />
      <span>
        {words}
        {since && <Seconds since={since} skew={skew.current} />}
      </span>
    </>
  );
  useLayoutEffect(() => {
    const list = transcript.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  });
  const named = snapshot?.conversation ?? conversations.find((item) => item.id === selected);
  const asked = snapshot?.commands[0]?.messages[0]?.text.replace(/\s+/g, ' ').trim();
  const title = named && named.title !== UNNAMED ? named.title : asked ? clip(asked) : UNNAMED;
  // Operated as the account menu is: the cursor goes to its first item, the arrows, Home and
  // End move it, Escape hands it back to the button, and Tab or a click elsewhere shuts it.
  useEffect(() => {
    if (!menu) return;
    const items = () => [
      ...(switcher.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    items()[0]?.focus();
    const click = (event: MouseEvent) => {
      if (!switcher.current?.contains(event.target as Node)) setMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        switcher.current?.querySelector('button')?.focus();
      } else if (event.key === 'Tab') setMenu(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const all = items();
        all[
          stepped(all.indexOf(document.activeElement as HTMLElement), all.length, event.key)
        ]?.focus();
        event.preventDefault();
      }
    };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);

  const open = async () => {
    const item = await call<PiConversation>('pi.create', { requestId: createId.current });
    if (!valid()) return null;
    adopt(item);
    return item.id;
  };
  // A new conversation opens at once and never locks the composer: a question sent before the
  // server answers goes to the conversation this creates, because pi.create is keyed by createId.
  const create = () => {
    pending.current = null;
    selection.current = null;
    canonical.current = null;
    setSelected(null);
    setSnapshot(null);
    setDraft('');
    setError('');
    composer.current?.focus();
    call<PiConversation>('pi.create', { requestId: createId.current }).then(
      (item) => {
        if (valid() && !selection.current) adopt(item);
      },
      (cause) => {
        if (valid() && !selection.current)
          setError(said(cause, 'Could not create a conversation.'));
      },
    );
  };
  const send = async () => {
    const text = draft.trim();
    if (busy || blocked || unavailable || active || !text) return;
    if (pending.current?.text !== text) pending.current = { id: identifier(), text };
    const commandId = pending.current.id;
    let id = selection.current;
    setBusy(true);
    setError('');
    try {
      id ??= await open();
      if (!id) return;
      await whileReleasing(
        () => call('pi.send', { id, commandId, text }),
        () => valid() && selection.current === id,
        () => setFinishing(true),
      );
      if (!valid() || selection.current !== id) return;
      setDraft((value) => (value.trim() === text ? '' : value));
      pending.current = null;
      following.current = true;
      const next = await call<PiSnapshot>('pi.snapshot', { id }).catch(() => null);
      if (next) replace(next);
    } catch (cause) {
      if (!valid() || selection.current !== id) return;
      if (cause instanceof ApiError && cause.code === 'sandbox_not_connected') setRefused(true);
      else setError(said(cause, 'Could not send the message.'));
    } finally {
      if (valid()) {
        setBusy(false);
        setFinishing(false);
        composer.current?.focus();
      }
    }
  };
  const stop = async () => {
    if (!selected || busy || unavailable || !active) return;
    setBusy(true);
    setError('');
    try {
      replace(await call<PiSnapshot>('pi.stop', { id: selected }));
    } catch (cause) {
      if (valid() && selection.current === selected)
        setError(said(cause, 'Could not stop the agent.'));
    } finally {
      if (valid()) setBusy(false);
    }
  };

  return (
    <div className="page-stage pi-page">
      {!listed && !error && <p role="status">Opening conversations…</p>}
      {listed && (
        <div className="pi-bar">
          <div className="pi-switch" ref={switcher}>
            <button
              type="button"
              className="pi-switch-button"
              aria-haspopup="menu"
              aria-expanded={menu}
              title={title}
              disabled={busy}
              onClick={() => setMenu((value) => !value)}
            >
              <span>{title}</span>
              <ChevronsIcon />
            </button>
            {menu && (
              <div className="pi-menu" role="menu" aria-label="Conversations">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="pi-menu-item"
                  onClick={() => {
                    setMenu(false);
                    create();
                  }}
                >
                  New conversation
                </button>
                {[...conversations]
                  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="pi-menu-item"
                      aria-current={item.id === selected || undefined}
                      onClick={() => {
                        setMenu(false);
                        switcher.current?.querySelector('button')?.focus();
                        if (item.id === selected) return;
                        pending.current = null;
                        setDraft('');
                        setError('');
                        choose(item.id);
                      }}
                    >
                      <span>{item.id === selected ? title : item.title}</span>
                      <Ago at={item.updatedAt} />
                    </button>
                  ))}
              </div>
            )}
          </div>
          {!blocked && (snapshot || finishing) && (
            <div className="pi-state" role="status">
              {state}
              {snapshot?.conversation.runtimeId && (
                <Link to={`/fleet/${encodeURIComponent(snapshot.conversation.runtimeId)}`}>
                  Fleet details
                </Link>
              )}
            </div>
          )}
        </div>
      )}
      {listed && (
        <div
          className="pi-messages"
          ref={transcript}
          aria-label="Conversation messages"
          aria-live="polite"
          onScroll={(event) => {
            const list = event.currentTarget;
            following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          }}
        >
          {snapshot?.commands.flatMap((item) =>
            item.messages.map((message, index) => (
              <article
                className={`pi-message pi-message--${message.role}`}
                key={`${item.id}-${index}`}
              >
                <span className="pi-speaker">{message.role === 'user' ? 'You' : 'Agent'}</span>
                {message.role === 'user' ? (
                  <div className="pi-message-text">{message.text}</div>
                ) : (
                  <Markdown source={message.text} />
                )}
              </article>
            )),
          )}
          {visible && (visible.text || visible.progress) && (
            <article className="pi-message pi-message--assistant pi-message--transient">
              <span className="pi-speaker">Agent · live</span>
              {visible.text && <Markdown source={visible.text} />}
              {visible.progress && <p className="muted">{visible.progress}</p>}
            </article>
          )}
          {active && !unavailable && (
            // Where the eye waits; the bar above already says it aloud.
            <p className="pi-state" aria-hidden="true">
              {state}
            </p>
          )}
          {selected && !snapshot ? (
            <p className="muted">Loading conversation…</p>
          ) : blocked ? (
            <p className="muted" role="status">
              {NOT_SET_UP}
            </p>
          ) : (
            !snapshot?.commands.length && <p className="muted">Ask a question to begin.</p>
          )}
        </div>
      )}
      {alert && (
        <p className="pi-error" role="alert">
          {alert}
        </p>
      )}
      {streamError && (
        <p className="muted" role="status">
          {streamError}
        </p>
      )}
      {unavailable && (
        <button
          className="btn"
          type="button"
          onClick={() => setSnapshotRetry((value) => value + 1)}
        >
          Retry connection
        </button>
      )}
      {!listed && error && (
        <button className="btn" type="button" onClick={() => setReload((value) => value + 1)}>
          Retry opening Agent
        </button>
      )}
      {listed && (
        <form
          className="pi-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="pi-draft" className="sr-only">
            Message Agent
          </label>
          <textarea
            id="pi-draft"
            ref={composer}
            className="textarea"
            rows={3}
            maxLength={32_000}
            value={draft}
            // Read-only rather than disabled while sending, so the cursor stays where it was.
            readOnly={busy}
            disabled={blocked}
            onFocus={warmUp}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="pi-compose-actions">
            {active && (
              <button
                className="btn"
                type="button"
                disabled={busy || unavailable}
                onClick={() => void stop()}
              >
                Stop
              </button>
            )}
            <button
              className="btn btn--primary"
              type="submit"
              disabled={busy || blocked || unavailable || active || !draft.trim()}
            >
              {busy ? 'Sending…' : pending.current?.text === draft.trim() ? 'Retry send' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function PiView({ row }: ViewProps) {
  const scope = useScopeVersion();
  if (row.status.state === 'unavailable')
    return (
      <div className="page-stage pi-page">
        <p role="status">Agent unavailable. {row.status.detail}</p>
      </div>
    );
  if (!projectSelection() || !currentToken())
    return (
      <div className="page-stage pi-page">
        <p role="status">Agent unavailable. Select a project and sign in to continue.</p>
      </div>
    );
  return <PiConversationPage key={`${scope}:${row.id}`} />;
}
