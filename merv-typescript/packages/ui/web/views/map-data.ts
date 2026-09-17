import type { ReactNode } from 'react';
import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import type { Row } from '../shell';
import { relativeTime } from '../components';

/**
 * The map's data layer: the shapes the map reads from the list tools, and the
 * one function that turns them into objects and verbs. It is pure, so what the
 * map may say about a record is exactly what some field of that record says.
 */

export type Flow = { state: string; updatedAt: string };
export type MapExperiment = {
  id: string;
  name: string;
  intent: string;
  ownerId: string;
  testedClaimIds: string[];
  attempt: { index: number };
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
  guidance: WorkflowDecision;
  workflow: Flow;
};
export type MapCycle = { id: string; name: string; ownerId: string; workflow: Flow };
export type MapReview = {
  id: string;
  subjectId: string;
  status: string;
  reviewerId: string | null;
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
  attempt: number;
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
export type Live = {
  agents?: { status: string }[];
  liveSessionCount: number;
  sessionTotal: number;
  runners: { live: boolean }[];
  queueTotal: number;
};

/** One object on the map: a record, the fields it carries, and where it lives. */
export interface MapNode {
  id: string;
  kind: string;
  name: string;
  to: string;
  at: string;
  col: number;
  state: string;
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
/** The one state per kind that means moving right now; everything else is still. */
const MOVING: Record<string, string> = {
  experiments: 'running',
  tasks: 'in_progress',
  reviews: 'started',
};
export const newest = <T>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));
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
 * being done, what judged it, what it became — and every edge names the field it
 * came from: experiment.testedClaimIds, review.subjectId, task.dependencies,
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
  const when = (iso: string | null) => (iso ? relativeTime(iso) : EM);
  const object = (
    col: number,
    kind: string,
    id: string,
    name: string,
    at: string | null,
    to: string,
    state: string,
    props: [string, ReactNode][],
  ) =>
    pool.push({
      id,
      kind,
      name,
      col,
      at: at ?? '',
      to,
      state,
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
      object(1, 'experiments', id, item.name, workflow.updatedAt, to, workflow.state, [
        ['Intent', item.intent],
        ['Attempt', item.attempt.index],
        ['Owner', who(item.ownerId)],
      ]);
      for (const claimId of item.testedClaimIds)
        edges.push({ from: id, to: claimId, verb: 'tests' });
    }
  const tasks = pathOf('tasks');
  if (tasks)
    for (const item of d.tasks) {
      const { id, workflow } = item;
      object(1, 'tasks', id, item.title, workflow.updatedAt, `${tasks}/${id}`, workflow.state, [
        ['Goal', item.goal],
        ['Acceptance checks', item.acceptanceChecks.length],
        ['Delivered files', item.deliveryIds.length],
        ['Producer', who(item.producerId)],
      ]);
      for (const on of item.dependencies) edges.push({ from: id, to: on.id, verb: 'depends on' });
    }
  const reviews = pathOf('reviews');
  if (reviews)
    for (const item of d.reviews) {
      const subject = pool.find((node) => node.id === item.subjectId);
      const name = subject ? `Review · ${subject.name}` : 'Review';
      object(2, 'reviews', item.id, name, item.createdAt, `${reviews}/${item.id}`, item.status, [
        ['Verdict', item.verdict ?? EM],
        ['Reviewer', item.reviewerId ? who(item.reviewerId) : EM],
        ['Requested', when(item.createdAt)],
      ]);
      edges.push({ from: item.subjectId, to: item.id, verb: 'reviewed by' });
    }
  const reflections = pathOf('reflections');
  if (reflections)
    for (const item of d.reflections) {
      const { id, workflow } = item;
      const to = `${reflections}/${id}`;
      object(3, 'reflections', id, item.title, workflow.updatedAt, to, workflow.state, [
        ['Attempt', item.attempt],
        ['Owner', who(item.ownerId)],
        ['Updated', when(workflow.updatedAt)],
      ]);
      for (const on of item.experimentIds) edges.push({ from: id, to: on, verb: 'reflects on' });
    }
  const paper = pathOf('paper');
  for (const [kind, document] of Object.entries((paper && d.paper?.documents) || {})) {
    const { current, published } = document;
    if (!current.sections.some((section) => section.content.trim())) continue;
    const id = `paper:${kind}`;
    const name = `§ ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
    object(3, 'paper', id, name, current.updatedAt, paper!, published ? 'published' : 'draft', [
      ['Revision', current.revision],
      ['Sections', current.sections.length],
      ['Updated', when(current.updatedAt)],
    ]);
    if (published) edges.push({ from: id, to: published.publication.source.id, verb: 'cites' });
  }
  const known = new Set(pool.map((node) => node.id));
  return { pool, edges: edges.filter((edge) => known.has(edge.from) && known.has(edge.to)) };
}
