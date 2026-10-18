import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { AgentStreamEvent } from '@merv/sessions/agent-stream';
import type { ThreadConversation, ThreadView, VisitView } from '@merv/sessions/models';
import type { ProcessGraph } from '@merv/workflows/models';
import { NO_TIMELINE, mergeEvents, useAgentStream, type AgentBlock } from '../agent-stream';
import { cx, useNow } from '../components';
import { capital, duration, elapsed, words } from '../liveness';
import {
  axisOf,
  chipText,
  momentsOf,
  selected,
  stageSpans,
  tally,
  type Kind,
  type Lane,
  type Moment,
  type Selection,
  type StageSpan,
} from '../trajectory';
import { StepBody } from './agent-live';
import { readParts } from './threads';

/**
 * A record's trajectory: what its agents did, across every stage, on one line of time. The
 * stages run along the top; under them one lane a session, its moments as ticks coloured by
 * kind (a message, a thought, a web search, a read, an edit, a command, a job, a Merv call), a
 * failure a red cap on its tick; the waits between sessions are folded to a break. Under the
 * lanes, chips say what the part in hand comes to, and the part in hand is the whole, a brushed
 * stretch, a stage or a session. Hovering a tick names it and lights every tick on the same
 * thing; a press opens its raw input and output, and only there is any text drawn.
 */

const LABEL_W = 156;
const ROW_H = 24;
const HEAD_H = 36;
const AXIS_H = 22;
const PAD_R = 12;
const MANY = 200;

/** The width the element has, kept current as the page is resized. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    // A document without ResizeObserver (a test's) keeps the width it was measured at.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Every kept visit's events, read thread by thread, part after part, and read again when a
 * visit ends (its stream becomes a kept one). The live visit's blocks come from its stream.
 */
function useKeptBlocks(threads: readonly ThreadView[]) {
  const [kept, setKept] = useState(new Map<string, AgentBlock[]>());
  const key = threads
    .map(
      (thread) =>
        `${thread.id}:${thread.visits.find((visit) => visit.status === 'active')?.sessionId ?? ''}`,
    )
    .join(',');
  useEffect(() => {
    const events = new Map<string, AgentStreamEvent[]>();
    const stops = threads.map((thread) =>
      readParts(
        `/sessions/threads/${encodeURIComponent(thread.id)}/conversation`,
        undefined,
        (part: ThreadConversation) => {
          for (const visit of part.visits)
            if (visit.events.length)
              events.set(visit.sessionId, [
                ...(events.get(visit.sessionId) ?? []),
                ...visit.events,
              ]);
          setKept(
            new Map([...events].map(([id, list]) => [id, mergeEvents(NO_TIMELINE, list).blocks])),
          );
        },
      ),
    );
    return () => stops.forEach((stop) => stop());
    // Read anew only when a thread joins or a visit's liveness changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return kept;
}

/** One live visit's stream, handed up as blocks; it draws nothing itself. */
function LiveBlocks({
  sessionId,
  onBlocks,
}: {
  sessionId: string;
  onBlocks(sessionId: string, blocks: AgentBlock[]): void;
}) {
  const { timeline } = useAgentStream(`/sessions/${encodeURIComponent(sessionId)}/events`);
  useEffect(() => onBlocks(sessionId, timeline.blocks), [sessionId, timeline.blocks, onBlocks]);
  return null;
}

const ended = (visit: VisitView) => visit.status === 'released' || visit.status === 'expired';
const stageTone = (state: string, live: boolean) =>
  live ? 'live' : /review/.test(state) ? 'review' : 'work';
const clockOf = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Trajectory({
  graph,
  threads,
  onOpen,
}: {
  graph: ProcessGraph;
  threads: readonly ThreadView[];
  /** Opens a thread's conversation. */
  onOpen(threadId: string): void;
}) {
  const kept = useKeptBlocks(threads);
  const [live, setLive] = useState(new Map<string, AgentBlock[]>());
  const onBlocks = (sessionId: string, blocks: AgentBlock[]) =>
    setLive((was) => (was.get(sessionId) === blocks ? was : new Map(was).set(sessionId, blocks)));
  const anyLive = threads.some((thread) =>
    thread.visits.some((visit) => visit.status === 'active'),
  );
  const tick = useNow(anyLive ? 15_000 : 3_600_000);
  const now = anyLive ? tick : Date.now();
  const lanes = useMemo<Lane[]>(
    () =>
      threads
        .flatMap((thread) =>
          thread.visits
            .filter((visit) => !visit.inquiry)
            .map((visit): Lane => {
              const isLive = visit.status === 'active';
              const blocks = (isLive ? live : kept).get(visit.sessionId) ?? [];
              const start = Date.parse(visit.startedAt ?? visit.offeredAt);
              const moments = momentsOf(
                visit.sessionId,
                blocks,
                now,
                visit.endedAt ? { start, end: Date.parse(visit.endedAt) } : undefined,
              );
              const last = moments.at(-1)?.until ?? start;
              return {
                sessionId: visit.sessionId,
                threadId: thread.id,
                role: thread.role,
                stage: visit.state ?? thread.state,
                ...(visit.harness && { harness: visit.harness }),
                start,
                end: visit.endedAt
                  ? Date.parse(visit.endedAt)
                  : isLive
                    ? now
                    : Math.max(last, start),
                live: isLive,
                failed: !visit.launched && ended(visit),
                moments,
              };
            }),
        )
        .sort((a, b) => a.start - b.start),
    [threads, kept, live, now],
  );
  const spans = useMemo(() => stageSpans(lanes), [lanes]);
  const order = useMemo(() => spans.flatMap((span) => span.lanes), [spans]);
  const [frame, width] = useWidth<HTMLDivElement>();
  const axisWidth = Math.max(0, width - LABEL_W - PAD_R);
  const axis = useMemo(() => axisOf(lanes, axisWidth), [lanes, axisWidth]);
  const X = (t: number) => LABEL_W + axis.x(t);
  const height = HEAD_H + order.length * ROW_H + AXIS_H;

  const [selection, setSelection] = useState<Selection>();
  const [focus, setFocus] = useState<Kind>();
  const [listKind, setListKind] = useState<Kind>();
  const [picked, setPicked] = useState<string>();
  const [hover, setHover] = useState<{ moment: Moment; x: number; y: number }>();
  const [brush, setBrush] = useState<{ x0: number; x1: number }>();
  const all = useMemo(() => order.flatMap((lane) => lane.moments), [order]);
  const inHand = useMemo(
    () => all.filter((moment) => selected(moment, selection, spans)),
    [all, selection, spans],
  );
  const tallies = useMemo(() => tally(inHand), [inHand]);
  const pickedMoment = all.find((moment) => moment.key === picked);
  const lit = (moment: Moment) =>
    (!focus || moment.kind === focus) &&
    (!hover?.moment.topic || hover.moment.topic === moment.topic) &&
    selected(moment, selection, spans);

  // A drag across the lanes brushes a stretch of time; a plain press clears the part in hand.
  const dragging = useRef<{ x0: number; moved: boolean }>();
  const svgX = (event: ReactPointerEvent) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left - LABEL_W;
  const onDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-pick]')) return;
    const x0 = Math.min(Math.max(svgX(event), 0), axisWidth);
    dragging.current = { x0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    const x1 = Math.min(Math.max(svgX(event), 0), axisWidth);
    if (Math.abs(x1 - drag.x0) >= 4) drag.moved = true;
    if (drag.moved) setBrush({ x0: Math.min(drag.x0, x1), x1: Math.max(drag.x0, x1) });
  };
  const onUp = () => {
    const drag = dragging.current;
    dragging.current = undefined;
    if (!drag) return;
    if (drag.moved && brush) setSelection({ range: [axis.t(brush.x0), axis.t(brush.x1)] });
    else {
      setSelection(undefined);
      setPicked(undefined);
    }
    setBrush(undefined);
  };
  const choose = (next: Selection) => {
    setSelection(next);
    setPicked(undefined);
  };

  if (!threads.length) return <p className="faint">No agent has worked this yet.</p>;
  const activeMs = axis.segments.reduce((sum, segment) => sum + (segment.t1 - segment.t0), 0);
  const inHandText = !selection
    ? `${duration(activeMs)} of agent time`
    : 'range' in selection
      ? `${clockOf(selection.range[0])} – ${clockOf(selection.range[1])}`
      : 'session' in selection
        ? `One session · ${duration(laneOf(order, selection.session)?.end ?? 0 - (laneOf(order, selection.session)?.start ?? 0))}`
        : `${capital(words(spans[selection.stage]!.state))} · ${duration(spans[selection.stage]!.end - spans[selection.stage]!.start)}`;
  const listed = listKind ? inHand.filter((moment) => moment.kind === listKind) : inHand;
  const showList = !pickedMoment && (!!selection || !!listKind);
  return (
    <div className="traj" ref={frame}>
      {threads.flatMap((thread) =>
        thread.visits
          .filter((visit) => visit.status === 'active')
          .map((visit) => (
            <LiveBlocks key={visit.sessionId} sessionId={visit.sessionId} onBlocks={onBlocks} />
          )),
      )}
      {width > 0 && (
        <svg
          className={cx('traj-svg', dragging.current && 'traj-svg--brushing')}
          width={width}
          height={height}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {spans.map((span, index) => {
            const x0 = X(span.start);
            const x1 = Math.max(X(span.end), x0 + 6);
            const w = x1 - x0;
            const on = selection && 'stage' in selection && selection.stage === index;
            const tone = stageTone(
              span.state,
              span.lanes.some((lane) => lane.live),
            );
            const label =
              w >= 140
                ? `${capital(words(span.state))} · ${duration(span.end - span.start)}`
                : w >= 56
                  ? capital(words(span.state))
                  : '';
            return (
              <g
                key={index}
                className={cx('traj-stage', `traj-stage--${tone}`, on && 'traj-stage--on')}
                data-pick=""
                onClick={() => choose(on ? undefined : { stage: index })}
              >
                <title>{`${capital(words(span.state))} · ${duration(span.end - span.start)} · ${span.lanes.length} session${span.lanes.length === 1 ? '' : 's'}`}</title>
                <rect x={x0} y={0} width={w} height={HEAD_H} />
                <line x1={x0 + 1} x2={x1 - 1} y1={HEAD_H - 6} y2={HEAD_H - 6} />
                <text x={x0 + 1} y={15}>
                  {label}
                </text>
              </g>
            );
          })}
          {axis.breaks.map((item, index) => (
            <g key={index} className="traj-fold">
              <line
                x1={LABEL_W + item.x}
                x2={LABEL_W + item.x}
                y1={HEAD_H - 2}
                y2={HEAD_H + order.length * ROW_H + 2}
              />
              <text x={LABEL_W + item.x} y={height - 6} textAnchor="middle">
                {elapsed(item.ms)}
              </text>
            </g>
          ))}
          {order.map((lane, row) => {
            const y = HEAD_H + row * ROW_H;
            const mid = y + ROW_H / 2;
            const on = selection && 'session' in selection && selection.session === lane.sessionId;
            return (
              <g key={lane.sessionId} className={cx('traj-lane', on && 'traj-lane--on')}>
                <g
                  className={cx('traj-who', `traj-who--${lane.role}`)}
                  data-pick=""
                  onClick={() => choose(on ? undefined : { session: lane.sessionId })}
                >
                  <title>{`${capital(words(lane.role))} · ${words(lane.stage)} · ${lane.harness ?? ''} · ${duration(lane.end - lane.start)}`}</title>
                  <rect x={0} y={y} width={LABEL_W - 8} height={ROW_H} />
                  <circle cx={10} cy={mid} r={7} />
                  <text x={10} y={mid + 3.5} textAnchor="middle" className="traj-letter">
                    {lane.role.charAt(0).toUpperCase()}
                  </text>
                  <text x={24} y={mid + 3.5} className="traj-when">
                    {lane.failed
                      ? `${capital(words(lane.stage))} · launch failed`
                      : `${capital(words(lane.stage))} · ${duration(lane.end - lane.start)}`}
                  </text>
                </g>
                <line
                  className={cx(
                    'traj-run',
                    lane.live && 'traj-run--live',
                    lane.failed && 'traj-run--failed',
                  )}
                  x1={X(lane.start)}
                  x2={Math.max(X(lane.end), X(lane.start) + 2)}
                  y1={mid}
                  y2={mid}
                />
                {lane.moments.map((moment) => {
                  const x = X(moment.at);
                  const w = Math.max(moment.kind === 'say' ? 1.5 : 2, X(moment.until) - x);
                  const inset = moment.kind === 'say' ? 4 : moment.kind === 'think' ? 9 : 7;
                  return (
                    <g
                      key={moment.key}
                      className={cx(
                        'traj-tick',
                        `traj-tick--${moment.kind}`,
                        !lit(moment) && 'traj-tick--dim',
                        picked === moment.key && 'traj-tick--picked',
                      )}
                      data-pick=""
                      onPointerEnter={() => setHover({ moment, x, y })}
                      onPointerLeave={() => setHover(undefined)}
                      onClick={() => {
                        setPicked(picked === moment.key ? undefined : moment.key);
                      }}
                    >
                      <rect x={x} y={y + inset} width={w} height={ROW_H - 2 * inset} rx={1} />
                      {moment.failed !== undefined && (
                        <rect
                          className="traj-fail"
                          x={x}
                          y={y + 4}
                          width={Math.max(w, 3)}
                          height={2}
                        />
                      )}
                      <rect
                        className="traj-hit"
                        x={x - 2}
                        y={y + 2}
                        width={w + 4}
                        height={ROW_H - 4}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {axis.ticks.map((item) => (
            <g key={item.x} className="traj-axis">
              <line
                x1={LABEL_W + item.x}
                x2={LABEL_W + item.x}
                y1={height - AXIS_H + 2}
                y2={height - AXIS_H + 6}
              />
              <text x={LABEL_W + item.x} y={height - 6} textAnchor="middle">
                {item.label}
              </text>
            </g>
          ))}
          {brush && (
            <rect
              className="traj-brush"
              x={LABEL_W + brush.x0}
              y={HEAD_H - 2}
              width={brush.x1 - brush.x0}
              height={order.length * ROW_H + 4}
            />
          )}
          {selection && 'range' in selection && !brush && (
            <rect
              className="traj-brush traj-brush--held"
              x={X(selection.range[0])}
              y={HEAD_H - 2}
              width={Math.max(2, X(selection.range[1]) - X(selection.range[0]))}
              height={order.length * ROW_H + 4}
            />
          )}
        </svg>
      )}
      {hover && (
        <div
          className="traj-tip"
          role="tooltip"
          style={{ left: Math.min(hover.x, Math.max(0, width - 320)), top: hover.y + ROW_H + 4 }}
        >
          <span className={`traj-dot traj-dot--${hover.moment.kind}`} />
          <span className="traj-tip-label">{hover.moment.label}</span>
          {hover.moment.summary && <span className="traj-tip-summary">{hover.moment.summary}</span>}
          <span className="traj-tip-when">
            {hover.moment.ordered ? 'placed by order' : clockOf(hover.moment.at)}
            {hover.moment.until - hover.moment.at >= 1000 &&
              ` · ${duration(hover.moment.until - hover.moment.at)}`}
          </span>
          {hover.moment.failed !== undefined && (
            <span className="traj-tip-failed">{hover.moment.failed || 'failed'}</span>
          )}
        </div>
      )}
      <div className="traj-chips" onMouseLeave={() => setFocus(undefined)}>
        <span className="traj-in-hand">
          {inHandText}
          {(selection || listKind) && (
            <button
              type="button"
              className="btn-text traj-clear"
              onClick={() => {
                choose(undefined);
                setListKind(undefined);
              }}
              aria-label="Show everything"
            >
              ×
            </button>
          )}
        </span>
        {tallies.map((item) => (
          <button
            type="button"
            key={item.kind}
            className={cx('traj-chip', listKind === item.kind && 'traj-chip--on')}
            onMouseEnter={() => setFocus(item.kind)}
            onFocus={() => setFocus(item.kind)}
            onClick={() => {
              setListKind(listKind === item.kind ? undefined : item.kind);
              setPicked(undefined);
            }}
            aria-pressed={listKind === item.kind}
          >
            <span className={`traj-dot traj-dot--${item.kind}`} />
            {chipText(item)}
          </button>
        ))}
      </div>
      {pickedMoment && (
        <Picked
          moment={pickedMoment}
          lane={laneOf(order, pickedMoment.sessionId)!}
          onOpen={onOpen}
          onClose={() => setPicked(undefined)}
        />
      )}
      {showList && (
        <MomentList
          moments={listed}
          lanes={order}
          onPick={setPicked}
          onOpen={onOpen}
          selection={selection}
        />
      )}
    </div>
  );
}

const laneOf = (lanes: readonly Lane[], sessionId: string) =>
  lanes.find((lane) => lane.sessionId === sessionId);

/** One moment opened: its line, then its raw input and output, as the conversation draws them. */
function Picked({
  moment,
  lane,
  onOpen,
  onClose,
}: {
  moment: Moment;
  lane: Lane;
  onOpen(threadId: string): void;
  onClose(): void;
}) {
  return (
    <section className="traj-picked" aria-label={moment.label}>
      <header className="traj-picked-head">
        <span className={`traj-dot traj-dot--${moment.kind}`} />
        <span className="traj-picked-label">{moment.label}</span>
        {moment.summary && <span className="traj-picked-summary">{moment.summary}</span>}
        <span className="faint tabular">
          {clockOf(moment.at)}
          {moment.until - moment.at >= 1000 && ` · ${duration(moment.until - moment.at)}`}
        </span>
        <span className="faint">
          {capital(words(lane.role))} · {words(lane.stage)}
        </span>
        <button type="button" className="btn-text" onClick={() => onOpen(lane.threadId)}>
          Open conversation
        </button>
        <button type="button" className="btn-text" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {moment.failed !== undefined && <p className="traj-picked-failed">{moment.failed}</p>}
      <StepBody block={moment.block} />
    </section>
  );
}

/** The moments in hand, one short line each, oldest first; a press opens one. */
function MomentList({
  moments,
  lanes,
  selection,
  onPick,
  onOpen,
}: {
  moments: readonly Moment[];
  lanes: readonly Lane[];
  selection: Selection;
  onPick(key: string): void;
  onOpen(threadId: string): void;
}) {
  const [shown, setShown] = useState(MANY);
  const lane = selection && 'session' in selection ? laneOf(lanes, selection.session) : undefined;
  return (
    <section className="traj-list" aria-label="Moments">
      {lane && (
        <header className="traj-picked-head">
          <span className="traj-picked-label">
            {capital(words(lane.role))} · {words(lane.stage)}
          </span>
          <span className="faint">
            {lane.harness} · {clockOf(lane.start)} · {duration(lane.end - lane.start)}
          </span>
          <button type="button" className="btn-text" onClick={() => onOpen(lane.threadId)}>
            Open conversation
          </button>
        </header>
      )}
      {!moments.length && <p className="faint">Nothing of that kind here.</p>}
      <ol>
        {moments.slice(0, shown).map((moment) => (
          <li key={moment.key}>
            <button type="button" className="traj-row" onClick={() => onPick(moment.key)}>
              <span className="traj-row-when tabular faint">{clockOf(moment.at)}</span>
              <span className={`traj-dot traj-dot--${moment.kind}`} />
              <span className="traj-row-label">{moment.label}</span>
              <span
                className={cx(
                  'traj-row-summary',
                  moment.failed !== undefined && 'traj-row-summary--failed',
                )}
              >
                {moment.failed !== undefined ? moment.failed || 'failed' : moment.summary}
              </span>
              {moment.until - moment.at >= 1000 && (
                <span className="traj-row-took tabular faint">
                  {duration(moment.until - moment.at)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {moments.length > shown && (
        <button type="button" className="btn-text" onClick={() => setShown(shown + MANY)}>
          {moments.length - shown} more
        </button>
      )}
    </section>
  );
}
