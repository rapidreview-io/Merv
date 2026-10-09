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
import { currentToken, projectSelection, useScopeVersion } from '../api';
import { Ago, relativeTime } from '../components';
import { ChevronsIcon } from '../icons';
import { MarkdownPieces, useRecordNames } from '../markdown';
import type { PiConversation, PiInterruption, PiProposal } from '@merv/pi/models';
import type { ViewProps } from './index';
import { receiptOf } from './pi-proposal';
import { changed, Context, Machine, Model, Outcome, Proposal, Seconds, useMenu } from './pi-cards';
import { useConversation, type Conversation } from './pi-conversation';
import { useVoice, VoicePanel, type Voice } from './pi-voice';
import { useScreenAnswer } from './pi-screen';

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

interface Agent {
  /** The open conversation; null until it is first drawn, and once it has ended. */
  pi: Conversation | null;
  /** From the first opening of the Agent page until the conversation ends. */
  live: boolean;
  /** The dock was closed by hand: it stays shut until the Agent page opens again. */
  hidden: boolean;
  /** The Agent page opened: the conversation begins, or goes on as it was left. */
  start(): void;
  /** The person's machine was released: the conversation ends, and its stream with it. */
  end(): void;
  hide(): void;
  /** The conversation's voice session, which outlives any one page. */
  voice: Voice;
}
const AgentContext = createContext<Agent | null>(null);
export const useAgent = () => useContext(AgentContext);

/**
 * Holds the Agent's conversation above the routes, so it outlives its page. Nothing is read,
 * warmed or streamed until the Agent page first opens; from then on it stays connected while the
 * person goes elsewhere, until it ends (views/pi-dock.tsx). The page opened after that begins it
 * again exactly as the first opening did, and so does a change of scope.
 */
export function PiProvider({ children }: { children: ReactNode }) {
  const scope = useScopeVersion();
  const [open, setOpen] = useState({ live: false, opened: 0, hidden: false });
  const [pi, setPi] = useState<Conversation | null>(null);
  const controls = useMemo(
    () => ({
      start: () =>
        setOpen((now) =>
          !now.live
            ? { live: true, opened: now.opened + 1, hidden: false }
            : now.hidden
              ? { ...now, hidden: false }
              : now,
        ),
      end: () => setOpen((now) => (now.live ? { ...now, live: false } : now)),
      hide: () => setOpen((now) => (now.hidden ? now : { ...now, hidden: true })),
    }),
    [],
  );
  const voice = useVoice(open.live ? pi : null);
  // The agent's look at the screen is answered by whatever page the person is on.
  useScreenAnswer(open.live ? pi : null);
  // A conversation that ends takes its voice with it.
  useEffect(() => {
    if (!open.live) voice.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.live]);
  const agent = useMemo(
    () => ({ ...open, ...controls, pi: open.live ? pi : null, voice }),
    [open, controls, pi, voice],
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

/** The conversation's turns, drawn alike on the page and in the dock. */
export function Transcript({ pi }: { pi: Conversation }) {
  const { snapshot, host, proposing, localResults, active, busy, running, visible } = pi;
  const { unavailable, selected, blocked, run, following, follow } = pi;
  // Drawn afresh, on the page or in the dock, it opens at its latest words.
  useLayoutEffect(() => {
    following.current = true;
  }, [following]);
  useLayoutEffect(follow);
  // What Run told the agent, by turn; and whether a call's card is drawn: the latest calls the
  // agent proposed stay under their turn until it proposes again, and a full result held here
  // stays in its card while the conversation is open.
  const told = snapshot?.commands.map((_, at, all) => receiptOf(all, at)) ?? [];
  const carded = (proposal: PiProposal) =>
    !!proposing?.proposals?.some(({ id }) => id === proposal.id) || proposal.id in localResults;
  return (
    <div
      className="pi-messages"
      ref={pi.transcript}
      aria-label="Conversation messages"
      aria-live="polite"
      onScroll={(event) => {
        const list = event.currentTarget;
        following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
      }}
    >
      {snapshot?.commands.flatMap((item, at, all) => [
        changed(all, at, host, snapshot.models),
        ...item.messages.map((message, index) => {
          const receipt = index === 0 && told[at];
          return receipt ? (
            !carded(receipt) && <Outcome key={`${item.id}-${index}`} named proposal={receipt} />
          ) : (
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
          );
        }),
        item.status === 'interrupted' && (
          <p className="pi-ended" key={`${item.id}-ended`}>
            {(item.error && STOPPED[item.error]) ?? 'The agent stopped. Ask again.'}
          </p>
        ),
        ...(item.proposals ?? [])
          .filter(carded)
          .map((proposal) => (
            <Proposal
              key={proposal.id}
              proposal={proposal}
              result={localResults[proposal.id]}
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
          <Standing pi={pi} />
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
  );
}

/** Where the next question is written: Enter sends it, and Stop ends an answer under way. */
export function Composer({ pi, rows, voice }: { pi: Conversation; rows: number; voice?: Voice }) {
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
        Message Agent
      </label>
      <textarea
        id="pi-draft"
        ref={pi.composer}
        className="textarea"
        rows={rows}
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
      {/* Beside the box: audio mode (not yet built) over Send, which is Stop while an answer runs. */}
      <div className="pi-compose-actions">
        <button
          className="btn"
          type="button"
          disabled={!voice || blocked || unavailable || !pi.snapshot}
          title="Talk with your agent"
          onClick={voice?.start}
        >
          Audio
        </button>
        {/* While an answer runs, Stop stands where Send was: nothing can be sent until it ends. */}
        {active ? (
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

function PiConversationPage() {
  const { pi, start } = useAgent()!;
  // Opening the page begins the conversation, or finds it as it was left.
  useEffect(start, [start]);
  // The conversations as the menu opened: an answer streaming meanwhile moves none of them.
  const [menu, setMenu] = useState<PiConversation[] | null>(null);
  const [context, setContext] = useState(false);
  const switcher = useRef<HTMLDivElement>(null);
  useMenu(switcher, menu, () => setMenu(null));
  if (!pi)
    return (
      <div className="page-stage pi-page">
        <p role="status">Opening conversations…</p>
      </div>
    );
  const { listed, error, streamError, unavailable, busy, blocked, snapshot, host, title } = pi;
  const { conversations, selected } = pi;
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
                    pi.create();
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
                        if (item.id !== selected) pi.switchTo(item.id);
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
          {!blocked && !unavailable && snapshot && snapshot.models.length > 1 && (
            <Model
              models={snapshot.models}
              model={snapshot.conversation.model}
              busy={busy}
              pick={pi.pickModel}
            />
          )}
          {!blocked && snapshot && (
            <div className="pi-state" role="status">
              <Standing pi={pi} dot />
            </div>
          )}
          {snapshot && (
            <button
              type="button"
              className="pi-switch-button pi-context-button"
              aria-expanded={context}
              onClick={() => setContext((open) => !open)}
            >
              Context
            </button>
          )}
          {!blocked && !unavailable && host && (
            <Machine
              host={host}
              skew={pi.skew.current}
              choose={(key) => void pi.machine('pi.machine.set', { machine: key })}
              stop={() => void pi.machine('pi.machine.stop', {})}
            />
          )}
        </div>
      )}
      {listed && context && snapshot && (
        <Context id={snapshot.conversation.id} turns={snapshot.commands.length} />
      )}
      {listed && <Transcript pi={pi} />}
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
        <button className="btn" type="button" onClick={pi.retryStream}>
          Retry connection
        </button>
      )}
      {!listed && error && (
        <button className="btn" type="button" onClick={pi.retryList}>
          Retry opening Agent
        </button>
      )}
      {listed && <Speak pi={pi} />}
    </div>
  );
}

/** The page's composer, or, while voice is on, the voice panel in its place. */
export function Speak({ pi, rows = 3 }: { pi: Conversation; rows?: number }) {
  const { voice } = useAgent()!;
  return voice.state === 'off' ? (
    <>
      {voice.problem && (
        <p className="pi-error" role="alert">
          {voice.problem}
        </p>
      )}
      <Composer pi={pi} rows={rows} voice={voice} />
    </>
  ) : (
    <VoicePanel voice={voice} progress={pi.visible?.progress || pi.standing[0]} />
  );
}

export function PiView({ row }: ViewProps) {
  const scope = useScopeVersion();
  const agent = useAgent();
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
  // A page drawn where nothing holds the conversation above it holds its own.
  return agent ? (
    <PiConversationPage />
  ) : (
    <PiProvider key={`${scope}:${row.id}`}>
      <PiConversationPage />
    </PiProvider>
  );
}
