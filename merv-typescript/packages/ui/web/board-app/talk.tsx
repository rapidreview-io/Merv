/**
 * Pi, on the board: a few controls at the canvas's side, the only place it is. The orb is the voice,
 * which is on from the first gesture for someone who has talked here before; while Pi works it is
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
  // A browser needs a gesture before a microphone or a voice: someone who has talked here, and has
  // not been told otherwise, starts with their first one. Once a page, so idling never comes back.
  const armed = useRef(false);
  useEffect(() => {
    if (!ready || armed.current || live) return;
    if (safely(() => localStorage.getItem(VOICE), null) !== 'on') return;
    armed.current = true;
    const events = ['pointerdown', 'keydown'];
    const first = () => {
      for (const kind of events) removeEventListener(kind, first, true);
      voice?.start();
    };
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(({ state: allowed }) => {
        if (allowed === 'granted') for (const kind of events) addEventListener(kind, first, true);
      })
      .catch(() => undefined);
    return () => {
      for (const kind of events) removeEventListener(kind, first, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, live]);
  if (!pi || !voice) return <div className="board-bar" />;
  const fresh = safely(() => localStorage.getItem(VOICE), null) === null;
  return (
    <div className="board-bar">
      {(pi.error || voice.problem) && (
        <p className="board-said--bad" role="alert">
          {pi.error || voice.problem}
        </p>
      )}
      {pi.active ? (
        <button
          type="button"
          className="board-orb board-orb--stop"
          title="Stop"
          onClick={() => {
            voice.hush();
            void pi.stop();
          }}
        >
          <span className="sr-only">Stop</span>
        </button>
      ) : live ? (
        <button
          type="button"
          className={`board-orb board-orb--live${voice.muted ? ' is-muted' : ''}`}
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
          className={`board-orb${fresh ? ' board-orb--invite' : ''}`}
          title="Talk"
          disabled={!ready}
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
