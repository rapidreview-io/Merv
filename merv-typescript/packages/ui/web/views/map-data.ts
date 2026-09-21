import { createElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SessionsProjectStatus } from '@merv/contracts/types';
import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { useTool, type Actor, type Project } from '../api';
import type { Row } from '../shell';
import { Ago, words } from '../components';

/**
 * The map's data layer: the shapes the home pages read, the one read that serves
 * all of them, and the function that turns records into objects and verbs. It is
 * pure, so what the map may say about a record is exactly what some field of that
 * record says.
 */

export type Flow = { state: string; updatedAt: string; workflow?: string; version?: number };
export type MapExperiment = {
  id: string;
  name: string;
  intent: string;
  ownerId: string;
  testedClaimIds: string[];
  workflow: Flow;
};
export type MapTask = {
  id: string;
  title: string;
  goal: string;
  producerId: string;
  acceptanceChecks: unknown[];
  deliveryIds: string[];
  dependencies: WorkflowDependency[];
  workflow: Flow;
};
export type MapCycle = { id: string; name: string; ownerId: string; workflow: Flow };
export type MapReview = {
  id: string;
  subjectId: string;
  status: string;
  reviewerId: string | null;
  claimable?: boolean;
  verdict: string | null;
  createdAt: string;
};
export type MapClaim = {
  id: string;
  statement: string;
  scope: string;
  status: string;
  confidence: string;
  updatedAt: string;
};
export type MapReflection = {
  id: string;
  title: string;
  ownerId: string;
  experimentIds: string[];
  workflow: Flow;
};
export type MapPaper = {
  documents: Record<
    string,
    {
      current: { revision: number; sections: { content: string }[]; updatedAt: string | null };
      published: { publication: { source: { id: string } } } | null;
    }
  >;
};

export type MapPost = { id: string; authorId: string; body: string; createdAt: string };

/**
 * The whole of both home pages, as the server composes it (`ui.home`): every list
 * the map draws, the gate of every workflow in the project, and the rows whose own
 * read has a place on the page. A part the server could not answer for is null.
 */
export interface HomeData {
  project: Project | null;
  actors: Actor[] | null;
  claims: MapClaim[] | null;
  experiments: MapExperiment[] | null;
  tasks: MapTask[] | null;
  reviews: MapReview[] | null;
  cycles: MapCycle[] | null;
  files: { size: number }[] | null;
  posts: MapPost[] | null;
  workflows: { workflows: WorkflowDecision[] } | null;
  reflections: MapReflection[] | null;
  paper: MapPaper | null;
  sessions: SessionsProjectStatus | null;
  connections: { state: string }[] | null;
  archive: { counts: Record<string, number> } | null;
}
/** One read for the rail, the map and the standing line; asking twice joins one request. */
export const useHome = () => useTool<HomeData>('ui.home', {}, { every: 10000 });

/** One object on the map: a record, the fields it carries, and where it lives. */
export interface MapNode {
  id: string;
  kind: string;
  name: string;
  to: string;
  at: string;
  col: number;
  state: string;
  /** The program this record stands in, where it has one, so a row can draw it. */
  flow?: Flow;
  /** The record's own state says work is happening now — not merely that it is unfinished. */
  live: boolean;
  props: [string, ReactNode][];
}
/** One verb between two records, always derived from a named field. */
export interface MapEdge {
  from: string;
  to: string;
  verb: string;
}
export const EM = '—';
/** A record whose own state says it has stopped; everything else is still in flight. */
const ENDED = ['complete', 'completed', 'abandoned', 'failed', 'done', 'approved'];
export const running = (node: MapNode) =>
  ['experiments', 'tasks', 'reflections'].includes(node.kind) && !ENDED.includes(node.state);
/** How a column reads top to bottom: what is still in flight first, then the newest. */
export const inFlightFirst = (nodes: MapNode[]) =>
  newest(nodes, (node) => node.at).sort((a, b) => Number(running(b)) - Number(running(a)));
/** The one state per kind that means moving right now; everything else is still. */
const MOVING: Record<string, string> = {
  experiments: 'running',
  tasks: 'in_progress',
  reviews: 'started',
};
export const newest = <T>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));
/** The word beside a count agrees with it: 1 review, 2 reviews; a count not yet read is many. */
export const plural = (n: unknown, one: string, many: string) => (n === 1 ? one : many);
/** A part of a whole is the part alone once it is all of it: 2, and otherwise 1/2. */
export const share = (part: number, whole: number) =>
  part === whole ? `${part}` : `${part}/${whole}`;
/** A verdict as the thing that happened to the work: a review passed, it did not "pass". */
const VERDICTS: Record<string, string> = {
  pass: 'passed',
  fail: 'failed',
  needs_changes: 'asked for changes',
};
export const verdictWord = (verdict: string) => VERDICTS[verdict] ?? words(verdict);
/** Counted by value, never by rule: a value the records do not carry is not a group. */
export const tally = <T>(items: T[], of: (item: T) => string | null): [string, number][] => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = of(item);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts];
};

/**
 * Build the object graph. Columns read left to right — what is believed, what is
 * being done, what it became — and every edge names the field it
 * came from: experiment.testedClaimIds, task.dependencies,
 * reflection.experimentIds and the paper publication's own source.
 */
export function graphOf(
  rows: Row[],
  d: {
    claims: MapClaim[];
    experiments: MapExperiment[];
    tasks: MapTask[];
    reviews: MapReview[];
    reflections: MapReflection[];
    paper?: MapPaper;
  },
  named: (id: string | null | undefined) => string | undefined,
): { pool: MapNode[]; edges: MapEdge[] } {
  const pathOf = (kind: string) => rows.find((row) => row.view.kind === kind)?.path;
  const pool: MapNode[] = [];
  const edges: MapEdge[] = [];
  const who = (id: string | null) => named(id) ?? EM;
  // A time is a <time>: how long ago on the card, the moment itself in its title.
  const when = (iso: string | null) => (iso ? createElement(Ago, { at: iso }) : EM);
  const object = (
    col: number,
    kind: string,
    id: string,
    name: string,
    at: string | null,
    to: string,
    state: string,
    props: [string, ReactNode][],
    flow?: Flow,
  ) =>
    pool.push({
      id,
      kind,
      name,
      col,
      at: at ?? '',
      to,
      state,
      flow,
      live: MOVING[kind] === state,
      props,
    });
  const claims = pathOf('claims');
  if (claims)
    for (const item of d.claims)
      object(0, 'claims', item.id, item.statement, item.updatedAt, claims, item.status, [
        ['Confidence', item.confidence],
        ['Scope', item.scope || EM],
        ['Updated', when(item.updatedAt)],
      ]);
  const experiments = pathOf('experiments');
  if (experiments)
    for (const item of d.experiments) {
      const { id, workflow } = item;
      const to = `${experiments}/${id}`;
      object(
        1,
        'experiments',
        id,
        item.name,
        workflow.updatedAt,
        to,
        workflow.state,
        [
          ['Intent', item.intent],
          ['Owner', who(item.ownerId)],
        ],
        workflow,
      );
      for (const claimId of item.testedClaimIds)
        edges.push({ from: id, to: claimId, verb: 'tests' });
    }
  const tasks = pathOf('tasks');
  if (tasks)
    for (const item of d.tasks) {
      const { id, workflow } = item;
      object(
        1,
        'tasks',
        id,
        item.title,
        workflow.updatedAt,
        `${tasks}/${id}`,
        workflow.state,
        [
          ['Goal', item.goal],
          ['Acceptance checks', item.acceptanceChecks.length],
          ['Delivered files', item.deliveryIds.length],
          ['Producer', who(item.producerId)],
        ],
        workflow,
      );
      for (const on of item.dependencies) edges.push({ from: id, to: on.id, verb: 'depends on' });
    }
  // A review is not drawn as an object of its own: it is how a piece of work was judged, so
  // it is a fact on that work's card — the newest one, and the way to its page.
  const reviews = pathOf('reviews');
  if (reviews)
    for (const item of newest(d.reviews, (review) => review.createdAt)) {
      const subject = pool.find((node) => node.id === item.subjectId);
      if (!subject || subject.props.some(([label]) => label === 'Review')) continue;
      const state = item.status === 'submitted' && item.verdict ? item.verdict : item.status;
      subject.props.push([
        'Review',
        createElement(Link, { to: `${reviews}/${item.id}` }, words(state)),
      ]);
    }
  const reflections = pathOf('reflections');
  if (reflections)
    for (const item of d.reflections) {
      const { id, workflow } = item;
      const to = `${reflections}/${id}`;
      object(
        3,
        'reflections',
        id,
        item.title,
        workflow.updatedAt,
        to,
        workflow.state,
        [
          ['Owner', who(item.ownerId)],
          ['Updated', when(workflow.updatedAt)],
        ],
        workflow,
      );
      for (const on of item.experimentIds) edges.push({ from: id, to: on, verb: 'reflects on' });
    }
  const paper = pathOf('paper');
  for (const [kind, document] of Object.entries((paper && d.paper?.documents) || {})) {
    const { current, published } = document;
    if (!current.sections.some((section) => section.content.trim())) continue;
    const id = `paper:${kind}`;
    const name = `§ ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
    object(3, 'paper', id, name, current.updatedAt, paper!, published ? 'published' : 'draft', [
      ['Sections', current.sections.length],
      ['Updated', when(current.updatedAt)],
    ]);
    if (published) edges.push({ from: id, to: published.publication.source.id, verb: 'cites' });
  }
  const known = new Set(pool.map((node) => node.id));
  return { pool, edges: edges.filter((edge) => known.has(edge.from) && known.has(edge.to)) };
}

/**
 * Where the graph draws everything, from one measured width. Only the columns that
 * hold a record are laid out, the first on the page's left edge and the last on its
 * right, so nothing floats in a field of nothing; between two columns there is
 * always room for a verb, and a verb is only ever written in that room, so it can
 * never sit on a card. It is pure, so the drawing is the same wherever it is asked.
 */
export const CARD_H = 96;
export const ROW_H = 112;
export const HEAD_H = 36;
/** The least room between two columns: the longest verb at its size, and air. */
const VERB_W = 96;
const MIN_CARD = 150;
const MAX_CARD = 340;
const LABEL_H = 14;
type Point = { x: number; y: number };
/** One drawn relation: its path, arrowhead included, and where its verb is written. */
export interface MapLine {
  edge: MapEdge;
  d: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}
export interface MapLayout {
  card: number;
  height: number;
  at: Map<string, Point>;
  /** The records in the order they are drawn, column by column and top to bottom. */
  order: MapNode[];
  /** Each column that holds a record: where it starts and how many rows it keeps. */
  columns: { col: number; x: number; rows: number }[];
  lines: MapLine[];
}
/** The head of an arrow arriving level at a card's side, travelling in `dir`. */
const head = (x: number, y: number, dir: number) =>
  `M ${x - dir * 5} ${y - 3.5} L ${x} ${y} L ${x - dir * 5} ${y + 3.5}`;

/** Null where relations cannot be drawn: one column of records, or too narrow a page. */
export function layoutOf(nodes: MapNode[], edges: MapEdge[], width: number): MapLayout | null {
  const cols = [...new Set(nodes.map((node) => node.col))].sort((a, b) => a - b);
  if (cols.length < 2) return null;
  const card = Math.min(MAX_CARD, Math.floor((width - (cols.length - 1) * VERB_W) / cols.length));
  if (card < MIN_CARD) return null;
  const stride = (width - card) / (cols.length - 1);
  const room = stride - card;
  const columns = cols.map((col, index) => ({ col, x: Math.round(index * stride), rows: 0 }));
  const at = new Map<string, Point>();
  const place = new Map<string, { column: number; row: number }>();
  const taken = columns.map(() => new Set<number>());
  const put = (node: MapNode, column: number, wanted: number) => {
    let row = wanted;
    while (taken[column]!.has(row)) row++;
    taken[column]!.add(row);
    columns[column]!.rows = Math.max(columns[column]!.rows, row + 1);
    at.set(node.id, { x: columns[column]!.x, y: HEAD_H + row * ROW_H });
    place.set(node.id, { column, row });
  };
  // Column by column, left to right. A record related to one already placed stands level
  // with it, so the line between them is short and straight; the rest of its column then
  // fills the rows left free, in the order it was given.
  cols.forEach((col, column) => {
    const loose: MapNode[] = [];
    for (const node of nodes.filter((item) => item.col === col)) {
      const beside = edges
        .filter((edge) => edge.from === node.id || edge.to === node.id)
        .map((edge) => place.get(edge.from === node.id ? edge.to : edge.from))
        .find((other) => other && other.column !== column);
      if (beside) put(node, column, beside.row);
      else loose.push(node);
    }
    for (const node of loose) put(node, column, 0);
  });
  const written: Point[] = [];
  /** A verb that would land on another one steps down a line instead. */
  const clear = (point: Point) => {
    while (
      written.some(
        (other) => Math.abs(other.x - point.x) < VERB_W && Math.abs(other.y - point.y) < LABEL_H,
      )
    )
      point.y += LABEL_H;
    written.push(point);
    return point;
  };
  const lines = edges.flatMap((edge): MapLine[] => {
    const [a, b] = [at.get(edge.from), at.get(edge.to)];
    const [from, to] = [place.get(edge.from), place.get(edge.to)];
    if (!a || !b || !from || !to) return [];
    const [sy, ey] = [a.y + CARD_H / 2, b.y + CARD_H / 2];
    if (from.column === to.column) {
      // Two records of one column: a loop beside it, on whichever side has the room.
      const side = from.column < cols.length - 1 ? 1 : -1;
      const x = side > 0 ? a.x + card : a.x;
      const label = clear({ x: x + side * 30, y: (sy + ey) / 2 });
      return [
        {
          edge,
          d: `M ${x} ${sy} C ${x + side * 34} ${sy} ${x + side * 34} ${ey} ${x} ${ey} ${head(x, ey, -side)}`,
          ...label,
          anchor: side > 0 ? 'start' : 'end',
        },
      ];
    }
    const dir = from.column < to.column ? 1 : -1;
    const [sx, ex] = dir > 0 ? [a.x + card, b.x] : [a.x, b.x + card];
    if (Math.abs(from.column - to.column) === 1) {
      const mx = (sx + ex) / 2;
      const label = clear({ x: mx, y: (sy + ey) / 2 });
      return [
        {
          edge,
          d: `M ${sx} ${sy} C ${mx} ${sy} ${mx} ${ey} ${ex} ${ey} ${head(ex, ey, dir)}`,
          ...label,
          anchor: 'middle',
        },
      ];
    }
    // Past a column in between, the line runs in the lane between two rows of cards,
    // where there is never a card to pass under; it turns only in the room at each end.
    const lane = HEAD_H + Math.max(from.row, to.row) * ROW_H - (ROW_H - CARD_H) / 2;
    const half = room / 2;
    const label = clear({ x: sx + dir * half, y: (sy + lane) / 2 });
    return [
      {
        edge,
        d:
          `M ${sx} ${sy} C ${sx + dir * half} ${sy} ${sx + dir * half} ${lane} ${sx + dir * room} ${lane} ` +
          `L ${ex - dir * room} ${lane} C ${ex - dir * half} ${lane} ${ex - dir * half} ${ey} ${ex} ${ey} ` +
          head(ex, ey, dir),
        ...label,
        anchor: 'middle',
      },
    ];
  });
  const rows = Math.max(...columns.map((column) => column.rows));
  const order = [...nodes].sort((a, b) => {
    const [p, q] = [at.get(a.id)!, at.get(b.id)!];
    return p.x - q.x || p.y - q.y;
  });
  return { card, height: HEAD_H + rows * ROW_H, at, order, columns, lines };
}
