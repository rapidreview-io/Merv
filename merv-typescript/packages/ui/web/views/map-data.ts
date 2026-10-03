import type { WorkflowDecision, WorkflowDependency } from '@merv/contracts/workflow-guidance';
import { useTool, type Actor, type Project } from '../api';

/**
 * The data Now and the rail read: the shapes of the records, and the one read that serves
 * both.
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
/**
 * What Now and the rail read, as the server composes it (`ui.home`): the project's
 * records and the gate of every workflow in it. A part the server could not answer
 * for is null.
 */
export interface HomeData {
  project: Project | null;
  actors: Actor[] | null;
  experiments: MapExperiment[] | null;
  tasks: MapTask[] | null;
  reviews: MapReview[] | null;
  cycles: MapCycle[] | null;
  workflows: { workflows: WorkflowDecision[] } | null;
  reflections: MapReflection[] | null;
}
/** One read for the rail and Now; asking twice joins one request. */
export const useHome = () => useTool<HomeData>('ui.home', {}, { every: 10000 });

export const newest = <T>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));
