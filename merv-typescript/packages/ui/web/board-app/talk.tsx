/**
 * Pi, on the board: one line at the canvas's foot. Words go in it; the orb at its end is the voice;
 * while Pi works the line says Stop. What Pi says stands over the line for a moment; the whole
 * conversation is a pane, asked for. Each board has its own, named for the board.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { MarkdownPieces } from '../markdown';
import { Model } from '../views/pi-cards';
import { Floating } from '../views/pi-dock';
import { Composer, Standing, Transcript, useAgent } from '../views/pi';

/** How long Pi's last words stand over the line. */
const SAID_MS = 12_000;

/** What Pi said last, while it says it and for a moment after, as `open` will show in whole. */
function Said({ open }: { open(): void }) {
  const pi = useAgent()?.pi;
  const last = pi?.snapshot?.commands.at(-1);
  const said = last?.messages.filter((message) => message.role === 'assistant').at(-1)?.text;
  // Only what has just been said: a board opened later starts with nothing over its line.
  const fresh = !!last?.completedAt && Date.now() - Date.parse(last.completedAt) < SAID_MS;
  const words = pi?.visible?.text || (!pi?.active && fresh ? said : '');
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (!words || pi?.active) return;
    const timer = setTimeout(() => setGone(true), SAID_MS);
    return () => clearTimeout(timer);
  }, [words, pi?.active]);
  if (!words || (gone && !pi?.active)) return null;
  return (
    <button type="button" className="board-said" onClick={open}>
      <MarkdownPieces source={words} />
    </button>
  );
}

export function BoardBar({ board, open }: { board: string; open(): void }) {
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
  if (!pi || !voice) return <div className="board-bar" />;
  // Said by voice, the voice's own orb floats; Show chat there is the conversation here.
  if (voice.state !== 'off')
    return (
      <Floating
        pi={pi}
        voice={voice}
        expand={() => {
          voice.setCompact(true);
          open();
        }}
        hide={() => voice.stop()}
      />
    );
  const { snapshot, active, draft, blocked, unavailable, busy } = pi;
  const ready = !!here && !!selected && !blocked && !unavailable && !!snapshot;
  return (
    <div className="board-bar">
      <Said open={open} />
      {(pi.error || voice.problem) && (
        <p className="board-said board-said--bad" role="alert">
          {pi.error || voice.problem}
        </p>
      )}
      <div className="board-bar-line">
        <Composer pi={pi} rows={1} placeholder={ready ? 'Ask Pi' : ''} />
        <span className="board-bar-end">
          {snapshot && snapshot.models.length > 1 && (
            <Model
              models={snapshot.models}
              model={snapshot.conversation.model}
              busy={busy}
              pick={pi.pickModel}
            />
          )}
          {active && !draft.trim() ? (
            <button type="button" className="board-orb board-orb--stop" title="Stop" onClick={() => void pi.stop()}>
              <span className="sr-only">Stop</span>
            </button>
          ) : draft.trim() ? (
            <button
              type="button"
              className="board-orb board-orb--send"
              title="Send"
              disabled={busy || !ready}
              onClick={() => void pi.send()}
            >
              <Icon name="arrow-right" size={18} />
              <span className="sr-only">Send</span>
            </button>
          ) : (
            <button
              type="button"
              className="board-orb"
              title="Talk"
              disabled={!ready}
              onClick={() => {
                voice.setCompact(true);
                voice.start();
              }}
            >
              <span className="sr-only">Talk to Pi</span>
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** The whole conversation, in the place the outcome takes beside the board. */
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
    </aside>
  );
}
