import type { Artifact, ReviewRequest } from '@merv/contracts/types';
import type { WorkflowSnapshot } from '@merv/workflows/models';

/** A reflection as Reflections keeps it and every reader reads it: portable, with no server code. */
export interface ChangeSpecTask {
  key: string;
  kind: 'task';
  title: string;
  goal: string;
  checks: string[];
  /** Keys of other items in the same plan. */
  dependsOn: string[];
  rationale: string;
}
export interface ChangeSpecExperiment {
  key: string;
  kind: 'experiment';
  name: string;
  question: string;
  details: string;
  /** Keys of task items in the same plan: an experiment waits only on tasks. */
  dependsOn: string[];
  rationale: string;
}
export type WorkItem = ChangeSpecTask | ChangeSpecExperiment;
/** A change specification submitted as application/json: the next wave's work, stated as records. */
interface ChangeSpecBody {
  /** What a text change specification says: scope and consolidation changes, as prose. */
  changes: string;
  next:
    | { decision: 'continue'; name: string; rationale: string }
    | {
        decision: 'stop';
        reason: 'goal_met' | 'no_worthwhile_next_step' | 'needs_owner';
        rationale: string;
      };
  /** Existing tasks and experiments the next research cycle still waits on. */
  carriedOver: { workflowId: string; reason: string }[];
  rejected: { title: string; reason: string }[];
}
export type ChangeSpec = ChangeSpecBody &
  (
    | {
        /** Approved before version 3 and read as stored; a submission must be version 3. */
        version: 2;
        items: (WorkItem & {
          workspace: { provider: 'none' } | { provider: 'code'; version: 1 };
        })[];
      }
    | { version: 3; items: WorkItem[] }
  );
export interface ReflectionLens {
  id: string;
  reflectionId: string;
  attempt: number;
  perspective: string;
  instructions: string;
  producerId: string | null;
  artifact: Artifact | null;
  workflow: WorkflowSnapshot;
}
/** A wave as Home and the rail read it: where it and each current lens stand. */
export interface ReflectionSummary {
  id: string;
  title: string;
  ownerId: string;
  workflow: WorkflowSnapshot;
  lenses: { id: string; workflow: WorkflowSnapshot; written: boolean }[];
}
export interface Reflection {
  id: string;
  projectId: string;
  title: string;
  ownerId: string;
  createdAt: string;
  attempt: number;
  lenses: ReflectionLens[];
  workflow: WorkflowSnapshot;
  review: ReviewRequest | null;
  report: Artifact | null;
  changeSpec: Artifact | null;
  /** The parsed plan of an application/json change specification; null for a text one. */
  plan: ChangeSpec | null;
}
