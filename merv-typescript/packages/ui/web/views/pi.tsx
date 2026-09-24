import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  call,
  currentToken,
  identityVersion,
  projectSelection,
  scopeVersion,
  useScopeVersion,
} from '../api';
import {
  PiStreamError,
  readPiEvents,
  type PiConversation,
  type PiDelta,
  type PiEvent,
  type PiSnapshot,
} from '../pi-stream';
import type { ViewProps } from './index';

type TransientResponse = { commandId: string; text: string; progress: string };

const inFlight = (status: string) =>
  status === 'waiting' || status === 'starting' || status === 'working' || status === 'saving';
const accumulateResponse = (before: TransientResponse | null, event: PiEvent) => {
  const previous =
    before?.commandId === event.commandId
      ? before
      : { commandId: event.commandId, text: '', progress: '' };
  return event.type === 'text'
    ? { ...previous, text: (previous.text + event.text).slice(-16_384) }
    : { ...previous, progress: event.text.slice(-300) };
};
const identifier = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;

function PiConversationPage() {
  const [conversations, setConversations] = useState<PiConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PiSnapshot | null>(null);
  const [response, setResponse] = useState<TransientResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const conversationSelect = useRef<HTMLSelectElement>(null);
  const createId = useRef(identifier());
  const nextCreateId = useRef(identifier());
  const canonical = useRef<PiSnapshot | null>(null);
  const selection = useRef<string | null>(null);
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
            { commandId, text: '', progress: '' },
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        let items = await call<PiConversation[]>('pi.list');
        if (cancelled || !valid()) return;
        if (!items.length) {
          const created = await call<PiConversation>('pi.create', {
            requestId: createId.current,
            title: 'New conversation',
          });
          if (cancelled || !valid()) return;
          items = [created];
        }
        setConversations(items);
        setSelected((current) => {
          const next = current && items.some((item) => item.id === current) ? current : items[0].id;
          selection.current = next;
          return next;
        });
      } catch (cause) {
        if (!cancelled && valid())
          setError(cause instanceof Error ? cause.message : 'Could not open Agent');
      } finally {
        if (!cancelled && valid()) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      try {
        await readPiEvents(
          selected,
          controller.signal,
          (next) => {
            if (alive()) replace(next);
          },
          (delta: PiDelta) => {
            if (!alive()) return;
            const current = canonical.current;
            if (!current || current.streamId !== delta.streamId) {
              void refresh().catch(() => {
                if (alive()) setStreamError('Could not refresh Agent conversation');
              });
              return;
            }
            if (delta.sequence <= current.sequence) return;
            canonical.current = { ...current, sequence: delta.sequence };
            if (delta.type === 'changed') {
              void refresh().catch(() => {
                if (alive()) setStreamError('Could not refresh Agent conversation');
              });
            } else {
              setResponse((before) => accumulateResponse(before, delta));
            }
          },
        );
        if (alive()) setStreamError('Agent stream disconnected; reconnecting…');
      } catch (cause) {
        if (alive()) {
          setStreamError(cause instanceof Error ? cause.message : 'Agent stream disconnected');
          terminal = cause instanceof PiStreamError && [401, 403, 404, 410].includes(cause.status);
          if (terminal) setUnavailable(true);
        }
      }
      if (!alive() || terminal) return;
      timer = setTimeout(async () => {
        if (!alive()) return;
        try {
          await refresh();
        } catch (cause) {
          if (alive())
            setStreamError(cause instanceof Error ? cause.message : 'Could not refresh Agent');
        }
        if (alive()) void connect();
      }, 2000);
    };
    void refresh()
      .then(() => {
        if (alive()) void connect();
      })
      .catch((cause) => {
        if (alive())
          setError(cause instanceof Error ? cause.message : 'Could not load conversation');
      });
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selected, snapshotRetry]);

  const choose = (id: string) => {
    if (id === selected) return;
    selection.current = id;
    pending.current = null;
    setDraft('');
    setError('');
    setSelected(id);
  };
  const create = async () => {
    if (busy || unavailable) return;
    setBusy(true);
    setError('');
    try {
      const item = await call<PiConversation>('pi.create', {
        requestId: nextCreateId.current,
        title: newTitle.trim() || 'New conversation',
      });
      if (!valid()) return;
      nextCreateId.current = identifier();
      setNewTitle('');
      setConversations((items) => [item, ...items.filter((other) => other.id !== item.id)]);
      choose(item.id);
      conversationSelect.current?.focus();
    } catch (cause) {
      if (valid())
        setError(cause instanceof Error ? cause.message : 'Could not create conversation');
    } finally {
      if (valid()) setBusy(false);
    }
  };
  const send = async () => {
    if (!selected || busy || unavailable || active || !draft.trim() || !snapshot) return;
    const text = draft.trim();
    if (pending.current?.text !== text) pending.current = { id: identifier(), text };
    const commandId = pending.current.id;
    setBusy(true);
    setError('');
    try {
      await call('pi.send', { id: selected, commandId, text });
      if (!valid() || selection.current !== selected) return;
      setDraft((value) => (value.trim() === text ? '' : value));
      pending.current = null;
      try {
        replace(await call<PiSnapshot>('pi.snapshot', { id: selected }));
      } catch (cause) {
        if (valid())
          setStreamError(cause instanceof Error ? cause.message : 'Could not refresh Agent');
      }
    } catch (cause) {
      if (valid() && selection.current === selected)
        setError(cause instanceof Error ? cause.message : 'Could not send message');
    } finally {
      if (valid()) setBusy(false);
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
        setError(cause instanceof Error ? cause.message : 'Could not stop Agent');
    } finally {
      if (valid()) setBusy(false);
    }
  };
  const command = snapshot?.commands.find(
    (item) => item.id === snapshot.conversation.activeCommandId,
  );
  const latest = snapshot?.commands.at(-1);
  const status = command?.status ?? (latest?.status === 'interrupted' ? 'interrupted' : 'ready');
  const active = inFlight(status);
  const visible =
    response &&
    active &&
    response.commandId === command?.id &&
    !command.messages.some((message) => message.role === 'assistant')
      ? response
      : null;

  return (
    <div className="page-stage pi-page">
      <p className="page-summary">
        Read-only native-query pilot. Agent conversations do not create tasks or change records.
      </p>
      {loading && <p role="status">Opening conversations…</p>}
      {error && (
        <p className="pi-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !selected && (
        <button className="btn" type="button" onClick={() => setReload((value) => value + 1)}>
          Retry opening Agent
        </button>
      )}
      {selected && (
        <>
          <div className="pi-toolbar">
            <label htmlFor="pi-conversation">Conversation</label>
            <select
              id="pi-conversation"
              ref={conversationSelect}
              className="pi-select"
              value={selected}
              disabled={busy || unavailable}
              onChange={(event) => choose(event.target.value)}
            >
              {conversations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            <input
              className="pi-title"
              aria-label="New conversation title"
              placeholder="New conversation title"
              maxLength={200}
              value={newTitle}
              disabled={busy || unavailable}
              onChange={(event) => setNewTitle(event.target.value)}
            />
            <button
              className="btn"
              type="button"
              disabled={busy || unavailable}
              onClick={() => void create()}
            >
              New conversation
            </button>
          </div>
          {!snapshot ? (
            <>
              <p role="status">{error ? 'Conversation unavailable.' : 'Loading conversation…'}</p>
              {error && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setError('');
                    setSnapshotRetry((value) => value + 1);
                  }}
                >
                  Retry loading conversation
                </button>
              )}
            </>
          ) : (
            <>
              <div className="pi-state" role="status">
                <span className={`pi-state-dot${active ? ' pi-state-dot--active' : ''}`} />
                <span>
                  {unavailable
                    ? 'Unavailable'
                    : status === 'ready'
                      ? 'Ready'
                      : status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                {snapshot.conversation.runtimeId && (
                  <Link to={`/fleet/${encodeURIComponent(snapshot.conversation.runtimeId)}`}>
                    Fleet details
                  </Link>
                )}
              </div>
              <div className="pi-messages" aria-label="Conversation messages" aria-live="polite">
                {snapshot.commands.flatMap((item) =>
                  item.messages.map((message, index) => (
                    <article
                      className={`pi-message pi-message--${message.role}`}
                      key={`${item.id}-${index}`}
                    >
                      <span className="pi-speaker">
                        {message.role === 'user' ? 'You' : 'Agent'}
                      </span>
                      <div className="pi-message-text">{message.text}</div>
                    </article>
                  )),
                )}
                {visible && (visible.text || visible.progress) && (
                  <article className="pi-message pi-message--assistant pi-message--transient">
                    <span className="pi-speaker">Agent · live</span>
                    {visible.text && <div className="pi-message-text">{visible.text}</div>}
                    {visible.progress && <p className="muted">{visible.progress}</p>}
                  </article>
                )}
                {!snapshot.commands.length && (
                  <p className="muted">Ask Agent a question to begin. No task is created.</p>
                )}
              </div>
              {latest?.error && (
                <p className="pi-error" role="alert">
                  {latest.error}
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
              <form
                className="pi-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <label htmlFor="pi-draft">Message Agent</label>
                <textarea
                  id="pi-draft"
                  className="textarea"
                  rows={3}
                  maxLength={32_000}
                  value={draft}
                  disabled={busy || unavailable || active}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask a read-only question…"
                />
                <div className="pi-compose-actions">
                  <span className="muted">⌘/Ctrl + Enter to send</span>
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
                    disabled={busy || unavailable || active || !draft.trim()}
                  >
                    {busy
                      ? 'Working…'
                      : pending.current?.text === draft.trim()
                        ? 'Retry send'
                        : 'Send'}
                  </button>
                </div>
              </form>
            </>
          )}
        </>
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
