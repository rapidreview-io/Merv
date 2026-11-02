/**
 * Pi, on the board: a few controls at the canvas's side, the only place it is. The orb is the voice,
 * which is on as soon as the board is; while Pi works it is
 * Stop. What Pi says while drawing stands over the board. The chat window is where words are read and
 * typed, opened and shut from here, and neither touches the voice. Each board has its own, named for
 * the board.
 */
import { useEffect, useRef, useState } from 'react';
import type { BoardSummary } from '@merv/board/models';
import { call, refreshTools, safely } from '../api';
import { Icon } from '../icons';
import { Composer, Standing, Transcript, useAgent } from '../views/pi';

/** Whether this browser talks to Pi: 'on' once it has, 'off' once it was told to stop. */
const VOICE = 'board:voice';
/** Whether this browser has been through hello: set once Merv has said something to them. */
const HI = 'board:hi';
/** What a board still called Untitled is called once it is asked something; Pi may name it better. */
const named = (words: string) => {
  const line = words.replace(/\s+/g, ' ').trim();
  return line.length <= 48 ? line : `${line.slice(0, 48).replace(/\s+\S*$/, '')}…`;
};

export function BoardBar({
  board: { id: board, title },
  talking,
  show,
}: {
  board: Pick<BoardSummary, 'id' | 'title'>;
  talking: boolean;
  show(shown: boolean): void;
}) {
  const agent = useAgent();
  const pi = agent?.pi;
  const voice = agent?.voice;
  const [here, setHere] = useState<string>();
  // The conversation lives from the moment a board is open, with no window to show for it.
  useEffect(() => agent?.wake(), [agent?.wake]);
  const listed = !!pi?.listed;
  const selected = pi?.selected;
  useEffect(() => {
    if (!listed) return;
    let live = true;
    void pi!
      .openKeyed(board)
      .then(() => live && setHere(board))
      .catch(() => undefined);
    return () => {
      live = false;
      setHere(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, board]);
  const asked = here === board ? pi?.snapshot?.commands[0]?.messages[0]?.text : undefined;
  useEffect(() => {
    if (title !== 'Untitled' || !asked) return;
    void call('board.set', { id: board, title: named(asked) }).then(
      () => refreshTools('board.read', 'board.scene'),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, title]);
  const state = voice?.state ?? 'off';
  const live = state !== 'off';
  const ready = !!here && !!selected && !pi?.blocked && !pi?.unavailable && !!pi?.snapshot;
  useEffect(() => {
    if (state === 'listening') safely(() => localStorage.setItem(VOICE, 'on'));
  }, [state]);
  // Voice is on from the moment the board is, unless this browser was told to stop. Once a page, so
  // that idling or a refused microphone never asks again by itself.
  const armed = useRef(false);
  useEffect(() => {
    if (!ready || armed.current || live) return;
    armed.current = true;
    if (safely(() => localStorage.getItem(VOICE), null) !== 'off') voice?.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, live]);
  // A first sign-in is told Merv will say hi, and it does the moment it is up.
  const [hi, setHi] = useState(() => !safely(() => localStorage.getItem(HI), null));
  const said = !!voice?.said;
  const up = state === 'listening' && pi?.snapshot?.host?.state === 'ready';
  const greeted = useRef(false);
  useEffect(() => {
    if (!hi || !said) return;
    safely(() => localStorage.setItem(HI, 'said'));
    setHi(false);
  }, [hi, said]);
  useEffect(() => {
    if (!hi || !up || said || greeted.current) return;
    greeted.current = true;
    voice?.speak("Hi, I'm Merv. What are we working on?");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hi, up, said]);
  if (!pi || !voice) return <div className="board-bar" />;
  // Until the voice is up and a machine is there to do what it hears, Merv is getting ready.
  const getting =
    !pi.error &&
    !voice.problem &&
    (!ready ||
      state === 'connecting' ||
      (live && state !== 'closing' && pi.snapshot?.host?.state !== 'ready'));
  return (
    <div className="board-bar">
      {(pi.error || voice.problem) && (
        <p className="board-said--bad" role="alert">
          {pi.error || voice.problem}
        </p>
      )}
      {hi && !pi.error && !voice.problem ? (
        <p className="board-bar-hi" role="status">
          {live || getting
            ? "This is Merv. It'll say hi when it's ready."
            : 'This is Merv. Click it to start.'}
          {getting && <small>Getting Merv ready</small>}
        </p>
      ) : (
        getting && (
          <p className="board-bar-getting" role="status">
            Getting Merv ready
          </p>
        )
      )}
      {pi.active ? (
        <button
          type="button"
          className="board-orb board-orb--stop"
          title="Stop"
          onClick={voice.halt}
        >
          <span className="sr-only">Stop</span>
        </button>
      ) : live ? (
        <button
          type="button"
          className={`board-orb board-orb--live${voice.muted ? ' is-muted' : ''}${getting ? ' is-getting' : ''}`}
          data-state={state}
          aria-pressed={voice.muted}
          title={voice.muted ? 'Unmute' : 'Mute'}
          onClick={voice.mute}
        >
          <span className="sr-only">{voice.muted ? 'Unmute' : 'Mute'}</span>
        </button>
      ) : (
        <button
          type="button"
          className={`board-orb${getting ? ' is-getting' : ''}`}
          title="Talk"
          disabled={getting}
          onClick={voice.start}
        >
          <span className="sr-only">Talk to Merv</span>
        </button>
      )}
      <button
        type="button"
        className="btn-icon"
        aria-pressed={talking}
        aria-label={talking ? 'Hide chat' : 'Show chat'}
        title={talking ? 'Hide chat' : 'Show chat'}
        onClick={() => show(!talking)}
      >
        <Icon name="chat" size={16} />
      </button>
      {live && (
        <button
          type="button"
          className="btn-icon"
          aria-label="End voice"
          title="End voice"
          onClick={() => {
            safely(() => localStorage.setItem(VOICE, 'off'));
            safely(() => localStorage.setItem(HI, 'said'));
            setHi(false);
            voice.stop();
          }}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/** The chat: the whole conversation and where to type, in the place the outcome takes beside the board. */
export function Conversation({ close }: { close(): void }) {
  const pi = useAgent()?.pi;
  if (!pi) return null;
  return (
    <aside className="board-talk-pane" aria-label="Conversation">
      <header className="board-talk-head">
        <span role="status" className="pi-state">
          <Standing pi={pi} dot />
        </span>
        <span className="board-talk-title">Conversation</span>
        <button type="button" className="btn-icon" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <Transcript pi={pi} />
      <Composer pi={pi} rows={2} placeholder="Ask Merv" />
    </aside>
  );
}
