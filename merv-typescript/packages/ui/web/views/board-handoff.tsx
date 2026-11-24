import { useBoardView } from '../board-app/board-view';
import { useBackCloses } from '../board-app/phone-back';
import { ProviderMark } from '../panel/marks';
import { agentName as nameOf } from '../board-app/sessions';
/**
 * Handing board work to an agent, the board's half (web and Merv.app; docs/handoff.md). A selection
 * that rests offers one mark: pressing it asks Merv, in the person's own words, to execute it. An
 * agent's own look at the board plays as its snapshot there, and nothing is left on the board. The agent's questions come back as cards beside the work, answered by a click
 * or by talking with Merv; a card goes once answered.
 */
import { useEffect, useRef, useState } from 'react';
import { getCommonBounds, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Chat } from '@merv/protocol/link';
import { accountRequest, call } from '../api';
import { exportBoardSnapshot } from './board-export';
import { worn } from '../theme';
import { agentLooks } from './board-presence';
import { useAgent } from './pi';
import { answeringTurn, promptOutcome, type PromptFailure } from './handoff-turn';
import { hold } from '../board-app/held';
import './board-handoff.css';

type Provider = 'claude' | 'codex';
type Region = { x: number; y: number; width: number; height: number };
type Pt = { x: number; y: number };
type Ask = {
  device: string;
  thread: string;
  generation: number;
  unit: string;
  run: number;
  provider: Provider;
  root?: Region;
  request: Chat['requests'][number];
};
type Decision =
  | { kind: 'allow' | 'deny' }
  | { kind: 'answer'; text?: string; answers?: Record<string, string[]> };

/** A selection rests this long before it offers the mark; the desk is asked this often. */
const [REST_MS, POLL_MS] = [600, 2000];
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const keyOf = (ask: Ask) => `${ask.thread}:${ask.request.id}:${ask.generation}`;

export function BoardHandoff(props: {
  api: ExcalidrawImperativeAPI;
  board: string;
  title: string;
}) {
  useHere(props.api, props.board, props.title);
  return <Handoff {...props} />;
}

/** Tells Merv.app which board is open, where the person is looking and what they selected, so the
 *  agents it lends the board to know what "this board" and "this" mean (board_here on the Mac). */
function useHere(api: ExcalidrawImperativeAPI, board: string, title: string) {
  const { state, selected: chosen } = useBoardView(api);
  useEffect(() => {
    const here = (window as { mervApp?: { here?(state: unknown): void } }).mervApp?.here;
    if (!here) return;
    const zoom = state.zoom.value;
    const view = {
      x: Math.round(-state.scrollX),
      y: Math.round(-state.scrollY),
      width: Math.round(state.width / zoom),
      height: Math.round(state.height / zoom),
    };
    const selected = chosen.slice(0, 50).map((el) => el.id);
    const timer = setTimeout(() => here({ board, title, view, selected }), 400);
    return () => clearTimeout(timer);
  }, [
    state.scrollX,
    state.scrollY,
    state.zoom.value,
    state.width,
    state.height,
    chosen,
    board,
    title,
  ]);
}

type Retry = { id: string; board: string; words: string; shapes?: string[] };
type Failure = PromptFailure | { reason: 'refused'; detail?: string };
type MervApp = {
  handoff?(offer: unknown): Promise<{ id: string } | undefined>;
  handoffDrop?(id: string): void;
  handoffFailed?(id: string, failure: Failure): void;
  onHandoffRetry?(heard: (retry: Retry) => void): () => void;
};
/** How long the board follows Merv's turn on a hand-off: the Mac's own offer lasts as long. */
const [TURN_MS, TURN_POLL_MS] = [150_000, 2000];
const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const mervApp = () => (window as { mervApp?: MervApp }).mervApp;

/** The selection as the person sees it, for the Mac to show at once: a JPEG of the shapes in the
 *  region on the board's own paper, the ids of what it holds, and the first line of each text in it. */
async function selectionOffer(
  api: ExcalidrawImperativeAPI,
  board: string,
  title: string,
  root: Region,
  words: string,
) {
  const inside = api
    .getSceneElements()
    .filter(
      (el) =>
        !el.isDeleted &&
        el.x < root.x + root.width &&
        el.x + el.width > root.x &&
        el.y < root.y + root.height &&
        el.y + el.height > root.y,
    );
  if (!inside.length) return undefined;
  const { viewBackgroundColor, theme } = api.getAppState();
  const blob = await exportBoardSnapshot({
    elements: inside,
    appState: { exportBackground: true, viewBackgroundColor, exportWithDarkMode: theme === 'dark' },
    files: api.getFiles(),
    mimeType: 'image/jpeg',
    quality: 0.85,
    maxWidthOrHeight: 1400,
    exportPadding: 16,
  }).catch(() => undefined);
  if (!blob) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  const picture = `data:image/jpeg;base64,${btoa(binary)}`;
  if (picture.length > 2_600_000) return undefined;
  const concepts = [
    ...new Set(
      inside.flatMap((el) =>
        'text' in el && typeof el.text === 'string' && el.text.trim()
          ? [el.text.trim().split('\n')[0]!.slice(0, 80)]
          : [],
      ),
    ),
  ].slice(0, 8);
  return {
    board,
    title: title.slice(0, 200),
    region: root,
    shapes: inside.slice(0, 200).map((el) => el.id),
    words: words.slice(0, 8000),
    picture,
    concepts,
  };
}

function Handoff({
  api,
  board,
  title,
}: {
  api: ExcalidrawImperativeAPI;
  board: string;
  title: string;
}) {
  const pi = useAgent()?.pi;
  const { selected: chosenNow, moving } = useBoardView(api);
  const [swept, setSwept] = useState(false);
  const [mark, setMark] = useState<Pt | null>(null);
  const [field, setField] = useState<Region | null>(null);
  useBackCloses(!!field && !mervApp(), () => setField(null));
  const picked = useRef<Region | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [asks, setAsks] = useState<Ask[]>([]);
  const answered = useRef(new Set<string>());
  const moment = useMoment(api);

  // The overlay follows the board as it pans and zooms; a selection at rest offers the mark, when it
  // was swept as an area or holds more than one thing: clicking a single shape is not sending it.
  useEffect(() => {
    const down = api.onPointerDown((tool, pointer) => {
      setSwept(tool.type === 'selection' && !pointer.hit.element);
    });
    return down;
  }, [api]);
  // A proposal's own keep and dismiss stand there instead.
  // A card or a group is one thing: its outermost group names it.
  const things = new Set(chosenNow.map((el) => el.groupIds.at(-1) ?? el.id)).size;
  const offered =
    (swept || things > 1) &&
    chosenNow.length &&
    !moving &&
    !chosenNow.every((el) => el.customData?.proposed);
  const [x1, y1, x2] = offered ? getCommonBounds(chosenNow) : [0, 0, 0];
  const selection = offered ? `${chosenNow.map((el) => el.id).join()}@${x1},${y1},${x2}` : '';
  useEffect(() => {
    setMark(null);
    if (!chosenNow.length) setField(null);
    if (offered) {
      const [, , , y2] = getCommonBounds(chosenNow);
      picked.current = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      const timer = setTimeout(() => setMark({ x: x2, y: y1 }), REST_MS);
      return () => clearTimeout(timer);
    }
  }, [selection]);

  // An agent's own look at the board is its snapshot: the moment plays where it looked.
  useEffect(() => {
    const hear = ({ region }: { region: Region }) => moment.play(region);
    agentLooks.add(hear);
    return () => void agentLooks.delete(hear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The questions the desk's units wait on, beside the work they are about.
  useEffect(() => {
    if (!mervApp()) return;
    let over = false;
    const look = async () => {
      if (document.hidden) return;
      const got = await accountRequest<{ asks: Ask[] }>(
        `/desk/handoffs?board=${encodeURIComponent(board)}`,
        { scoped: true },
      ).catch(() => null);
      if (over || !got) return;
      const open = new Set(got.asks.map(keyOf));
      for (const key of answered.current) if (!open.has(key)) answered.current.delete(key);
      setAsks((was) => (JSON.stringify(was) === JSON.stringify(got.asks) ? was : got.asks));
    };
    void look();
    const timer = setInterval(() => void look(), POLL_MS);
    return () => {
      over = true;
      clearInterval(timer);
    };
  }, [board]);

  // Merv's turn on a hand-off is followed to its end: one that sent no unit for this board leaves the
  // card nothing to wait for, so the Mac is told why and the card says so (handoff-turn.ts).
  const follow = async (
    commandId: string,
    running: string | null | undefined,
    handed: Promise<string | undefined>,
  ) => {
    const conversation = pi?.selected;
    if (!pi || !conversation) return;
    const until = Date.now() + TURN_MS;
    let outcome: PromptFailure | null | undefined;
    while (outcome === undefined && Date.now() < until) {
      await wait(TURN_POLL_MS);
      const snapshot = await pi.transport.snapshot(conversation).catch(() => null);
      if (snapshot) outcome = promptOutcome(answeringTurn(snapshot, commandId, running), board);
    }
    const id = outcome && (await handed);
    if (outcome && id) mervApp()?.handoffFailed?.(id, outcome);
  };
  // Asked again from the card: the same words go to Merv once more, from this board only.
  const ask = useRef<(retry: Retry) => void>(() => {});
  ask.current = (retry) => {
    const app = mervApp();
    if (retry.board !== board)
      return app?.handoffFailed?.(retry.id, {
        reason: 'refused',
        detail: 'Open the board it was sent from to ask Merv again.',
      });
    const commandId = newId();
    const running = pi?.snapshot?.conversation.activeCommandId;
    const again = `${retry.words ? `Execute this: ${retry.words}` : 'Execute this.'}\n\n[hand-off again: no task prompt reached my Mac last time${retry.shapes?.length ? `; the selection was ${retry.shapes.slice(0, 200).join(',')}` : ''}]`;
    void (pi?.send(again, commandId) ?? Promise.resolve(false)).then((sent) => {
      if (!sent)
        return app?.handoffFailed?.(retry.id, {
          reason: 'refused',
          detail: 'Merv could not be reached.',
        });
      void follow(commandId, running, Promise.resolve(retry.id));
    });
  };
  useEffect(() => mervApp()?.onHandoffRetry?.((retry) => ask.current(retry)), []);

  const client = (p: Pt) =>
    sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, api.getAppState());
  // The picture is taken as the person sees it the moment they press Enter, and the words go to
  // Merv; once Merv has them, the picture and words are seen to go to the panel together, and the
  // Mac is handed the selection as that parcel lands there, so the card opens in step with it.
  // Refused, the words stay in the field for another try and nothing is handed over.
  const send = async () => {
    const said = text.trim();
    const from = input.current?.getBoundingClientRect();
    const app = mervApp();
    const root = field;
    const offer =
      app && root
        ? selectionOffer(api, board, title, root, said).catch(() => undefined)
        : undefined;
    const commandId = newId();
    const running = pi?.snapshot?.conversation.activeCommandId;
    // Order appearance before the task can freeze its server-rendered attachment.
    await call('board.scene', { id: board, since: Number.MAX_SAFE_INTEGER, appearance: worn() });
    const words = said ? `Execute this: ${said}` : 'Execute this.';
    // Without the Mac, the work would run on cloud machines: it waits in Merv's panel for the
    // person's Approve, and only then is it asked of the Agent (board-app/held.ts).
    if (!app) {
      const picture = root
        ? await selectionOffer(api, board, title, root, said).then(
            (made) => made?.picture,
            () => undefined,
          )
        : undefined;
      hold({
        id: commandId,
        board,
        title,
        words: said,
        shapes: chosenNow.map((shape) => shape.id),
        ...(picture && { picture }),
      });
      setField(null);
      setMark(null);
      setText('');
      return;
    }
    if (!(await pi?.send(words, commandId))) return;
    let handed: (id: string | undefined) => void = () => {};
    if (app) void follow(commandId, running, new Promise((done) => (handed = done)));
    const landed = () =>
      void offer
        ?.then((made) => made && app?.handoff?.(made))
        .then(
          (got) => handed(got?.id),
          () => handed(undefined),
        );
    if (root && from)
      moment.send(
        root,
        said || 'Execute this',
        from,
        landed,
        offer?.then((made) => made?.picture),
      );
    else landed();
    setField(null);
    setMark(null);
    setText('');
  };
  // One question per unit at a time, beside the work it is about.
  const shown = asks.filter(
    (ask, index) =>
      !answered.current.has(keyOf(ask)) &&
      asks.findIndex((other) => other.unit === ask.unit && !answered.current.has(keyOf(other))) ===
        index,
  );
  const at = mark && !field && !moment.busy && client(mark);
  // The composer stands under what it is about, or over it when there is no room below.
  const typing =
    field &&
    (() => {
      const [a, b] = [
        client({ x: field.x, y: field.y }),
        client({ x: field.x + field.width, y: field.y + field.height }),
      ];
      const below = b.y + 14 + 52 < innerHeight;
      return { x: (a.x + b.x) / 2 - 180, y: below ? b.y + 14 : Math.max(56, a.y - 14 - 44) };
    })();
  // Both stay on the visible canvas, clear of the sessions panel over its right edge.
  const onCanvas = (p: Pt, width: number) => {
    const panel =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--desk-panel-width'),
      ) || 0;
    return {
      left: Math.max(8, Math.min(p.x + 8, innerWidth - panel - width)),
      top: Math.max(56, Math.min(p.y, innerHeight - 48)),
    };
  };
  return (
    <div className="handoff-layer">
      {moment.view}
      {at && (
        <button
          type="button"
          className="handoff-mark"
          style={onCanvas(at, 60)}
          aria-label="Hand this to an agent"
          title="Hand this to an agent"
          onClick={() => setField(picked.current)}
        >
          <Arrow fill="currentColor" />
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 6h8M7 3l3 3-3 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {typing && (
        <input
          ref={input}
          className="handoff-field"
          style={{
            ...onCanvas(typing, Math.min(376, innerWidth - 16)),
            boxSizing: 'border-box',
            width: 'min(368px, calc(100vw - 32px))',
          }}
          autoFocus
          aria-label="What to do with this"
          placeholder="Execute this…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              send();
            }
            if (event.key === 'Escape') setField(null);
          }}
        />
      )}
      {shown.map((ask) => {
        const p = ask.root
          ? client({ x: ask.root.x + ask.root.width + 16, y: ask.root.y })
          : { x: innerWidth - 380, y: 80 };
        const left = Math.max(8, Math.min(p.x, innerWidth - 372));
        const top = Math.max(56, Math.min(p.y, innerHeight - 160));
        return (
          <div
            key={keyOf(ask)}
            className="handoff-cursor is-arriving"
            style={{ maxWidth: 'calc(100vw - 16px)', transform: `translate(${left}px, ${top}px)` }}
          >
            <Cursor provider={ask.provider} />
            <Question
              ask={ask}
              done={() => {
                answered.current.add(keyOf(ask));
                setAsks((asks) => asks.filter((item) => keyOf(item) !== keyOf(ask)));
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** An approval as one plain question: the agent's own reason when it gave one, else what it wants to
 *  do, cut to a line. The command and folder stay in the thread. */
const asked = ({ title, detail }: { title: string; detail?: string }) => {
  const reason = detail?.split('\n')[0]?.trim();
  const said = reason && !reason.startsWith('in /') ? reason : title;
  return said.length > 90 ? `${said.slice(0, 89)}…` : said;
};

/** One open request, its questions one at a time, sent together once the last is answered. */
function Question({ ask, done }: { ask: Ask; done(): void }) {
  const voice = useAgent()?.voice;
  const { request } = ask;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const approval = !['question', 'elicitation'].includes(request.kind);
  const questions = request.questions?.length
    ? request.questions
    : [
        {
          id: 'answer',
          question: request.title,
          options: (request.options ?? []).map((label) => ({ label })),
          isSecret: false,
        },
      ];
  const now = questions[Math.min(step, questions.length - 1)]!;
  const decide = async (decision: Decision) => {
    setBusy(true);
    setProblem('');
    try {
      await accountRequest('/desk/decision', {
        method: 'POST',
        scoped: true,
        body: {
          device: ask.device,
          thread: ask.thread,
          request: request.id,
          generation: ask.generation,
          decision,
        },
      });
      done();
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  const answer = (value: string | string[]) => {
    const values = [value].flat();
    if (busy || !values.length) return;
    if (approval) return void decide({ kind: value === 'allow' ? 'allow' : 'deny' });
    const all = { ...answers, [now.id]: values };
    if (step + 1 < questions.length) {
      setAnswers(all);
      return setStep(step + 1);
    }
    void decide(
      request.questions?.length
        ? { kind: 'answer', answers: all }
        : { kind: 'answer', text: values.join(', ') },
    );
  };
  return (
    <AskCard
      key={step}
      provider={ask.provider}
      question={approval ? asked(request) : now.question}
      options={now.options.map((option) => option.label)}
      kind={approval ? 'approval' : now.options.length ? 'choice' : 'text'}
      multi={'multiSelect' in now && !!now.multiSelect}
      step={questions.length > 1 ? `${step + 1}/${questions.length}` : undefined}
      secret={now.isSecret}
      busy={busy}
      problem={problem}
      onAnswer={answer}
      onTalk={() => {
        if (voice?.state === 'off') voice.start();
        else if (voice?.muted) voice.mute();
      }}
    />
  );
}

/** An agent's question on the canvas: choices, a free answer, Allow and Deny for an approval, and a
 *  mic that brings Merv in to talk it through. */
export function AskCard(props: {
  provider: Provider;
  question: string;
  options?: string[];
  kind: 'choice' | 'text' | 'approval';
  step?: string;
  secret?: boolean;
  /** Several choices count: they toggle, and the arrow sends them. */
  multi?: boolean;
  busy?: boolean;
  problem?: string;
  onAnswer(value: string | string[]): void;
  onTalk(): void;
}) {
  const [typed, setTyped] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const pick = (value: string) => {
    if (props.multi)
      return setChosen((now) =>
        now.includes(value) ? now.filter((one) => one !== value) : [...now, value],
      );
    setChosen([value]);
    props.onAnswer(value);
  };
  return (
    <div
      className="handoff-card"
      style={{ boxSizing: 'border-box', maxWidth: 'calc(100vw - 40px)' }}
      role="dialog"
      aria-label={`${nameOf(props.provider)} asks: ${props.question}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="handoff-ask">
        {props.question}
        {props.step && <small>{props.step}</small>}
      </p>
      {props.kind === 'choice' && (
        <div className="handoff-choices">
          {props.options?.map((option) => (
            <button
              key={option}
              type="button"
              disabled={props.busy}
              className={chosen.includes(option) ? 'is-on' : ''}
              onClick={() => pick(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="handoff-row">
        <button
          type="button"
          className="handoff-quiet"
          aria-label="Talk it through with Merv"
          title="Talk it through with Merv"
          onClick={props.onTalk}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect
              x="5"
              y="1.5"
              width="4"
              height="7"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M3 6.5a4 4 0 0 0 8 0M7 10.5v2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {props.kind === 'approval' ? (
          <span className="handoff-row-end">
            <button
              type="button"
              className="handoff-quiet"
              disabled={props.busy}
              onClick={() => props.onAnswer('deny')}
            >
              Deny
            </button>
            <button
              type="button"
              className="handoff-primary"
              disabled={props.busy}
              onClick={() => props.onAnswer('allow')}
            >
              Allow
            </button>
          </span>
        ) : (
          <input
            key={props.question}
            autoFocus={props.kind === 'text'}
            disabled={props.busy}
            type={props.secret ? 'password' : 'text'}
            aria-label="Your answer"
            placeholder={props.kind === 'choice' ? '…or say it' : 'Your answer'}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(typed.trim() || (props.multi && chosen.length)))
                return;
              if (props.multi) props.onAnswer([...chosen, ...(typed.trim() ? [typed.trim()] : [])]);
              else pick(typed.trim());
              setTyped('');
            }}
          />
        )}
        {props.multi && props.kind === 'choice' && (
          <button
            type="button"
            className="handoff-primary"
            aria-label="Send"
            title="Send"
            disabled={props.busy || !chosen.length}
            onClick={() => props.onAnswer(chosen)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 7h8M7.5 3.5 11 7l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      {props.problem && (
        <p className="handoff-problem" role="alert">
          {props.problem}
        </p>
      )}
    </div>
  );
}

/** The agent's cursor: the arrow, and its mark and name beside it. */
function Cursor({ provider }: { provider: Provider }) {
  return (
    <>
      <Arrow className="handoff-arrow" fill={provider === 'claude' ? '#d97757' : '#5b6cff'} />
      <span className={`handoff-name is-${provider}`}>
        <ProviderMark provider={provider} size={12} />
        {nameOf(provider)}
      </span>
    </>
  );
}

function Arrow({ className, fill }: { className?: string; fill: string }) {
  return (
    <svg className={className} width="16" height="18" viewBox="0 0 18 20" aria-hidden="true">
      <path
        d="M1.5 1.5 16 9.2l-6.4 1.6-3.1 6.4z"
        fill={fill}
        stroke="#fff"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Rect = { x1: number; y1: number; x2: number; y2: number };
type Parcel = {
  text: string;
  url?: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  lift: number;
};
type Ghost = {
  url?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  opacity: number;
};

/**
 * The snapshot, seen: the agent comes in from the panel's side, Merv comes down from the orb and
 * hands it what they were discussing, the agent marquees the region, a flash, and the region's
 * ghost goes off right toward the panel. Client-only: nothing is saved, nothing stays.
 */
function useMoment(api: ExcalidrawImperativeAPI) {
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [flash, setFlash] = useState(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [parcel, setParcel] = useState<Parcel | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const queue = useRef(Promise.resolve());
  useEffect(() => () => void (live.current = false), []);

  const state = () => api.getAppState();
  const client = (p: Pt) => sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, state());
  const run = (ms: number, frame: (k: number) => void) =>
    new Promise<void>((done) => {
      // Reduced motion runs every step at once: the end state, no frames.
      if (ms <= 0) {
        frame(1);
        return done();
      }
      const start = performance.now();
      const step = (now: number) => {
        if (!live.current) return done();
        const t = Math.min(1, (now - start) / ms);
        frame(t);
        if (t < 1) window.requestAnimationFrame(step);
        else done();
      };
      window.requestAnimationFrame(step);
    });

  const picture = (root: Region) =>
    selectionOffer(api, '', '', root, '').then((offer) => offer?.picture);
  const flashBox = async (
    root: Region,
    pad: number,
    sweep: number,
    flash: number,
    still: number,
  ) => {
    pad /= state().zoom.value;
    const r = {
      x1: root.x - pad,
      y1: root.y - pad,
      x2: root.x + root.width + pad,
      y2: root.y + root.height + pad,
    };
    await run(calm() ? 0 : sweep, (t) =>
      setMarquee({ ...r, x2: r.x1 + (r.x2 - r.x1) * ease(t), y2: r.y1 + (r.y2 - r.y1) * ease(t) }),
    );
    setFlash(true);
    await wait(calm() ? still : flash);
    setFlash(false);
    setMarquee(null);
    return r;
  };

  const carry = async (
    r: Rect,
    url: string | undefined,
    ms: number,
    destination: (a: Pt, w: number, h: number) => Pt,
    scale: (w: number, h: number) => number,
    curve: (t: number) => number,
    opacity: (t: number) => number,
  ) => {
    const [a, b] = [client({ x: r.x1, y: r.y1 }), client({ x: r.x2, y: r.y2 })];
    const [w, h] = [b.x - a.x, b.y - a.y],
      to = destination(a, w, h);
    await run(ms, (t) => {
      const k = curve(t);
      setGhost({
        url,
        x: a.x + (to.x - a.x) * k,
        y: a.y + (to.y - a.y) * k,
        w,
        h,
        scale: 1 + (scale(w, h) - 1) * k,
        opacity: opacity(t),
      });
    });
    setGhost(null);
  };

  /** Where the agent looked: its box drawn over what it saw, the flash of the picture, and the picture
   *  carried off toward its chat. The agent's own cursor is the board's (board-presence). */
  const play = async (root: Region) => {
    setBusy(true);
    const shot = picture(root);
    const r = await flashBox(root, 18, 700, 180, 600);
    const url = await shot;
    if (!calm()) {
      await carry(
        r,
        url,
        950,
        (a, _w, h) => ({ x: state().offsetLeft + state().width + 24, y: a.y + h * 0.15 }),
        () => 0.3,
        (t) => t * t * (3 - 2 * t),
        (t) => 0.9 - 0.75 * Math.max(0, (t - 0.55) / 0.45),
      );
    }
    setBusy(false);
  };

  /** What the person sent: the field's words lift, the agent's box takes in the selection, its
   *  picture joins the words, and the two arc into the agent's chat together; `landed` is called
   *  as they arrive there, so what waits on the other side can appear in step. */
  const send = async (
    root: Region,
    text: string,
    from: DOMRect,
    landed?: () => void,
    shot = picture(root),
  ) => {
    setBusy(true);
    const lifted = { text, x: from.left, y: from.top, scale: 1, opacity: 1, lift: 0 };
    setParcel(lifted);
    await run(calm() ? 0 : 260, (t) => setParcel({ ...lifted, lift: ease(t) }));
    const r = await flashBox(root, 14, 380, 140, 300);
    const url = await shot;
    if (!calm()) {
      // The picture comes down into the parcel, ahead of the words.
      await carry(
        r,
        url,
        420,
        () => ({ x: from.left + 6, y: from.top + 4 }),
        (w, h) => 32 / Math.max(w, h),
        ease,
        () => 0.95,
      );
      // Together along an arc to the chat: the panel's composer when it is open, else the island.
      const panel =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--desk-panel-width'),
        ) || 0;
      const to = panel
        ? { x: innerWidth - panel + 32, y: innerHeight - 96 }
        : { x: innerWidth - 120, y: 22 };
      const lift = { x: (from.left + to.x) / 2, y: Math.min(from.top, to.y) - 120 };
      let arrived = false;
      await run(780, (t) => {
        const k = ease(t),
          u = 1 - k;
        setParcel({
          text,
          url,
          x: u * u * from.left + 2 * u * k * lift.x + k * k * to.x,
          y: u * u * from.top + 2 * u * k * lift.y + k * k * to.y,
          scale: 1 - 0.55 * k,
          opacity: t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2,
          lift: 1,
        });
        // It is there as it starts to fade: the card on the other side takes over from it.
        if (t >= 0.8 && !arrived) {
          arrived = true;
          landed?.();
        }
      });
      if (!arrived) landed?.();
    } else landed?.();
    setParcel(null);
    setBusy(false);
  };

  const box = (r: Rect) => {
    const [a, b] = [
      client({ x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2) }),
      client({ x: Math.max(r.x1, r.x2), y: Math.max(r.y1, r.y2) }),
    ];
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  return {
    busy,
    play: (root: Region) =>
      void (queue.current = queue.current.then(() => play(root)).catch(() => setBusy(false))),
    send: (
      root: Region,
      text: string,
      from: DOMRect,
      landed?: () => void,
      shot?: Promise<string | undefined>,
    ) =>
      void (queue.current = queue.current
        .then(() => send(root, text, from, landed, shot))
        .catch(() => {
          setBusy(false);
          landed?.();
        })),
    view: (
      <>
        {marquee && (
          <div className={`handoff-marquee${flash ? ' is-flash' : ''}`} style={box(marquee)} />
        )}
        {ghost && (
          <div
            className="handoff-ghost"
            style={{
              left: ghost.x,
              top: ghost.y,
              width: ghost.w,
              height: ghost.h,
              opacity: ghost.opacity,
              transform: `scale(${ghost.scale})`,
            }}
          >
            {ghost.url && <img src={ghost.url} alt="" />}
          </div>
        )}
        {parcel && (
          <div
            className="handoff-parcel"
            style={{
              transform: `translate(${parcel.x}px, ${parcel.y - 6 * parcel.lift}px) scale(${parcel.scale})`,
              opacity: parcel.opacity,
              boxShadow: `0 ${4 + 14 * parcel.lift}px ${12 + 22 * parcel.lift}px #000a`,
            }}
          >
            {parcel.url && <img src={parcel.url} alt="" />}
            <span>{parcel.text}</span>
          </div>
        )}
      </>
    ),
  };
}
