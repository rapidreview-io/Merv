/**
 * Merv's one thread, beside any page: the project's agents and the Agent's own conversation in one column, and the
 * one place to write to the Agent. It is drawn with merv-desktop's own chat components: its head, its rows
 * (`ThreadRows`, which turns the stream into entries, the Agent's tool calls as a quiet step trail), its "New
 * activity" word, its "Now" strip, where an agent's question is answered with its worded buttons, and its reply box.
 * Only where it reads from is Merv's own (thread-data).
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { AssistantSaid } from '../panel/chat-entry';
import { ChatHead } from '../panel/chat-head';
import { Attach, Grow } from '../panel/composer';
import { MERV_FILE_TYPES, MervFileChips, useMervFiles } from '../panel/merv-files';
import { StateMark } from '../panel/marks';
import { MervChoices, MervVoice } from '../panel/merv-choices';
import { oneThread } from '../panel/one-thread';
import { ThreadNow, ThreadRows, type ThreadOpen } from '../panel/one-thread-view';
import { Send } from '../panel/parts';
import { useFollow } from '../panel/use-follow';
import { ALTERNATIVE_MODEL, useAlternativeModeEnabled } from '../views/alternative-mode';
import { useAgent } from '../views/pi';
import { BACK, Icon, useEdgeSwipe, usePhoneWidth } from './phone-atoms';
import { keepFile } from './merv-files';
import { localLines, mervTurns, readReport, useAnswer, useThreadData } from './thread-data';

type Agent = NonNullable<ReturnType<typeof useAgent>>;
type Pi = NonNullable<Agent['pi']>;

/** Where the next words to Merv are written, as a main thread's reply box: Enter sends, and the button stops an answer
 *  under way. Inside it at the left, where a main thread keeps its paperclip, Merv's voice; under it, quietly, its model. */
export function Ask({ pi, voice, sent }: { pi: Pi; voice?: Agent['voice']; sent(): void }) {
  const { draft, busy, active } = pi;
  const files = useMervFiles(keepFile);
  const ready = (!!draft.trim() || files.files.length > 0) && files.settled;
  // Words alone go as they always have; with files, both clear once Merv has them, and stay if not.
  const send = () => {
    if (!ready || busy) return;
    if (!files.files.length) {
      void pi.send();
      sent();
      return;
    }
    const words = draft;
    void pi.send(files.text(words)).then((ok) => {
      if (!ok) return;
      files.clear();
      pi.setDraft((value) => (value === words ? '' : value));
    });
    sent();
  };
  const alternative = useAlternativeModeEnabled(),
    chosen = pi.snapshot?.conversation.model;
  // As the voice chip offers them: the alternative model only where it is switched on, or already chosen.
  const models = (pi.snapshot?.models ?? []).filter(
    (model) => model.id !== ALTERNATIVE_MODEL || alternative || chosen === ALTERNATIVE_MODEL,
  );
  return (
    <form
      className="composer has-choices"
      onFocus={pi.warmUp}
      onPaste={(event) => {
        const pasted = Array.from(event.clipboardData.files);
        if (pasted.length) {
          event.preventDefault();
          files.add(pasted);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {voice && (
        <MervVoice
          on={voice.state !== 'off'}
          hearing={['listening', 'speaking', 'working'].includes(voice.state)}
          toggle={() => (voice.state === 'off' ? voice.start() : voice.stop())}
          disabled={pi.blocked || pi.unavailable || !pi.snapshot}
        />
      )}
      <MervFileChips files={files.files} remove={files.remove} retry={files.retry} />
      <Grow
        value={draft}
        onChange={pi.setDraft}
        onEnter={send}
        placeholder="Message Merv"
        disabled={pi.blocked}
      />
      <Attach add={files.add} accept={MERV_FILE_TYPES} disabled={pi.blocked || pi.unavailable} />
      <MervChoices
        models={models.map((model) => ({ id: model.id, name: model.label || model.id }))}
        model={chosen}
        pick={(id) => void pi.pickModel(id)}
        disabled={busy}
      />
      <Send
        running={active && !draft.trim() && !files.files.length}
        onStop={() => void pi.stop()}
        ready={ready}
        disabled={busy || pi.unavailable}
        title="Send"
        stopTitle="Stop"
      />
    </form>
  );
}

/** The edge swipe lives with the phone's other atoms; Merv's thread and every session use it. */
export { EDGE, SWIPE, swipesBack } from './phone-atoms';

export function MervThread({
  back,
  onOpen,
  stage = false,
  children,
}: {
  /** Where the head's ‹ goes: the panel closes, or the page goes back. */
  back(): void;
  /** Drawn above the reply box: the hand-off cards waiting for the person's Approve. */
  children?: React.ReactNode;
  /** The chat has the window (Chat first): what is live shows whole. Beside the board, or on a phone, it waits behind "N running". */
  stage?: boolean;
  /** A session's name was pressed: it opens here in the panel, one step from the thread. */
  onOpen(target: ThreadOpen): void;
}) {
  const agent = useAgent(),
    pi = agent?.pi;
  const phone = usePhoneWidth();
  const data = useThreadData();
  const answer = useAnswer();
  const local = useMemo(() => localLines(pi?.snapshot), [pi?.snapshot]);
  const turns = useMemo(() => mervTurns(pi?.snapshot), [pi?.snapshot]);
  const thread = useMemo(
    () => oneThread(data.events, data.cards, local),
    [data.events, data.cards, local],
  );
  const lines = useRef<HTMLDivElement>(null),
    held = useRef<number>();
  const said = pi?.visible?.text;
  // Only what grows at the end moves the reader or says "New activity": an earlier page coming in above does neither.
  const follow = useFollow(
    lines,
    thread.rows.at(-1)?.key,
    thread.rows.length && thread.rows.at(-1),
    turns,
    said,
    pi?.active,
  );
  // Reading back, what is in view stays where it is as the earlier page comes in above it.
  const earlier = () => {
    held.current = lines.current?.scrollHeight;
    data.earlier();
  };
  useLayoutEffect(() => {
    const el = lines.current;
    if (!el || held.current === undefined || data.reading) return;
    el.scrollTop += el.scrollHeight - held.current;
    held.current = undefined;
  }, [data.events, data.reading]);
  const active = pi?.active ? (pi.snapshot?.conversation.activeCommandId ?? undefined) : undefined;
  const area = useRef<HTMLElement>(null);
  useEdgeSwipe(area, phone, back);
  return (
    <>
      {/* "‹  Merv" on the head's own line, as a main thread's "‹  merv-desktop · main thread  menu" is. On a phone it stays
        at the top too, just the word ("‹ Merv"), so the reply box is the last thing on the screen. */}
      <header className="head is-merv">
        <div className="head-start">
          <Icon label="All chats" path={BACK} onClick={back} />
          <ChatHead plain kind="" mark={null} title="Merv" />
        </div>
      </header>
      <section className="thread is-main is-one" aria-label="Merv's thread" ref={area}>
        <div className="lines-frame">
          <div className="lines" ref={lines} onScroll={follow.onScroll}>
            {data.older && (
              <button
                type="button"
                className="one-earlier"
                disabled={data.reading}
                onClick={earlier}
              >
                {data.reading ? 'Reading…' : 'Earlier'}
              </button>
            )}
            {data.ready && !thread.rows.length && !said && (
              <p className="one-empty">What your agents do is told here. Ask Merv anything.</p>
            )}
            <ThreadRows
              thread={thread}
              turns={turns}
              active={active}
              onOpen={onOpen}
              read={readReport}
            />
            {said && <AssistantSaid id="live" text={said} />}
            {pi?.active && !said && <StateMark state="running" />}
          </div>
          {follow.behind && (
            <button className="behind" onClick={follow.toEnd}>
              New activity
            </button>
          )}
        </div>
        <ThreadNow
          thread={thread}
          onOpen={onOpen}
          read={readReport}
          fold={phone || !stage}
          answer={(row, choice) => {
            follow.toEnd();
            return answer(row, choice);
          }}
        />
        {children}
        {pi && <Ask pi={pi} voice={agent?.voice} sent={follow.toEnd} />}
      </section>
    </>
  );
}
