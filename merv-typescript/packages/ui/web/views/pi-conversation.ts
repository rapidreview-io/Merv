import { useEffect, useRef, useState } from 'react';
import { ApiError, call } from '../api';
import { StreamError } from '../event-stream';
import { useCurrent } from '../mutations';
import { readPiEvents, type PiDelta } from '../pi-stream';
import type {
  PiConversation,
  PiEvent,
  PiHostView,
  PiProposal,
  PiRan,
  PiSnapshot,
} from '@merv/pi/models';

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
    ? { ...previous, text: previous.text + event.text, written: event.sequence }
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
/** What the server calls a conversation until Pi names it; until then its first question does. */
const UNNAMED = 'New conversation';
const clip = (text: string) => (text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text);
const RECONNECTING = 'Reconnecting…';
/** A refusal in the server's own words where it wrote them for a person, otherwise one sentence. */
const said = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 0) return 'Merv didn’t answer. Try again.';
  if (cause.status >= 500 || cause.code.startsWith('http_') || cause.code === 'invalid_response')
    return 'Something went wrong on the server. Try again.';
  return cause.message;
};
/** Starts the person's machine here before anything is sent, quietly: it never holds up a
 * question. */
const warm = (id: string | null, requestId = identifier()) =>
  call<PiSnapshot>('pi.warm', { requestId, ...(id ? { conversationId: id } : {}) }).catch(
    () => null,
  );
/**
 * The open conversation: what the Agent page held, read, streamed and sent, now held by
 * `PiProvider` so that it outlives the page. It begins as the page did when it opened.
 */
export function useConversation() {
  const [conversations, setConversations] = useState<PiConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PiSnapshot | null>(null);
  const [response, setResponse] = useState<TransientResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The proposal running now, and full results held here alone, for the person.
  const [running, setRunning] = useState<string | null>(null);
  const [localResults, setLocalResults] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const pending = useRef<{ id: string; text: string } | null>(null);
  // The calls whose outcome this page has told the agent, or is telling it now.
  const telling = useRef(new Set<string>());
  // The latest model pick on its way, which a send in that conversation waits for.
  const picking = useRef<{ id: string; done: Promise<boolean> } | null>(null);
  // The composer and the transcript drawn now, on the page or in the dock: never both at once.
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  // The transcript follows new text until the reader scrolls away from its end.
  const following = useRef(true);
  const createId = useRef(identifier());
  const canonical = useRef<PiSnapshot | null>(null);
  // How far the server's clock ran ahead of this one when the latest snapshot arrived.
  const skew = useRef(0);
  const selection = useRef<string | null>(null);
  // The page's first conversation warms at once; another only once a question is begun in it.
  const eager = useRef(true);
  const warming = useRef(false);
  // The account and project it opened for: `Live` is keyed by scope, so it never outlives them.
  const valid = useCurrent();

  const replace = (next: PiSnapshot) => {
    if (!valid() || selection.current !== next.conversation.id) return;
    const previous = canonical.current;
    if (previous?.streamId === next.streamId && previous.sequence > next.sequence) return;
    canonical.current = next;
    skew.current = Date.parse(next.now) - Date.now() || 0;
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
  /** Starts the person's machine here when there is none, as the page opens or a question is
   * begun; merely looking at a conversation, after the machine stopped, starts nothing. */
  const warmUp = () => {
    const id = selection.current;
    const current = canonical.current;
    if (!id || warming.current || current?.conversation.id !== id || !current.available) return;
    if (current.host.state !== 'none') return;
    warming.current = true;
    void warm(id).then((next) => {
      warming.current = false;
      if (next) replace(next);
    });
  };

  // Opening the page reads the conversations there are and opens the newest; with none, warming
  // the agent opens one.
  useEffect(() => {
    let cancelled = false;
    const fresh = () => !cancelled && valid() && !selection.current;
    setError('');
    call<PiConversation[]>('pi.list').then(
      (items) => {
        if (cancelled || !valid()) return;
        setConversations(items);
        const kept = items.find((item) => item.id === selection.current) ?? items[0];
        if (kept) choose(kept.id);
        // A question sent before this answers opens the same conversation, not another.
        else
          void warm(null, createId.current).then((next) => {
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
        if (cause instanceof StreamError && [401, 403, 404, 410].includes(cause.status)) {
          setStreamError('This conversation isn’t available right now.');
          setUnavailable(true);
          return;
        }
        // Too many pages hold this conversation open: this one waits its turn quietly.
        busyStream = cause instanceof StreamError && cause.status === 429;
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
  const proposing = snapshot?.commands.filter((item) => item.proposals?.length).at(-1);
  const status = command?.status ?? (latest?.status === 'interrupted' ? 'interrupted' : 'ready');
  const active = inFlight(status);
  const blocked = refused || snapshot?.available === false;
  const visible =
    response &&
    active &&
    response.commandId === command?.id &&
    !command.messages.some((message) => message.role === 'assistant')
      ? response
      : null;
  const stage = snapshot?.stage;
  const host = snapshot?.host;
  // Words streamed after the stage was read say the answer is being written before it does. A
  // move leaves the machine it runs on serving, and the machine's own note counts the move; with
  // that machine gone, the conversation waits on the one starting.
  const step =
    stage?.name === 'moving'
      ? host?.machine
        ? 'ready'
        : 'machine'
      : stage?.name === 'thinking' && snapshot && (visible?.written ?? 0) > snapshot.sequence
        ? 'writing'
        : (stage?.name ?? '');
  const phrase = (step === 'tool' && stage?.detail) || STAGE[step];
  // The words, their dot, and when the wait they name began: a wait counts its seconds, but not
  // while the stream that would end it is away.
  const standing: [string, string, string?] = unavailable
    ? ['Unavailable', '']
    : !phrase
      ? [STATUS[status] ?? 'Ready', active ? 'active' : '']
      : WAITS.includes(step)
        ? [phrase, 'active', streamError ? undefined : stage?.since]
        : [phrase, active ? 'active' : step === 'ready' ? 'ready' : ''];
  const follow = useRef(() => {
    const list = transcript.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }).current;
  const named = snapshot?.conversation ?? conversations.find((item) => item.id === selected);
  const asked = snapshot?.commands[0]?.messages[0]?.text.replace(/\s+/g, ' ').trim();
  const title = named && named.title !== UNNAMED ? named.title : asked ? clip(asked) : UNNAMED;

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
  /** Whether the words reached the server; `commandId` names the turn they start, where it is
   * theirs before they are sent. */
  const send = async (text = draft.trim(), commandId?: string): Promise<boolean> => {
    if (busy || blocked || unavailable || active || !text) return false;
    let id = selection.current;
    setBusy(true);
    try {
      // A pick on its way goes first; one that failed keeps the question, and says why.
      if (id && picking.current?.id === id && !(await picking.current.done)) return false;
      if (commandId || pending.current?.text !== text)
        pending.current = { id: commandId ?? identifier(), text };
      commandId = pending.current.id;
      setError('');
      id ??= await open();
      if (!id) return false;
      // Sent on the model the bar shows, or not at all.
      const shown =
        canonical.current?.conversation.id === id && canonical.current.conversation.model;
      await call('pi.send', { id, commandId, text, ...(shown && { model: shown }) });
      if (!valid() || selection.current !== id) return true;
      setDraft((value) => (value.trim() === text ? '' : value));
      pending.current = null;
      following.current = true;
      const next = await call<PiSnapshot>('pi.snapshot', { id }).catch(() => null);
      if (next) replace(next);
      return true;
    } catch (cause) {
      if (!valid() || selection.current !== id) return false;
      if (cause instanceof ApiError && cause.code === 'sandbox_not_connected') setRefused(true);
      else setError(said(cause, 'Could not send the message.'));
      // Another page picked a model: the bar shows it before the question is sent again.
      if (cause instanceof ApiError && cause.code === 'pi_model_changed')
        void call<PiSnapshot>('pi.snapshot', { id }).then(replace, () => {});
      return false;
    } finally {
      if (valid()) {
        setBusy(false);
        composer.current?.focus();
      }
    }
  };
  /** Tells the agent how a call the person ran came out, as their message, once: that message's
   * turn is named for the call, so telling it again starts nothing. Words that could not be sent
   * wait in the composer, ahead of anything typed there, for the person to send. */
  const tell = async (proposalId: string, told: string) => {
    if (telling.current.has(proposalId)) return;
    telling.current.add(proposalId);
    const id = selection.current;
    if (await send(told, `told_${proposalId}`)) return;
    if (valid() && selection.current === id)
      setDraft((value) => (value.trim() ? `${told}\n\n${value}` : told));
    else telling.current.delete(proposalId);
  };
  // An outcome the agent was never told, because Run's answer was lost or the call came out
  // after the page stopped waiting, is told as soon as the conversation shows it; one this page
  // left in the composer is the person's to send.
  useEffect(() => {
    if (!snapshot || active || busy || running || blocked) return;
    const untold = proposing?.proposals?.find(({ id, ran }) => {
      const told = ran?.told?.trim();
      return (
        told &&
        !telling.current.has(id) &&
        !snapshot.commands.some(
          (turn) => turn.id === `told_${id}` || turn.messages[0]?.text.includes(told),
        )
      );
    });
    if (untold) void tell(untold.id, untold.ran!.told!);
  }, [snapshot, active, busy, running, blocked]);
  /** Runs a proposed call as the person, then tells the agent what happened (tell). A run Pi
   * itself refuses ran nothing, and tells the agent nothing; one whose answer was lost may have
   * run, and what Pi kept of it says, now or once it comes out. */
  const run = async (commandId: string, proposal: PiProposal) => {
    if (!selected || running || busy || active) return;
    setRunning(proposal.id);
    setError('');
    let told: string | undefined;
    try {
      // The server writes what the agent is told, a refusal too; a result it is not told whole
      // is shown here.
      const ran = await call<PiRan>('pi.run', {
        id: selected,
        commandId,
        proposalId: proposal.id,
      });
      if (!ran.whole)
        setLocalResults((value) => ({
          ...value,
          [proposal.id]: JSON.stringify(ran.result, null, 2) ?? 'null',
        }));
      told = ran.told;
    } catch (cause) {
      const kept =
        cause instanceof ApiError && cause.status >= 400 && cause.status < 500
          ? null
          : await call<PiSnapshot>('pi.snapshot', { id: selected }).catch(() => null);
      if (kept) replace(kept);
      told = kept?.commands
        .find(({ id }) => id === commandId)
        ?.proposals?.find(({ id }) => id === proposal.id)?.ran?.told;
      if (told === undefined) {
        if (valid()) setError(said(cause, 'Could not run it.'));
        return;
      }
    } finally {
      if (valid()) setRunning(null);
    }
    if (!valid() || selection.current !== selected) return;
    // What this run returned is told now, whatever the page told of the call before.
    telling.current.delete(proposal.id);
    await tell(proposal.id, told);
  };
  /** The picker answers with the machine as it now stands, the same in every conversation here. */
  const machine = async (
    tool: 'pi.machine.set' | 'pi.machine.stop',
    input: Record<string, string>,
  ) => {
    setError('');
    try {
      const next = await call<PiHostView>(tool, input);
      if (!valid() || !canonical.current) return;
      canonical.current = { ...canonical.current, host: next };
      setSnapshot((value) => value && { ...value, host: next });
    } catch (cause) {
      if (valid()) setError(said(cause, 'Could not change the machine.'));
    }
  };
  /** Picks run one after another, each answered with the conversation as it now stands. */
  const pickModel = (model: string) => {
    const id = selection.current;
    if (!id) return;
    setError('');
    const done: Promise<boolean> = (
      picking.current?.id === id ? picking.current.done : Promise.resolve(true)
    )
      .then(() => call<PiSnapshot>('pi.model.set', { id, model }))
      .then(
        (next) => (replace(next), true),
        (cause) => {
          if (valid() && selection.current === id)
            setError(said(cause, 'Could not change the model.'));
          return false;
        },
      )
      .finally(() => {
        if (picking.current?.done === done) picking.current = null;
      });
    picking.current = { id, done };
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

  return {
    conversations,
    selected,
    snapshot,
    draft,
    setDraft,
    listed,
    busy,
    running,
    localResults,
    error,
    streamError,
    unavailable,
    pending,
    warming,
    composer,
    transcript,
    following,
    skew,
    proposing,
    active,
    blocked,
    visible,
    host,
    standing,
    title,
    follow,
    warmUp,
    create,
    send,
    run,
    machine,
    pickModel,
    stop,
    /** Another conversation, with nothing of this one's carried into it. */
    switchTo: (id: string) => {
      pending.current = null;
      setDraft('');
      setError('');
      choose(id);
    },
    retryList: () => setReload((value) => value + 1),
    retryStream: () => setSnapshotRetry((value) => value + 1),
  };
}
export type Conversation = ReturnType<typeof useConversation>;
