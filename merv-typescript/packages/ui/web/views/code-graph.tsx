import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CodeCommandRecord } from '@merv/contracts/code';
import type { CodePublication } from '@merv/contracts/types';
import { kindOf, toneOf, words } from '../components';

/**
 * Code, drawn rather than listed: the base branch as a trunk, one lane per
 * branch Merv made, one dot per checkpoint with its diffstat above it, and a
 * ring on the trunk where a reviewed proposal merged. Everything on it comes
 * from a receipt — a dot is a commit a runner reported, a lane is a record's
 * persistent workspace, a trunk dot is an oid some lane was cut from — and the
 * trunk runs on as a dash past the last point Merv can name, because the base
 * branch has history this process never read. A lane is named by the record
 * that owns it, so a lane no record names is left out and no generated ref
 * reaches the page. Plain SVG placed from one measured width and one time
 * scale: no canvas, no library, nothing draggable.
 */

/** A sealed proposal, in the fields the drawing uses. */
export interface GraphProposal {
  id: string;
  instanceId: string;
  summary: string;
  createdAt: string;
  receipt: {
    baseOid: string;
    headOid: string;
    stats: { filesChanged: number; insertions: number; deletions: number };
  };
}
export interface GraphInput {
  commands: CodeCommandRecord[];
  proposals: GraphProposal[];
  publications: CodePublication[];
  /** What the record that owns a branch is called, and how it stands. */
  nameOf(instanceId: string): { name: string; state: string } | undefined;
  /** Where a proposal's publication got to, so its lane says the same word its row does. */
  stateOf(proposalId: string): string;
  baseBranch: string | null;
}

export interface Lane {
  key: string;
  kind: string;
  word: string;
  name: string;
  state: string;
  tone: string;
  meta: string;
  y: number;
  path: string;
  merge: string | null;
  dots: { x: number; add: number; del: number; stat: boolean; tip: boolean; title: string }[];
}

const TRUNK_Y = 84;
const DAY = 86_400_000;
/** The elbow's radius, and the room a lane leaves after the point it was cut from. */
const ELBOW = 24;
const CUT = 40;
/** A diffstat is printed only where the next one is far enough away to read it. */
const STAT_GAP = 56;
const CHAR = 7.3;

const clip = (text: string, room: number) => {
  const most = Math.max(6, Math.floor(room / CHAR));
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
};
const stamp = (at: string) => new Date(at).getTime();
const dated = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
/** The tones the stylesheet already carries, reached through a compound state word. */
const tone = (state: string) => {
  const value = state.toLowerCase();
  const direct = toneOf(value);
  return direct !== 'neutral' ? direct : toneOf(value.split(/[ _]/).pop() ?? '');
};

/**
 * Time across the page, with a fixed share of the width given to order, so two
 * checkpoints a minute apart are still two dots. Monotone in time, so a date
 * placed through it lands where its own commits do.
 */
function scaleOf(times: number[], x0: number, x1: number) {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const last = sorted.length - 1;
  const span = x1 - x0;
  return (value: number) => {
    if (last <= 0) return x0 + span * 0.7;
    const t = Math.min(Math.max(value, sorted[0]!), sorted[last]!);
    const share = (t - sorted[0]!) / (sorted[last]! - sorted[0]!);
    let i = 0;
    while (i < last && sorted[i + 1]! <= t) i++;
    const [lo, hi] = [sorted[i]!, sorted[i + 1] ?? sorted[i]!];
    const within = hi > lo ? (t - lo) / (hi - lo) : 0;
    return x0 + span * (0.55 * share + (0.45 * (i + within)) / last);
  };
}

/** Everything the drawing needs about one branch, before it has a place. */
interface Raw {
  key: string;
  kind: string;
  word: string;
  name: string;
  state: string;
  meta: string;
  from: { lane: string; head: string } | { oid: string };
  events: { at: number; head: string; add: number; del: number; title: string }[];
  merged: { at: number; title: string } | null;
}

/**
 * The layout: pure, so what the graph says is exactly what some receipt says,
 * and null where there is nothing to draw.
 */
export function lanes(input: GraphInput, width: number) {
  const narrow = width < 620;
  const column = narrow ? 0 : Math.min(420, Math.round(width * 0.3));
  const x0 = narrow ? 8 : column + 40;
  const x1 = Math.max(x0 + 120, width - 60);
  const room = (narrow ? width : column) - 8;
  // One lane's own room, and the drop from the trunk to the first of them.
  const [row, drop] = narrow ? [104, 104] : [78, 84];

  // A checkpoint is a succeeded commit on a branch that outlives its session.
  const made = new Map<string, CodeCommandRecord[]>();
  for (const record of input.commands) {
    const space = record.command.workspace;
    if (!record.receipt || record.status !== 'succeeded') continue;
    if (space.mode !== 'persistent' || !space.branch) continue;
    const list = made.get(record.command.instanceId);
    if (list) list.push(record);
    else made.set(record.command.instanceId, [record]);
  }
  const raws: Raw[] = [];
  for (const [instanceId, records] of made) {
    const named = input.nameOf(instanceId);
    if (!named) continue;
    const order = records.sort((a, b) => stamp(a.command.createdAt) - stamp(b.command.createdAt));
    raws.push({
      key: instanceId,
      kind: 'experiments',
      word: kindOf('experiments').label,
      name: named.name,
      state: named.state,
      meta: `${order.length} checkpoint${order.length === 1 ? '' : 's'}`,
      from: { oid: order[0]!.receipt!.baseOid },
      events: order.map((record) => ({
        at: stamp(record.command.createdAt),
        head: record.receipt!.headOid,
        add: record.receipt!.stats.insertions,
        del: record.receipt!.stats.deletions,
        title: `${record.command.message} · ${record.receipt!.headOid}`,
      })),
      merged: null,
    });
  }
  raws.sort((a, b) => a.events[0]!.at - b.events[0]!.at);
  // A proposal is a lane of its own, directly under the experiment it was cut from.
  for (const proposal of input.proposals) {
    const published = input.publications.find((entry) => entry.proposalId === proposal.id);
    const commit = published?.merge?.commitSha ?? published?.pull?.mergeCommitSha ?? null;
    const parent = raws.findIndex((raw) => raw.key === proposal.instanceId);
    raws.splice(parent >= 0 ? parent + 1 : raws.length, 0, {
      key: proposal.id,
      kind: 'consolidation',
      word: 'Proposal',
      name: proposal.summary,
      state: input.stateOf(proposal.id),
      meta: '1 commit, pinned',
      from:
        parent >= 0
          ? { lane: raws[parent]!.key, head: proposal.receipt.headOid }
          : { oid: proposal.receipt.baseOid },
      events: [
        {
          at: stamp(proposal.createdAt),
          head: proposal.receipt.headOid,
          add: proposal.receipt.stats.insertions,
          del: proposal.receipt.stats.deletions,
          title: `${proposal.summary} · ${proposal.receipt.headOid}`,
        },
      ],
      merged: commit
        ? {
            at: stamp(
              published?.pull?.updatedAt ?? published?.merge?.requestedAt ?? proposal.createdAt,
            ),
            title: commit,
          }
        : null,
    });
  }
  if (!raws.length) return null;

  const x = scaleOf(
    raws.flatMap((raw) => [
      ...raw.events.map((event) => event.at),
      ...(raw.merged ? [raw.merged.at] : []),
    ]),
    x0,
    x1,
  );
  const marks: { x: number; ring: boolean; title: string }[] = [];
  const cut = new Map<string, number>();
  const placed: Lane[] = [];
  const points = new Map<string, { x: number; y: number }>();
  raws.forEach((raw, index) => {
    const y = TRUNK_Y + drop + index * row;
    const first = x(raw.events[0]!.at);
    const parent =
      'lane' in raw.from
        ? (points.get(`${raw.from.lane}:${raw.from.head}`) ??
          points.get(`${raw.from.lane}:tip`) ?? { x: Math.max(x0, first - CUT), y: TRUNK_Y })
        : { x: Math.max(x0, first - CUT), y: TRUNK_Y };
    // A lane starts clear of the point it was cut from, whatever the clock says.
    const shift = Math.max(0, parent.x + CUT - first);
    let printed = -Infinity;
    const dots: Lane['dots'] = raw.events.map((event, at) => {
      const place = x(event.at) + shift;
      const stat = place - printed >= STAT_GAP;
      if (stat) printed = place;
      points.set(`${raw.key}:${event.head}`, { x: place, y });
      return {
        x: place,
        add: event.add,
        del: event.del,
        stat,
        tip: at === raw.events.length - 1,
        title: event.title,
      };
    });
    const tip = dots[dots.length - 1]!;
    points.set(`${raw.key}:tip`, { x: tip.x, y });
    if ('oid' in raw.from)
      cut.set(raw.from.oid, Math.min(cut.get(raw.from.oid) ?? parent.x, parent.x));
    let merge: string | null = null;
    if (raw.merged) {
      const at = Math.max(x(raw.merged.at), tip.x + CUT);
      merge = `M ${tip.x},${y} H ${at - 28} q28,0 28,-28 V ${TRUNK_Y}`;
      marks.push({ x: at, ring: true, title: raw.merged.title });
    }
    placed.push({
      key: raw.key,
      kind: raw.kind,
      word: raw.word.toUpperCase(),
      name: clip(raw.name, room),
      state: words(raw.state).toUpperCase(),
      tone: tone(raw.state),
      meta: raw.meta,
      y,
      path: `M ${parent.x},${parent.y} V ${y - ELBOW} q0,${ELBOW} ${ELBOW},${ELBOW} H ${tip.x}`,
      merge,
      dots,
    });
  });
  for (const [oid, place] of cut) marks.push({ x: place, ring: false, title: oid });

  const times = raws.flatMap((raw) => raw.events.map((event) => event.at));
  const [start, end] = [Math.min(...times), Math.max(...times)];
  const days: number[] = [start];
  for (let day = new Date(start).setHours(24, 0, 0, 0); day <= end; day += DAY) days.push(day);
  const stride = Math.ceil(days.length / 6);
  // Two dates that would print over each other leave one date printed.
  const ticks: { x: number; label: string }[] = [];
  for (const day of days.filter((_, index) => index % stride === 0)) {
    const place = x(day);
    if (ticks.length && place - ticks[ticks.length - 1]!.x < 90) continue;
    ticks.push({ x: place, label: dated(day) });
  }
  const solid = marks.length ? Math.max(...marks.map((mark) => mark.x)) : x0;
  return {
    width,
    height: TRUNK_Y + drop + (raws.length - 1) * row + (narrow ? 34 : 40),
    narrow,
    trunk: { y: TRUNK_Y, x0, solid: Math.max(solid, x0), end: width - 2 },
    marks,
    ticks,
    base: input.baseBranch
      ? {
          text: input.baseBranch,
          width: Math.round(input.baseBranch.length * 6.4) + 18,
          y: narrow ? TRUNK_Y - 34 : TRUNK_Y - 11,
        }
      : null,
    lanes: placed,
  };
}

/** The graph places itself from one measured width, so it needs no canvas and no library. */
export function BranchGraph(input: GraphInput) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const g = width ? lanes(input, width) : null;
  if (!g) return <div ref={frame} />;
  const trunk = g.trunk;
  /** A label sits beside its lane where there is a column for it, and above it where there is not. */
  const at = (lane: Lane, wide: number, tight: number) => lane.y + (g.narrow ? tight : wide);
  return (
    <div ref={frame}>
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        className="branch-graph"
        role="img"
        aria-label="Branch graph"
      >
        {g.ticks.map((tick, index) => (
          <g key={index}>
            {/* The tick is exact; its date is nudged off the edge so it stays whole. */}
            <text className="bg-date" x={Math.min(Math.max(tick.x, 28), g.width - 28)} y={26}>
              {tick.label}
            </text>
            <path className="bg-tick" d={`M ${tick.x},36 V 44`} />
          </g>
        ))}
        <path className="bg-trunk" d={`M ${trunk.x0},${trunk.y} H ${trunk.solid}`} />
        <path
          className="bg-trunk bg-trunk--beyond"
          d={`M ${trunk.solid},${trunk.y} H ${trunk.end}`}
        />
        {g.base && (
          <>
            <rect className="bg-pill" y={g.base.y} width={g.base.width} height={22} rx={11} />
            <text className="bg-ref" x={g.base.width / 2} y={g.base.y + 15}>
              {g.base.text}
            </text>
          </>
        )}
        {g.marks.map((mark, index) => (
          <g key={index}>
            <circle className="bg-dot bg-dot--trunk" cx={mark.x} cy={trunk.y} r={4}>
              <title>{mark.title}</title>
            </circle>
            {mark.ring && <circle className="bg-ring" cx={mark.x} cy={trunk.y} r={9} />}
          </g>
        ))}
        {g.lanes.map((lane) => (
          <g key={lane.key} style={{ '--kind': kindOf(lane.kind).color } as CSSProperties}>
            <path className="bg-lane" d={lane.path} />
            {lane.merge && <path className="bg-lane" d={lane.merge} />}
            <text className="bg-kind" y={at(lane, -18, -46)}>
              {lane.word}
            </text>
            <text className="bg-name" y={at(lane, 2, -26)}>
              {lane.name}
              <title>{lane.name}</title>
            </text>
            <text className="bg-meta" y={at(lane, 21, -7)}>
              <tspan className={`bg-word status--${lane.tone}`}>● {lane.state}</tspan>
              <tspan dx={8}>{lane.meta}</tspan>
            </text>
            {lane.dots.map((dot) => (
              <g key={dot.x}>
                {dot.stat && (
                  <text className="bg-stat" x={dot.x} y={at(lane, -12, 20)}>
                    <tspan className="add">+{dot.add}</tspan>{' '}
                    <tspan className="del">−{dot.del}</tspan>
                  </text>
                )}
                <circle
                  className={dot.tip ? 'bg-dot bg-dot--tip' : 'bg-dot'}
                  cx={dot.x}
                  cy={lane.y}
                  r={dot.tip ? 4.5 : 4}
                >
                  <title>{dot.title}</title>
                </circle>
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
