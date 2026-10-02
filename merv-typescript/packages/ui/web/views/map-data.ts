import type { SessionsProjectStatus } from '@merv/contracts/types';
import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { useTool, type Actor, type Project } from '../api';
import { words } from '../components';

/**
 * The home pages' data layer: the shapes they read, the one read that serves all of them,
 * and how their counts are said.
 */

export type Flow = { state: string; updatedAt: string; workflow?: string; version?: number };
export type MapExperiment = {
  id: string;
  name: string;
  intent: string;
  ownerId: string;
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
export type MapReflection = {
  id: string;
  title: string;
  ownerId: string;
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
 * they count, the gate of every workflow in the project, and the rows whose own
 * read has a place on the page. A part the server could not answer for is null.
 */
export interface HomeData {
  project: Project | null;
  actors: Actor[] | null;
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
/** One read for the rail, Home and Now; asking twice joins one request. */
export const useHome = () => useTool<HomeData>('ui.home', {}, { every: 10000 });

export const EM = '—';
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
