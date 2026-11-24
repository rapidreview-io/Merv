import { providerName } from '@merv/protocol/runtime';
/**
 * Work handed from the board, waiting here before it starts. The card is three things: the picture
 * the agent gets, Merv's prompt written in behind the picture, and Send, which fills up over
 * 30 seconds and then sends itself. A touch stops it. When both agents are signed in, a toggle picks which one gets it.
 * When Merv's turn ends without a prompt, the card says why and nothing is sent: the person may ask
 * Merv again, or edit their own words and send those themselves.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RuntimeModel } from '@merv/protocol/runtime';
import { useDeskCall } from './desk-calls';
import { ProviderMark } from './marks';

import type { Provider } from '@merv/protocol/runtime';
export interface Held {
  id: string;
  /** A unit from Merv, or the selection as sent while its unit is still on the way. */
  kind?: 'unit' | 'offer';
  /** The selection this unit took up: the card keeps its place and its picture. */
  offer?: string;
  /** The picture as the person saw it when they sent it. */
  shot?: string;
  /** How the part of the board Merv froze compares with that selection. */
  fit?: 'same' | 'wider' | 'other';
  since?: number;
  /** A selection still waiting for Merv's generated task. */
  slow?: boolean;
  /** Merv wrote no task prompt for this selection, and why. */
  failed?: { reason: 'none' | 'routed' | 'refused' | 'interrupted' | 'expired'; detail?: string };
  board?: { id: string; title?: string };
  unit: {
    id: string;
    title: string;
    request?: string;
    brief: string;
    context?: string;
    picture?: string;
    imageStatus?: string;
    concepts?: string[];
    items?: number;
  };
  configuration?: { provider: Provider; model?: string; effort?: string }[];
  providers: Provider[];
  cwd: string;
  label: string;
  sendAt: number | null;
  /** Never sent by itself: it waits for the person, whose press is an approval (Merv's cloud runs). */
  approve?: boolean;
  /** The agents signed in on this Mac, and the shared folders it can go to. */
  choices?: { providers: Provider[]; folders: { cwd: string; label: string; main?: boolean }[] };
}

/** Why no prompt came, as the person reads it on the card. */
function failure({ reason, detail }: NonNullable<Held['failed']>) {
  const quoted = detail && `“${detail.length > 240 ? `${detail.slice(0, 239)}…` : detail}”`;
  if (reason === 'none')
    return quoted
      ? `Merv answered without writing a task prompt: ${quoted}.`
      : 'Merv answered without writing a task prompt.';
  if (reason === 'routed')
    return 'Merv added this to a session that was already running instead of writing a task prompt for it.';
  if (reason === 'refused') return `Merv could not hand this off${detail ? `: ${detail}` : '.'}`;
  if (reason === 'interrupted') return 'Merv stopped before writing the task prompt.';
  return 'No task prompt came from Merv.';
}

const nameOf = (provider?: Provider) => (provider ? providerName(provider) : 'the agent');
/** After this long, say that the prompt is still on its way. */
const SLOW_MS = 25_000;
/** The prompt writes itself in at this pace once it arrives. */
const WRITE_MS = 14;

/** `places`: the folders this Mac has lately worked in, newest first, offered when the person changes where it goes. */
export function Handoffs({
  held,
  places = [],
  onDone,
}: {
  held: Held[];
  places?: string[];
  onDone(): void;
}) {
  useEffect(() => {
    if (held.length)
      (window as { desk?: { showPanel?(show: boolean): void } }).desk?.showPanel?.(true);
  }, [held.length]);
  // However long the prompt or short the window, each card's Send stays in the panel: the picture and prompt scroll instead.
  return held.length ? (
    <div className="handoffs">
      {held.map((item) => (
        <Handoff key={item.offer ?? item.id} held={item} places={places} onGone={onDone} />
      ))}
    </div>
  ) : null;
}

function Handoff({ held, onGone }: { held: Held; places: string[]; onGone(): void }) {
  const call = useDeskCall();
  const offer = held.kind === 'offer';
  const agents = held.choices?.providers ?? held.providers;
  // Merv's choice of agent stands until the person picks the other one themselves.
  const [picked, setPicked] = useState<Provider>();
  const provider = picked ?? held.providers[0] ?? agents[0];
  const [brief, setBrief] = useState(held.unit.brief);
  const dirty = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(Date.now());
  const folder = held.cwd;
  const waiting = held.sendAt === null;
  const failed = offer ? held.failed : undefined;
  const pending = offer && !failed;
  const slow = pending && (held.slow || now - (held.since ?? now) >= SLOW_MS);
  // Their own words, for them to send themselves once Merv has written nothing; never an invented task.
  const own = held.unit.request && held.unit.request !== 'Execute this' ? held.unit.request : '';

  // The prompt writes itself in when it arrives; the person's own edits are never overwritten.
  const arrived = offer ? '' : held.unit.brief;
  const [written, setWritten] = useState(arrived ? 0 : -1);
  const wrote = useRef('');
  useEffect(() => {
    if (!arrived || arrived === wrote.current) return;
    wrote.current = arrived;
    if (dirty.current) return;
    setWritten(0);
  }, [arrived]);
  const writing = written >= 0 && written < arrived.length;
  useEffect(() => {
    if (!writing) return;
    const timer = setTimeout(
      () => setWritten((n) => Math.min(arrived.length, n + 1 + Math.floor(arrived.length / 120))),
      WRITE_MS,
    );
    return () => clearTimeout(timer);
  }, [writing, written, arrived.length]);
  useEffect(() => {
    if (written >= 0 && !writing && !dirty.current) setBrief(arrived);
  }, [writing, written, arrived]);
  // No prompt: their own words stand in the field for them to edit and send; asked again, it empties.
  useEffect(() => {
    if (offer && !dirty.current) setBrief(failed ? own : '');
  }, [offer, failed?.reason, own]);

  useEffect(() => {
    if ((waiting && !offer) || failed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, offer, failed]);

  const seconds = held.sendAt === null ? 0 : Math.max(0, Math.ceil((held.sendAt - now) / 1000));
  const fill = offer ? 0 : waiting ? 0 : 1 - Math.max(0, held.sendAt! - now) / 30_000;
  const act = async (what: 'send' | 'cancel') => {
    if (what === 'send' && pending) return;
    setBusy(true);
    setProblem('');
    try {
      const chosen = picked && picked !== held.providers[0] ? { provider: picked } : {};
      if (offer)
        await call(
          `handoffs/${held.id}/${what}`,
          what === 'send'
            ? { brief, ...(provider && { provider }), ...(folder && { cwd: folder }) }
            : {},
        );
      else
        await call(
          `held/${held.id}/${what}`,
          what === 'send'
            ? {
                ...(dirty.current && { brief }),
                ...chosen,
                ...(folder && folder !== held.cwd && { cwd: folder }),
              }
            : {},
        );
      onGone();
    } catch (error) {
      setBusy(false);
      const code = (error as Error).message;
      setProblem(
        code === 'choose_folder'
          ? 'Choose a folder to send it to.'
          : code === 'no_agent'
            ? 'No agent is signed in on this Mac.'
            : code === 'offer_adopted'
              ? 'Merv’s task arrived. Your edits are preserved; review the task before sending.'
              : code === 'offer_sending'
                ? 'This task is being sent. Wait for the result before trying again.'
                : code === 'request_closed'
                  ? 'It has already started, or was cancelled.'
                  : 'Could not send it.',
      );
    }
  };
  // Merv is asked again with the same words, from the board they were sent on; the card waits once more.
  const retry = async () => {
    setBusy(true);
    setProblem('');
    const asked = await window.desk!.handoffRetry!(held.id).catch(() => false);
    setBusy(false);
    if (!asked)
      setProblem('Could not ask Merv again. Open that board in Merv and send it from there.');
    else dirty.current = false;
    onGone();
  };
  const pausing = useRef(false);
  const pause = () => {
    if (offer || waiting || pausing.current) return;
    pausing.current = true;
    void call(`held/${held.id}/hold`, {}).then(
      () => onGone(),
      () => {
        pausing.current = false;
        onGone();
      },
    );
  };
  const status = failed
    ? failure(failed)
    : slow
      ? 'Merv is still writing the task prompt. Nothing has been sent.'
      : pending
        ? 'Merv is writing the task prompt'
        : waiting
          ? 'Waiting for you'
          : `${nameOf(provider)} starts in ${seconds}s`;
  const shown = writing ? arrived.slice(0, written) : brief;
  // The field grows with the prompt, however long Merv makes it; only past forty lines does it scroll.
  const rows = pending
    ? 2
    : Math.min(
        40,
        Math.max(
          3,
          (writing ? arrived : shown)
            .split('\n')
            .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 52)), 0) + 1,
        ),
      );
  const folders = held.choices?.folders ?? [];
  const needsFolder = !!failed && !folder && folders.length > 0;
  return (
    <div
      className={`handoff is-${offer ? 'offer' : 'unit'}${slow ? ' is-slow' : ''}${failed ? ' is-failed' : ''}`}
      onPointerDown={pause}
      onFocus={pause}
      onKeyDown={pause}
    >
      {/* Said aloud to assistive tech always; shown only when there is something to read: a slow prompt, or none. */}
      {failed ? (
        <p className="handoff-note is-failed" role="alert">
          {status} Nothing has been sent.{' '}
          {window.desk?.handoffRetry
            ? 'Ask Merv again, or edit your words and send them yourself.'
            : 'Edit your words and send them yourself.'}
        </p>
      ) : (
        <span className={slow ? 'handoff-note' : 'handoff-status'} role="status">
          {status}
        </span>
      )}
      <div className="handoff-message">
        <div className={`handoff-shot${pending ? ' is-reading' : ''}`}>
          {/* The person's own screenshot lands first; once the agent's picture is here it takes the frame, and the screenshot fades off it. */}
          {held.unit.imageStatus === 'failed' && (
            <p role="status">
              Board image could not be captured. Send without it, or cancel and ask Merv to retry
              the capture.
            </p>
          )}
          {held.unit.picture && (
            <img
              className={offer ? undefined : 'is-agent'}
              src={held.unit.picture}
              alt={offer ? 'What you selected' : `What ${nameOf(provider)} is handed`}
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
          {!offer && held.shot && held.shot !== held.unit.picture && (
            <img
              className="is-shot"
              src={held.shot}
              alt=""
              aria-hidden="true"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
          {held.fit === 'wider' && (
            <span className="handoff-fit">Merv took in more than you selected</span>
          )}
          {held.fit === 'other' && (
            <span className="handoff-fit">Merv picked another part of the board</span>
          )}
          <button
            className="handoff-cancel"
            aria-label="Cancel"
            disabled={busy}
            onClick={() => act('cancel')}
          >
            ×
          </button>
        </div>
        <textarea
          className={`handoff-brief${pending ? ' is-writing' : ''}${writing ? ' is-arriving' : ''}`}
          aria-label="Task"
          value={shown}
          rows={rows}
          maxLength={8000}
          readOnly={writing || pending}
          placeholder={pending ? 'Merv is writing the task prompt…' : 'What should it do?'}
          onChange={(event) => {
            dirty.current = true;
            setBrief(event.target.value);
          }}
        />
      </div>
      {held.configuration?.map((entry, i) => (
        <RunConfiguration
          key={i}
          entry={entry}
          run={i}
          held={held}
          pause={pause}
          done={onGone}
          error={setProblem}
        />
      ))}
      <div className="handoff-foot">
        {!held.configuration?.length && agents.length > 1 && (
          <div className="handoff-pick" role="radiogroup" aria-label="Agent">
            {agents.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={provider === p}
                className={provider === p ? 'is-on' : ''}
                onClick={() => setPicked(p)}
                aria-label={nameOf(p)}
                title={nameOf(p)}
              >
                <ProviderMark provider={p} size={14} />
              </button>
            ))}
          </div>
        )}
        {/* In Merv a task has no folder to choose: the Mac's folder picker is left out. */}
        {failed && window.desk?.handoffRetry && (
          <button type="button" className="handoff-retry" disabled={busy} onClick={retry}>
            Ask Merv again
          </button>
        )}
        <button
          className="primary handoff-send"
          style={{ '--fill': fill } as CSSProperties}
          disabled={busy || !brief.trim() || writing || pending || needsFolder}
          onClick={() => act('send')}
          aria-label={
            seconds
              ? `Send now; ${nameOf(provider)} starts in ${seconds} seconds`
              : held.approve
                ? 'Approve'
                : 'Send'
          }
        >
          {held.approve ? 'Approve' : 'Send'}
        </button>
      </div>
      {problem && (
        <p className="handoff-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function RunConfiguration({
  entry,
  run,
  held,
  pause,
  done,
  error,
}: {
  entry: { provider: Provider; model?: string; effort?: string };
  run: number;
  held: Held;
  pause(): void;
  done(): void;
  error(message: string): void;
}) {
  const call = useDeskCall();
  const [models, setModels] = useState<RuntimeModel[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void call<RuntimeModel[]>(`models/${entry.provider}?cwd=${encodeURIComponent(held.cwd)}`).then(
      (models) => {
        if (live) setModels(models);
      },
      () => {
        if (live) setModels([]);
      },
    );
    return () => {
      live = false;
    };
  }, [entry.provider, held.cwd]);
  const selected = models.find(
    (model) => model.id === entry.model || model.resolved === entry.model,
  );
  const change = async (input: { provider: Provider; model?: string; effort?: string }) => {
    pause();
    setBusy(true);
    error('');
    try {
      await call(`held/${held.id}/configuration`, { run, ...input });
      done();
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="handoff-configuration" aria-label={`Run ${run + 1} configuration`}>
      <label>
        Provider{' '}
        <select
          disabled={busy}
          value={entry.provider}
          onChange={(e) => void change({ provider: e.target.value as Provider })}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label>
        Model{' '}
        <select
          disabled={busy}
          value={selected?.id ?? entry.model ?? ''}
          onChange={(e) =>
            void change({ provider: entry.provider, model: e.target.value || undefined })
          }
        >
          <option value="">Desktop default</option>
          {!selected && entry.model && <option value={entry.model}>{entry.model}</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effort{' '}
        <select
          disabled={busy}
          value={entry.effort ?? ''}
          onChange={(e) =>
            void change({
              provider: entry.provider,
              model: entry.model,
              effort: e.target.value || undefined,
            })
          }
        >
          <option value="">Desktop default</option>
          {(
            selected?.capabilities.efforts.filter(Boolean) ?? (entry.effort ? [entry.effort] : [])
          ).map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
