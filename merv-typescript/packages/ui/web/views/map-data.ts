import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import type { Experiment } from '@merv/experiments/models';
import type { ResearchRecord } from '@merv/research/models';
import { useTool, type Actor, type Project } from '../api';
import type { ReviewRequest } from '@merv/contracts/types';
import type { Reflection } from '@merv/reflections/models';
import type { Task } from '@merv/tasks/models';

/**
 * The data Now and the rail read: the shapes of the records, and the one read that serves
 * both.
 */

export type Flow = { state: string; updatedAt: string; workflow?: string; version?: number };
/**
 * Each record as the home read keeps it: the fields of its row's `home.keep`, each the record's
 * own, long prose cut to a summary.
 */
export type MapExperiment = Pick<
  Experiment,
  'id' | 'name' | 'intent' | 'ownerId' | 'conclusion' | 'workflow'
>;
export type MapTask = Pick<
  Task,
  'id' | 'title' | 'goal' | 'producerId' | 'dependencies' | 'dependents' | 'failure' | 'workflow'
>;
export type MapCycle = Pick<
  ResearchRecord,
  'id' | 'name' | 'ownerId' | 'workflow' | 'researchDependencies' | 'reflectionId' | 'automation'
>;
export type MapReview = Pick<
  ReviewRequest,
  | 'id'
  | 'subjectId'
  | 'subjectRevision'
  | 'status'
  | 'reviewerId'
  | 'claimable'
  | 'verdict'
  | 'returnTo'
  | 'findings'
  | 'createdAt'
>;
export type MapReflection = Pick<Reflection, 'id' | 'title' | 'ownerId' | 'workflow' | 'lenses'>;
/**
 * What Now and the rail read, as the server composes it (`ui.home`): the project's
 * records, under the id of the row that lists them, and the gate of every open workflow in it,
 * and of ended work another plugin still holds. A part the server could not answer for is null.
 */
export interface HomeData {
  project: Project | null;
  actors: Actor[] | null;
  experiments: MapExperiment[] | null;
  tasks: MapTask[] | null;
  reviews: MapReview[] | null;
  research: MapCycle[] | null;
  workflows: { workflows: WorkflowDecision[] } | null;
  reflections: MapReflection[] | null;
}
/** One read for the rail and Now; asking twice joins one request. */
export const useHome = (every = 10000) => useTool<HomeData>('ui.home', {}, { every });

export const newest = <T>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => at(b).localeCompare(at(a)));
