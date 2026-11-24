import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useScopeVersion } from '../api';
import type { PiInterruption } from '@merv/pi/models';
import { Seconds } from './pi-cards';
import { useConversation, type Conversation } from './pi-conversation';
import { useVoice, type Voice } from './pi-voice';
import { useScreenAnswer } from './pi-screen';
import { toolTransport } from './pi-transport';
import { speech } from '../speech';
import { AssistantSaid } from '../panel/chat-entry';
import { StateMark } from '../panel/marks';
import { oneThread } from '../panel/one-thread';
import { ThreadRows } from '../panel/one-thread-view';
import { localLines, mervTurns } from '../board-app/thread-data';

/** Under a turn that ended early, and any words it had written: why, with the step after it.
 * Stopping it yourself needs only the word. */
const STOPPED: Record<PiInterruption, string> = {
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
interface Agent {
  /** The open conversation; null until it is first drawn, and once it has ended. */
  pi: Conversation | null;
  /** From the first opening of the Agent page until the conversation ends. */
  live: boolean;
  /** The dock was closed by hand: it stays shut until the Agent page opens again. */
  hidden: boolean;
  /** A page asked for the dock: it stands, on a phone too and before any question, until closed. */
  asked: boolean;
  /** The Agent page opened: the conversation begins, or goes on as it was left. */
  start(): void;
  /** The person asked for Pi where they are: the conversation begins, in the dock. */
  ask(): void;
  /** A page speaks to Pi for the person: the conversation begins, with no dock opened for it. */
  wake(): void;
  /** The person's machine was released: the conversation ends, and its stream with it. */
  end(): void;
  hide(): void;
  /** The conversation's voice session, which outlives any one page. */
  voice: Voice;
  /** What the agent last put on the screen, and when. */
  shown: { title: string; at: number } | null;
}
export const AgentContext = createContext<Agent | null>(null);
export const useAgent = () => useContext(AgentContext);

/**
 * Holds the Agent's conversation above the routes, so it outlives its page. Nothing is read,
 * warmed or streamed until the Agent page first opens or a page asks for it; from then on it stays connected while the
 * person goes elsewhere, until it ends (views/pi-dock.tsx). The page opened after that begins it
 * again exactly as the first opening did, and so does a change of scope.
 */
export function PiProvider({ children }: { children: ReactNode }) {
  const scope = useScopeVersion();
  const [open, setOpen] = useState({ live: false, opened: 0, hidden: false, asked: false });
  const [pi, setPi] = useState<Conversation | null>(null);
  const controls = useMemo(
    () => ({
      start: () =>
        setOpen((now) =>
          !now.live
            ? { ...now, live: true, opened: now.opened + 1, hidden: false }
            : now.hidden
              ? { ...now, hidden: false }
              : now,
        ),
      wake: () =>
        setOpen((now) =>
          now.live ? now : { ...now, live: true, opened: now.opened + 1, hidden: true },
        ),
      ask: () =>
        setOpen((now) => ({
          live: true,
          opened: now.opened + (now.live ? 0 : 1),
          hidden: false,
          asked: true,
        })),
      end: () => setOpen((now) => (now.live ? { ...now, live: false, asked: false } : now)),
      hide: () => setOpen((now) => ({ ...now, hidden: true, asked: false })),
    }),
    [],
  );
  // Signing in to a project starts the person's agent machine there, before Pi is opened; unused,
  // it stops after the idle timeout like any warmed machine.
  useEffect(() => {
    void toolTransport.warm?.(
      null,
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
  }, []);
  const voice = useVoice(open.live ? pi : null);
  // What the agent asks of the screen is answered by whatever page the person is on.
  const shown = useScreenAnswer(open.live ? pi : null);
  // A conversation that ends takes its voice with it.
  useEffect(() => {
    if (!open.live) voice.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.live]);
  const agent = useMemo(
    () => ({ ...open, ...controls, pi: open.live ? pi : null, voice, shown }),
    [open, controls, pi, voice, shown],
  );
  return (
    <AgentContext.Provider value={agent}>
      {children}
      {open.live && <Live key={`${scope}:${open.opened}`} publish={setPi} />}
    </AgentContext.Provider>
  );
}

/** The conversation itself. It draws nothing: the page and the dock draw what it publishes. */
const Live = memo(function Live({ publish }: { publish(pi: Conversation | null): void }) {
  const pi = useConversation();
  useLayoutEffect(() => publish(pi));
  useLayoutEffect(() => () => publish(null), [publish]);
  return null;
});

/**
 * How the turn stands: its dot, its words, and the seconds a wait has lasted. In a header
 * (`dot`) only the dot is drawn — green once the agent is ready, amber and breathing while
 * it gets there, grey when it cannot — and the words are its hover title and what a screen
 * reader hears.
 */
export function Standing({ pi, dot }: { pi: Conversation; dot?: boolean }) {
  const [words, tone, since] = pi.standing;
  if (dot)
    return (
      <span className={`pi-state-dot${tone && ` pi-state-dot--${tone}`}`} title={words}>
        <span className="sr-only">
          {words}
          {since && <Seconds since={since} skew={pi.skew.current} />}
        </span>
      </span>
    );
  return (
    <>
      <span className={`pi-state-dot${tone && ` pi-state-dot--${tone}`}`} />
      <span>
        {words}
        {since && <Seconds since={since} skew={pi.skew.current} />}
      </span>
    </>
  );
}

/**
 * The conversation's turns, drawn with merv-desktop's chat parts (the same rows as Merv's panel):
 * what was said, and the Agent's tool calls as one quiet step trail per turn.
 */
export function Transcript({ pi }: { pi: Conversation }) {
  const { snapshot, active, visible } = pi;
  const voiceOff = (useAgent()?.voice.state ?? 'off') === 'off';
  const { unavailable, selected, blocked, following, follow } = pi;
  const thread = useMemo(() => oneThread([], [], localLines(snapshot)), [snapshot]);
  const turns = useMemo(() => mervTurns(snapshot), [snapshot]);
  const ended =
    snapshot?.commands.at(-1)?.status === 'interrupted' ? snapshot.commands.at(-1) : undefined;
  // Drawn afresh it opens at its latest words.
  useLayoutEffect(() => {
    following.current = true;
  }, [following]);
  useLayoutEffect(follow);
  // Messages also grow after they are drawn (fonts, highlighted code, diagrams), and the panel
  // can change height: a reader at the latest words stays there as they settle.
  useEffect(() => {
    const list = pi.transcript.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const sizes = new ResizeObserver(() => follow());
    sizes.observe(list);
    const watch = () => {
      for (const child of list.children) sizes.observe(child);
    };
    watch();
    const added = new MutationObserver(watch);
    added.observe(list, { childList: true });
    return () => {
      sizes.disconnect();
      added.disconnect();
    };
  }, [pi.transcript, follow]);
  return (
    <div className="web-panel is-inline">
      <section className="thread is-main is-one" aria-label="Conversation">
        <div
          className="lines"
          ref={pi.transcript}
          aria-label="Conversation messages"
          aria-live="polite"
          onScroll={(event) => {
            const list = event.currentTarget;
            // The transcript's own scroll lands where it put it, though the words grew since.
            if (pi.pinnedAt.current !== null && Math.abs(list.scrollTop - pi.pinnedAt.current) < 2)
              return;
            pi.pinnedAt.current = null;
            following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          }}
        >
          <ThreadRows
            thread={thread}
            turns={turns}
            active={active ? (snapshot?.conversation.activeCommandId ?? undefined) : undefined}
          />
          {ended && (
            <p className="pi-ended">
              {(ended.error && STOPPED[ended.error]) ?? 'The agent stopped. Ask again.'}
            </p>
          )}
          {visible?.text && <AssistantSaid id="live" text={visible.text} />}
          {visible?.progress && <p className="muted">{visible.progress}</p>}
          {/* With the voice on, the voice's own caption says it. */}
          {active && snapshot?.stage.saying && voiceOff && (
            <p className="muted">{snapshot.stage.saying}</p>
          )}
          {active && !unavailable && !visible?.text && <StateMark state="running" />}
          {selected && !snapshot ? (
            <p className="muted">Loading conversation…</p>
          ) : (
            blocked && (
              <p className="muted" role="status">
                {UNAVAILABLE}
              </p>
            )
          )}
        </div>
      </section>
    </div>
  );
}

/** Where the next question is written: Enter sends it, and Stop ends an answer under way. */
export function Composer({
  pi,
  rows,
  voice,
  placeholder,
}: {
  pi: Conversation;
  rows: number;
  voice?: Voice;
  /** What the empty box says, where the page asks for a first question. */
  placeholder?: string;
}) {
  const { draft, setDraft, busy, blocked, unavailable, active, send, stop, warmUp } = pi;
  return (
    <form
      className="pi-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="pi-draft" className="sr-only">
        Message {speech.agent}
      </label>
      <textarea
        id="pi-draft"
        ref={pi.composer}
        className="textarea"
        rows={rows}
        {...(placeholder ? { placeholder } : {})}
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
          if (key !== 'Enter' || shiftKey || altKey || nativeEvent.isComposing || keyCode === 229)
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
      {/* Beside the box: voice mode over Send, which is Stop while an answer runs. A page that
          gives no voice has no Audio. */}
      <div className="pi-compose-actions">
        {voice && (
          <button
            className="btn"
            type="button"
            disabled={blocked || unavailable || !pi.snapshot}
            title="Talk with your agent"
            onClick={voice.start}
          >
            Audio
          </button>
        )}
        {/* While an answer runs, Stop stands where Send was, until there is something to say to it. */}
        {active && !draft.trim() ? (
          <button
            className="btn"
            type="button"
            disabled={busy || unavailable}
            onClick={() => void stop()}
          >
            Stop
          </button>
        ) : (
          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || blocked || unavailable || !draft.trim()}
          >
            {busy ? 'Sending…' : pi.pending.current?.text === draft.trim() ? 'Retry send' : 'Send'}
          </button>
        )}
      </div>
    </form>
  );
}

/** The customer page's composer: what is typed to the Agent, with its voice where it has one. */
export function Speak({
  pi,
  rows = 3,
  voice: supplied,
  placeholder,
}: {
  pi: Conversation;
  rows?: number;
  voice?: Voice;
  placeholder?: string;
}) {
  const agent = useAgent();
  const voice = supplied ?? agent?.voice;
  return (
    <>
      {voice?.problem && (
        <p className="pi-error" role="alert">
          {voice.problem}
        </p>
      )}
      <Composer pi={pi} rows={rows} voice={voice} {...(placeholder ? { placeholder } : {})} />
    </>
  );
}
