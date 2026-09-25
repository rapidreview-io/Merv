import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  ApiError,
  call,
  currentToken,
  identityVersion,
  projectSelection,
  scopeVersion,
  useScopeVersion,
} from '../api';
import { Ago, relativeTime, useNow } from '../components';
import { ChevronsIcon } from '../icons';
import { MarkdownPieces, useRecordNames } from '../markdown';
import {
  PiStreamError,
  readPiEvents,
  type PiConversation,
  type PiDelta,
  type PiCommand,
  type PiEvent,
  type PiHostView,
  type PiMachine,
  type PiModel,
  type PiProposal,
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
/** Under a turn that ended early, and any words it had written: why, with the step after it.
 * Stopping it yourself needs only the word. */
const STOPPED: Record<string, string> = {
  cancelled: 'Stopped',
  worker_interrupted: 'The agent stopped unexpectedly. Ask again.',
  runtime_lost: 'The agent’s machine went away. Ask again.',
  runtime_refused: 'No machine could be started for the agent. Ask again later.',
  wallet_refused: "Fleet's spending limit is reached.",
  runtime_stopped: 'The agent’s machine was stopped. Ask again.',
  turn_expired: 'The answer took too long. Ask again.',
  service_unavailable: 'The agent service is unavailable. Ask again later.',
  ambiguous_prompt: 'The question may not have reached the agent. Ask again.',
  checkpoint_unavailable: 'The answer could not be saved. Ask again.',
};
const UNAVAILABLE = 'Agent isn’t available right now.';
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
/** ½ vCPU · 4 GiB, with the disk where a machine is chosen. */
const specs = ({ vcpu, memoryGiB, diskGB }: PiMachine, disk = false) =>
  `${vcpu % 1 === 0.5 ? `${Math.floor(vcpu) || ''}½` : vcpu} vCPU · ${memoryGiB} GiB${disk ? ` · ${diskGB} GB` : ''}`;
const label = (host: PiHostView | undefined, key: string) =>
  host?.catalog.find((machine) => machine.key === key)?.label ?? key;
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
/** Operated as the account menu is: the cursor goes to its first item, the arrows, Home and End
 * move it, Escape hands it back to the button, and Tab or a click elsewhere shuts it. A menu that
 * turns into its guard is a new `open`, so the cursor starts again at its first item. */
function useMenu(box: RefObject<HTMLElement>, open: unknown, shut: () => void) {
  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
    ];
    items()[0]?.focus();
    const click = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) shut();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        shut();
        box.current?.querySelector('button')?.focus();
      } else if (event.key === 'Tab') shut();
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
  }, [open]);
}

/** How long after its words arrive an answer shows them all. */
const REVEAL_MS = 250;
/**
 * The answer as it streams, drawn at the pace its words arrive rather than in bursts: whatever
 * arrived is spread over the next REVEAL_MS, so a steady stream reads at its own rate and nothing
 * shows later than that. A reader who asks for less motion gets each burst at once, and the saved
 * answer replaces this one, whole, the moment the turn ends.
 */
function LiveAnswer({ text, follow }: { text: string; follow(): void }) {
  const names = useRecordNames(text);
  const [shown, setShown] = useState(0);
  // Reveals run linearly from `from` at `start` to the whole of `text` REVEAL_MS later.
  const reveal = useRef({ text: '', from: 0, start: 0 });
  useEffect(() => {
    const now = performance.now();
    const at = (time: number) => {
      const { text, from, start } = reveal.current;
      return Math.min(text.length, from + ((text.length - from) * (time - start)) / REVEAL_MS);
    };
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const grew = text.startsWith(reveal.current.text);
    reveal.current = { text, from: grew && !still ? at(now) : text.length, start: now };
    let frame = 0;
    const step = () => {
      const next = at(performance.now());
      // Never half a character.
      setShown(Math.floor(next) - (/[\uD800-\uDBFF]/.test(text[Math.floor(next) - 1]) ? 1 : 0));
      if (next < text.length) frame = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(frame);
  }, [text]);
  useLayoutEffect(follow);
  return <MarkdownPieces source={text.slice(0, shown)} names={names} />;
}

/** A result as text, its links live. */
const linked = (text: string) =>
  text.split(/(https?:\/\/[^\s"]+)/).map((part, index) =>
    index % 2 ? (
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
/** A call the agent proposed: the tool, Main's copy of its exact input, and Run, which runs it
 * once as the person and is heard with the tool's name and, as its description, that input. A
 * secret result shows here and nowhere else. */
function Proposal({
  proposal,
  secret,
  disabled,
  run,
}: {
  proposal: PiProposal;
  secret?: string;
  disabled: boolean;
  run(): void;
}) {
  const id = useId();
  return (
    <article className="pi-proposal">
      <code id={`${id}tool`}>{proposal.name}</code>
      <pre id={`${id}input`}>{JSON.stringify(proposal.input, null, 2)}</pre>
      {secret && <pre>{linked(secret)}</pre>}
      <button
        className="btn btn--sm"
        type="button"
        id={`${id}run`}
        aria-labelledby={`${id}run ${id}tool`}
        aria-describedby={`${id}input`}
        disabled={disabled || !!proposal.ran}
        onClick={run}
      >
        {!proposal.ran ? 'Run as me' : proposal.ran.ok === false ? 'Refused' : 'Ran'}
      </button>
    </article>
  );
}

/** The person's machine in this project, which all their conversations here share: what it is, a
 * move under way or one that failed, and the picker. Releasing it asks first. */
function Machine({
  host,
  skew,
  choose,
  stop,
}: {
  host: PiHostView;
  skew: number;
  choose(key: string): void;
  stop(): void;
}) {
  const [menu, setMenu] = useState<false | 'pick' | 'stop'>(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(box, menu, () => setMenu(false));
  // A deadline's rollover onto the same machine is no news to the person.
  const moving = host.moving?.by === 'deadline' ? null : host.moving;
  const move = host.lastMove?.by === 'deadline' ? null : host.lastMove;
  // A move that failed, while a machine still serves, is news for as long as its idle wait.
  const failed =
    !!host.machine &&
    move?.outcome === 'failed' &&
    Date.now() + skew - Date.parse(move.at) < host.idleSeconds * 1000;
  useNow(failed ? 1000 : 0);
  const on = host.machine ?? host.catalog.find((machine) => machine.key === host.preferred);
  if (!on) return null;
  const chosen = moving?.to ?? on.key;
  const close = (then = () => {}) => {
    setMenu(false);
    box.current?.querySelector('button')?.focus();
    then();
  };
  const actions: [string, () => void, string?][] =
    menu === 'stop'
      ? [
          ['Release machine', () => close(stop), ' pi-menu-item--danger'],
          ['Cancel', () => setMenu('pick')],
        ]
      : host.state === 'none' && !host.moving
        ? []
        : [['Release machine', () => setMenu('stop')]];
  return (
    <div className="pi-switch pi-machine" ref={box}>
      <button
        type="button"
        className="pi-switch-button pi-machine-button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => setMenu((value) => (value ? false : 'pick'))}
      >
        <span aria-live="polite">
          {moving ? (
            <>
              Moving to a {label(host, moving.to)} machine
              <Seconds since={moving.since} skew={skew} />
            </>
          ) : failed ? (
            `Couldn’t start ${label(host, move.to)}${move.reason ? `: ${move.reason}` : ''}. Still on ${on.label}.`
          ) : (
            <>
              {on.label}
              <span className="pi-machine-specs"> · {specs(on)}</span>
            </>
          )}
        </span>
        <ChevronsIcon />
      </button>
      {menu && (
        <div
          className="pi-menu"
          role="menu"
          aria-label="Machine"
          aria-describedby={menu === 'stop' ? 'pi-machine-stop' : undefined}
        >
          {menu === 'stop' && (
            <p className="pi-menu-note" id="pi-machine-stop" role="none">
              Answers still running here stop too.
            </p>
          )}
          {menu === 'pick' &&
            host.catalog.map((machine) => (
              <button
                key={machine.key}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                className="pi-menu-item"
                aria-checked={machine.key === chosen}
                aria-disabled={!machine.available || undefined}
                onClick={() => {
                  if (!machine.available) return;
                  close();
                  // The machine it runs on, picked during a move, calls the move off.
                  if (machine.key !== chosen) choose(machine.key);
                }}
              >
                <span>{machine.label}</span>
                <small>{machine.available ? specs(machine, true) : machine.reason}</small>
              </button>
            ))}
          {actions.map(([words, act, tone = '']) => (
            <button
              key={words}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`pi-menu-item${tone}`}
              onClick={act}
            >
              {words}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model this conversation's next answer uses, and its picker: labels alone. Only the person
 * changes it; an answer under way keeps its own. */
function Model({
  models,
  model,
  busy,
  pick,
}: {
  models: PiModel[];
  model?: string;
  busy: boolean;
  pick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(box, open, () => setOpen(false));
  return (
    <div className="pi-switch pi-model" ref={box}>
      <button
        type="button"
        className="pi-switch-button pi-model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-live="polite">
          <span className="sr-only">Model: </span>
          {models.find(({ id }) => id === model)?.label ?? model}
        </span>
        <ChevronsIcon />
      </button>
      {open && (
        <div className="pi-menu" role="menu" aria-label="Model">
          {models.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              className="pi-menu-item"
              aria-checked={id === model}
              onClick={() => {
                setOpen(false);
                box.current?.querySelector('button')?.focus();
                if (id !== model) pick(id);
              }}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where turn `at` moved machine or switched model, against the last earlier turn that recorded
 * each: a turn stopped before a worker claimed it recorded no model. */
function changed(all: PiCommand[], at: number, host?: PiHostView, models?: PiModel[]) {
  const since = (key: 'machine' | 'model') => {
    const before = all
      .slice(0, at)
      .reverse()
      .find((turn) => turn[key])?.[key];
    return before && all[at][key] !== before ? all[at][key] : undefined;
  };
  const [machine, model] = [since('machine'), since('model')];
  const words = [
    machine && `Moved to ${label(host, machine)}`,
    model && `Switched to ${models?.find(({ id }) => id === model)?.label ?? model}`,
  ].filter(Boolean);
  return (
    words.length > 0 && (
      <p className="pi-divider" key={`${all[at].id}-changed`}>
        {words.join(' · ')}
      </p>
    )
  );
}

function PiConversationPage() {
  const [conversations, setConversations] = useState<PiConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PiSnapshot | null>(null);
  const [response, setResponse] = useState<TransientResponse | null>(null);
  const [draft, setDraft] = useState('');
  // The conversations as the menu opened: an answer streaming meanwhile moves none of them.
  const [menu, setMenu] = useState<PiConversation[] | null>(null);
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The proposal running now, and the secret results this page alone holds.
  const [running, setRunning] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const pending = useRef<{ id: string; text: string } | null>(null);
  // The latest model pick on its way, which a send in that conversation waits for.
  const picking = useRef<{ id: string; done: Promise<boolean> } | null>(null);
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
  const warming = useRef(false);
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
  /** Starts the person's machine here when there is none, as the page opens or a question is
   * begun; merely looking at a conversation, after the machine stopped, starts nothing. */
  const warmUp = () => {
    const id = selection.current;
    const current = canonical.current;
    if (!id || warming.current || current?.conversation.id !== id || !current.available) return;
    if (current.host?.state !== 'none') return;
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
  const [words, tone, since]: [string, string, string?] = unavailable
    ? ['Unavailable', '']
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
  const follow = useRef(() => {
    const list = transcript.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }).current;
  useLayoutEffect(follow);
  const named = snapshot?.conversation ?? conversations.find((item) => item.id === selected);
  const asked = snapshot?.commands[0]?.messages[0]?.text.replace(/\s+/g, ' ').trim();
  const title = named && named.title !== UNNAMED ? named.title : asked ? clip(asked) : UNNAMED;
  useMenu(switcher, menu, () => setMenu(null));

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
  /** Whether the words reached the server. */
  const send = async (text = draft.trim()): Promise<boolean> => {
    if (busy || blocked || unavailable || active || !text) return false;
    let id = selection.current;
    setBusy(true);
    try {
      // A pick on its way goes first; one that failed keeps the question, and says why.
      if (id && picking.current?.id === id && !(await picking.current.done)) return false;
      if (pending.current?.text !== text) pending.current = { id: identifier(), text };
      const commandId = pending.current.id;
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
  /** Runs a proposed call as the person, then tells the agent what happened, as their message;
   * words that could not be sent wait in the composer, ahead of anything typed there. */
  const run = async (commandId: string, proposal: PiProposal) => {
    if (!selected || running || busy || active) return;
    setRunning(proposal.id);
    setError('');
    let told: string;
    try {
      const { result } = await call<{ result: unknown }>('pi.run', {
        id: selected,
        commandId,
        proposalId: proposal.id,
      });
      const json = JSON.stringify(result, null, 2) ?? 'null';
      if (proposal.secret) setSecrets((value) => ({ ...value, [proposal.id]: json }));
      const clipped = (JSON.stringify(result) ?? 'null').slice(0, 4000);
      told = proposal.secret
        ? `Ran ${proposal.name}; its result is shown only to me.`
        : `Ran ${proposal.name}: ${clipped}`;
    } catch (cause) {
      told = `${proposal.name} was refused: ${said(cause, 'it failed')}`;
    } finally {
      if (valid()) setRunning(null);
    }
    const here = () => valid() && selection.current === selected;
    if (here() && !(await send(told)) && here())
      setDraft((value) => (value.trim() ? `${told}\n\n${value}` : told));
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
              aria-expanded={!!menu}
              title={title}
              disabled={busy}
              onClick={() =>
                setMenu((value) =>
                  value
                    ? null
                    : [...conversations].sort((left, right) =>
                        right.updatedAt.localeCompare(left.updatedAt),
                      ),
                )
              }
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
                    setMenu(null);
                    create();
                  }}
                >
                  New conversation
                </button>
                {menu.map((item) => {
                  const name = item.id === selected ? title : item.title;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="pi-menu-item"
                      aria-label={`${name}, ${relativeTime(item.updatedAt)}`}
                      aria-current={item.id === selected || undefined}
                      onClick={() => {
                        setMenu(null);
                        switcher.current?.querySelector('button')?.focus();
                        if (item.id === selected) return;
                        pending.current = null;
                        setDraft('');
                        setError('');
                        choose(item.id);
                      }}
                    >
                      <span>{name}</span>
                      <Ago at={item.updatedAt} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {!blocked && !unavailable && snapshot && (snapshot.models?.length ?? 0) > 1 && (
            <Model
              models={snapshot.models!}
              model={snapshot.conversation.model}
              busy={busy}
              pick={pickModel}
            />
          )}
          {!blocked && snapshot && (
            <div className="pi-state" role="status">
              {state}
            </div>
          )}
          {!blocked && !unavailable && host && (
            <Machine
              host={host}
              skew={skew.current}
              choose={(key) => void machine('pi.machine.set', { machine: key })}
              stop={() => void machine('pi.machine.stop', {})}
            />
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
          {snapshot?.commands.flatMap((item, at, all) => [
            changed(all, at, host, snapshot.models),
            ...item.messages.map((message, index) => (
              <article
                className={`pi-message pi-message--${message.role}`}
                key={`${item.id}-${index}`}
              >
                <span className="pi-speaker">{message.role === 'user' ? 'You' : 'Agent'}</span>
                {message.role === 'user' ? (
                  <div className="pi-message-text">{message.text}</div>
                ) : (
                  <MarkdownPieces source={message.text} />
                )}
              </article>
            )),
            item.status === 'interrupted' && (
              <p className="pi-ended" key={`${item.id}-ended`}>
                {STOPPED[item.error ?? ''] ?? 'The agent stopped. Ask again.'}
              </p>
            ),
            // The latest calls the agent proposed stay under their turn until it proposes again,
            // and a secret this page holds stays in its card while the page is open.
            ...(item.proposals ?? [])
              .filter((proposal) => item === proposing || proposal.id in secrets)
              .map((proposal) => (
                <Proposal
                  key={proposal.id}
                  proposal={proposal}
                  secret={secrets[proposal.id]}
                  disabled={active || busy || !!running}
                  run={() => void run(item.id, proposal)}
                />
              )),
          ])}
          {visible && (visible.text || visible.progress) && (
            <article className="pi-message pi-message--assistant pi-message--transient">
              <span className="pi-speaker">Agent · live</span>
              {visible.text && <LiveAnswer text={visible.text} follow={follow} />}
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
              {UNAVAILABLE}
            </p>
          ) : (
            !snapshot?.commands.length && <p className="muted">Ask a question to begin.</p>
          )}
        </div>
      )}
      {error && (
        <p className="pi-error" role="alert">
          {error}
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
            enterKeyHint="send"
            onKeyDown={(event) => {
              // Enter sends; ⌘/Ctrl+Enter starts a new line, as do Shift+ and Option+Enter natively.
              // Enter that picks an input-method candidate (229 in Safari) is the method's own.
              const { key, keyCode, metaKey, ctrlKey, shiftKey, altKey, nativeEvent } = event;
              if (
                key !== 'Enter' ||
                shiftKey ||
                altKey ||
                nativeEvent.isComposing ||
                keyCode === 229
              )
                return;
              event.preventDefault();
              const area = event.currentTarget;
              if (!(metaKey || ctrlKey)) void send();
              // Typed as input, so it can be undone and React sees the box change; where the
              // deprecated command is gone, put in by hand and announced as input.
              else if (!area.readOnly && !document.execCommand?.('insertText', false, '\n')) {
                area.setRangeText('\n', area.selectionStart, area.selectionEnd, 'end');
                area.dispatchEvent(new Event('input', { bubbles: true }));
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
