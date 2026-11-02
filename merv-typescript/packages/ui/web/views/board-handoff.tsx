/**
 * Handing what is on a board to the person's own Claude Code or Codex, and following the session
 * beside the board. The server side is @merv/board/handoff; the person's machine runs
 * clients/board-connect. Only an app that hosts the pane (`hostHandoff`) shows any of it, and only
 * when the server lists the hand-off row: otherwise this file draws nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { exportToBlob } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { NAMES, type Harness, type Run, type RunEvent } from '@merv/board/handoff-models';
import { call, projectSelection, refreshTools, useTool } from '../api';
import { Icon } from '../icons';
import { MarkdownPieces } from '../markdown';
import { useRows } from '../navigation';

export type HandoffOpen = { run?: string; start?: Start };
type Start = { elements: string[]; words: string; picture?: { data: string; mimeType: string } };
type Connector = {
  name: string;
  repos: string[];
  claude: boolean;
  codex: boolean;
  online: boolean;
};
type Read = { enabled: boolean; connector: Connector | null; runs: Run[] };
const WORDS: Record<Run['state'], string> = {
  queued: 'starting',
  running: 'running',
  asking: 'needs you',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
};
const ACTIVE = new Set<Run['state']>(['queued', 'running', 'asking']);

/** The one app that shows sessions sets this; the canvas asks it to open one. */
let host: ((open: HandoffOpen) => void) | undefined;
export const hostHandoff = (open: (open: HandoffOpen) => void) => {
  host = open;
  return () => void (host = undefined);
};
export const useHandoffEnabled = () => !!host && useRows().some((row) => row.id === 'handoff');
/** A board's sessions, kept fresh while anything shows them. */
const useHandoff = (board: string, enabled: boolean) =>
  useTool<Read>(enabled ? 'handoff.read' : null, { board }, { every: 3000 });
const standing = (run: Run, online: boolean) =>
  !online && ACTIVE.has(run.state) ? 'offline' : WORDS[run.state];

/** In the selection's island: hand the chosen shapes off, or open the session a tag stands for. */
export function HandoffButton({
  api,
  board,
  chosen,
}: {
  api: ExcalidrawImperativeAPI;
  board: string;
  chosen: readonly ExcalidrawElement[];
}) {
  const enabled = useHandoffEnabled();
  const read = useHandoff(board, enabled);
  const tag = read.data?.runs.find((run) => chosen.length === 1 && run.tag === chosen[0]!.id);
  useEffect(() => {
    if (tag) host?.({ run: tag.id });
  }, [tag?.id]);
  const [busy, setBusy] = useState(false);
  if (!enabled || tag) return null;
  const hand = async () => {
    setBusy(true);
    try {
      const scene = api.getSceneElements();
      const ids = new Set(chosen.map((el) => el.id));
      const parts = scene.filter(
        (el) =>
          ids.has(el.id) ||
          ('containerId' in el && el.containerId && ids.has(el.containerId)) ||
          (el.frameId && ids.has(el.frameId)),
      );
      const words = parts
        .flatMap((el) =>
          'text' in el && el.text ? [el.text] : el.type === 'frame' && el.name ? [el.name] : [],
        )
        .join('\n')
        .slice(0, 8000);
      let picture: Start['picture'];
      try {
        const blob = await exportToBlob({
          elements: parts,
          files: api.getFiles(),
          mimeType: 'image/png',
          exportPadding: 24,
          maxWidthOrHeight: 1400,
          appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (const byte of bytes) bin += String.fromCharCode(byte);
        if (bin.length < 1_100_000) picture = { data: btoa(bin), mimeType: 'image/png' };
      } catch {
        // Without a picture the words still go.
      }
      host?.({ start: { elements: [...ids], words, picture } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" disabled={busy} onClick={() => void hand()}>
      Hand off
    </button>
  );
}

/** The column beside the board: the board's sessions, and the one open, live. */
export function HandoffPane({
  board,
  open,
  close,
}: {
  board: string;
  open: HandoffOpen;
  close(): void;
}) {
  const read = useHandoff(board, true);
  const [picked, setPicked] = useState(open.run);
  const [starting, setStarting] = useState(open.start);
  useEffect(() => {
    setPicked(open.run);
    setStarting(open.start);
  }, [open]);
  const runs = read.data?.runs ?? [];
  const connector = read.data?.connector;
  const online = !!connector?.online;
  const run = runs.find((one) => one.id === picked);
  return (
    <aside className="board-talk-pane board-handoff" aria-label="Sessions">
      <header className="board-talk-head">
        <span className="board-talk-title">{run ? NAMES[run.harness] : 'Sessions'}</span>
        <span className={`muted board-handoff-machine${online ? ' is-on' : ''}`}>
          {connector ? `${connector.name} · ${online ? 'on' : 'off'}` : 'no machine'}
        </span>
        <button type="button" className="btn-icon" aria-label="Close" title="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      {!starting && (
        <nav className="board-handoff-list" aria-label="Sessions on this board">
          {runs.map((one) => (
            <button
              type="button"
              key={one.id}
              aria-current={one.id === picked || undefined}
              onClick={() => setPicked(one.id)}
            >
              <span
                className={`board-handoff-dot is-${standing(one, online)}`}
                aria-hidden="true"
              />
              <span className="board-handoff-brief">{one.brief}</span>
              <span className="muted">
                {NAMES[one.harness]} · {standing(one, online)}
              </span>
            </button>
          ))}
          {!runs.length && <p className="muted">Select something on the board and hand it off.</p>}
        </nav>
      )}
      {starting ? (
        <StartForm
          board={board}
          start={starting}
          connector={connector ?? null}
          done={(id) => {
            setStarting(undefined);
            setPicked(id);
          }}
          cancel={close}
        />
      ) : (
        run && <Session key={run.id} run={run} online={online} />
      )}
    </aside>
  );
}

/** The command that connects a machine, with what this page knows filled in. */
const connectLine = () =>
  `node clients/board-connect/connect.mjs --server ${location.origin} --project ${projectSelection() ?? '<project>'} --key <your key> --repo ~/path/to/repo`;

function StartForm({
  board,
  start,
  connector,
  done,
  cancel,
}: {
  board: string;
  start: Start;
  connector: Connector | null;
  done(run: string): void;
  cancel(): void;
}) {
  const harnesses = (['claude', 'codex'] as const).filter((one) => connector?.[one]);
  const [harness, setHarness] = useState<Harness | undefined>(harnesses[0]);
  const [repo, setRepo] = useState(connector?.repos[0]);
  const [brief, setBrief] = useState(start.words.split('\n')[0]?.slice(0, 200) ?? '');
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setHarness((held) => held ?? harnesses[0]);
    setRepo((held) => held ?? connector?.repos[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector?.name, connector?.online]);
  if (!connector?.online)
    return (
      <div className="board-handoff-start">
        <p>Your machine is not connected. On it, run:</p>
        <pre className="board-handoff-command">{connectLine()}</pre>
        <p className="muted">It dials out from your Mac; the folder's path stays there.</p>
      </div>
    );
  const go = async () => {
    if (!harness || !repo || !brief.trim()) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const { run } = await call<{ run: Run }>('handoff.start', {
        board,
        elements: start.elements,
        harness,
        repo,
        brief: brief.trim(),
        words: start.words,
        ...(start.picture && { picture: start.picture }),
      });
      refreshTools('handoff.read');
      done(run.id);
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="board-handoff-start"
      onSubmit={(event) => {
        event.preventDefault();
        void go();
      }}
    >
      {start.picture && (
        <img
          className="board-handoff-picture"
          alt="What is handed off"
          src={`data:${start.picture.mimeType};base64,${start.picture.data}`}
        />
      )}
      <label>
        To
        <span className="board-handoff-choices">
          {harnesses.map((one) => (
            <button
              type="button"
              key={one}
              className="btn btn--sm"
              aria-pressed={harness === one}
              onClick={() => setHarness(one)}
            >
              {NAMES[one]}
            </button>
          ))}
        </span>
      </label>
      <label>
        In
        <span className="board-handoff-choices">
          {connector.repos.map((one) => (
            <button
              type="button"
              key={one}
              className="btn btn--sm"
              aria-pressed={repo === one}
              onClick={() => setRepo(one)}
            >
              {one}
            </button>
          ))}
        </span>
      </label>
      <label>
        Brief
        <input
          className="input"
          value={brief}
          maxLength={600}
          autoFocus
          onChange={(event) => setBrief(event.target.value)}
        />
      </label>
      {problem && <p className="pi-error">{problem}</p>}
      <div className="board-handoff-choices">
        <button type="submit" className="btn btn--primary" disabled={busy || !harness || !repo}>
          Hand off
        </button>
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const GLYPH: Record<string, string> = { completed: '✓', failed: '✗', allowed: '✓', denied: '✗' };

function Session({ run: listed, online }: { run: Run; online: boolean }) {
  const read = useTool<{ run: Run; events: RunEvent[]; online: boolean }>(
    'handoff.session',
    { run: listed.id },
    { every: 1000 },
  );
  const run = read.data?.run ?? listed;
  const events = read.data?.events ?? [];
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const box = list.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [events.length, events.at(-1)?.text.length]);
  const act = (name: string, input: Record<string, unknown>) =>
    call(name, { run: run.id, ...input }).then(
      () => {
        setProblem(undefined);
        refreshTools('handoff.session', 'handoff.read');
      },
      (error: Error) => setProblem(error.message),
    );
  const active = ACTIVE.has(run.state);
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void act('handoff.say', { text });
  };
  const ask = run.ask;
  const option = (kind: string) => ask?.options.find((one) => one.kind.startsWith(kind));
  return (
    <>
      <div
        className="pi-messages"
        ref={list}
        aria-live="polite"
        onScroll={({ currentTarget: box }) => {
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
        }}
      >
        <p className="muted board-handoff-standing">
          {run.brief} — {standing(run, online)}
          {run.error && ` · ${run.error}`}
        </p>
        {events.map((event) =>
          event.kind === 'you' ? (
            <article className="pi-message pi-message--user" key={event.seq}>
              <span className="pi-speaker">You</span>
              <div className="pi-message-text">{event.text}</div>
            </article>
          ) : event.kind === 'agent' ? (
            <article className="pi-message pi-message--assistant" key={event.seq}>
              <span className="pi-speaker">{NAMES[run.harness]}</span>
              <MarkdownPieces source={event.text} />
            </article>
          ) : (
            <p className={`muted board-handoff-line is-${event.kind}`} key={event.seq}>
              <span aria-hidden="true">
                {GLYPH[event.status ?? ''] ?? (event.kind === 'ask' ? '?' : '·')}
              </span>{' '}
              {event.kind === 'ask' ? `Asked: ${event.text}` : event.text}
              {event.status === 'denied' && ' — denied'}
              {event.status === 'allowed' && ' — allowed'}
            </p>
          ),
        )}
        {run.result && (
          <p className="muted board-handoff-result">
            Changes are on branch <code>{run.result.branch}</code> in <code>{run.result.dir}</code>
            {run.result.stat && <pre>{run.result.stat}</pre>}
          </p>
        )}
      </div>
      {ask && (
        <div className="board-handoff-ask" role="alert">
          <p>{ask.title}</p>
          <div className="board-handoff-choices">
            {option('allow') && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() =>
                  void act('handoff.answer', { ask: ask.id, option: option('allow')!.id })
                }
              >
                Allow
              </button>
            )}
            {option('reject') && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  void act('handoff.answer', { ask: ask.id, option: option('reject')!.id })
                }
              >
                Deny
              </button>
            )}
          </div>
        </div>
      )}
      {problem && <p className="pi-error">{problem}</p>}
      <form
        className="pi-compose"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="textarea"
          rows={2}
          value={draft}
          maxLength={8000}
          placeholder={
            active ? `Steer ${NAMES[run.harness]}` : `Tell ${NAMES[run.harness]} what next`
          }
          disabled={run.state === 'queued'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        <div className="pi-compose-actions">
          <button type="submit" className="btn" disabled={run.state === 'queued' || !draft.trim()}>
            {active ? 'Steer' : 'Send'}
          </button>
          {active && (
            <button type="button" className="btn" onClick={() => void act('handoff.stop', {})}>
              Stop
            </button>
          )}
        </div>
      </form>
    </>
  );
}
