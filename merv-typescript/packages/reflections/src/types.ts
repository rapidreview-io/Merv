import type {
  Artifact,
  Caller,
  ProcessGraph,
  ReviewRequest,
  RunningKey,
  RunningNode,
  RunningPanelPart,
  Transaction,
  WorkflowSnapshot,
} from '@merv/contracts';
import type {} from 'cordis';

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
export type ChangeSpec = ChangeSpecBody & {
  version: 2;
  items: (WorkItem & { workspace: { provider: 'none' } | { provider: 'code'; version: 1 } })[];
};
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
/** Exact reviewed bytes and provenance; terminally immutable and safe for downstream programs. */
export interface ApprovedReflection {
  id: string;
  projectId: string;
  revision: number;
  report: Artifact;
  changeSpec: Artifact;
  /**
   * Present only when the change specification was submitted as application/json. A text
   * change specification is never parsed into authority.
   */
  plan?: ChangeSpec;
  lenses: { id: string; perspective: string; artifact: Artifact; producerId: string }[];
  producerId: string;
  reviewId: string;
  reviewerId: string;
  approvedAt: string;
}
export interface ReflectionCreate {
  requestId: string;
  title?: string;
  /**
   * The digest of the research cycle before this wave's, shown to the wave under a heading the
   * server wrote. Research alone sets it; no tool accepts it, so nobody can present an artifact
   * of their choosing as decisions already made.
   */
  previousCycleDigestId?: string;
  /** Automatic Research needs an explicit reviewed continue/stop decision. */
  requirePlan?: boolean;
}
export interface ReflectionLensSubmit {
  lensId: string;
  artifactId: string;
  expectedRevision: number;
  requestId: string;
}
export interface ReflectionSubmit {
  reflectionId: string;
  reportArtifactId: string;
  changeSpecArtifactId: string;
  expectedRevision: number;
  requestId: string;
}
export interface ReflectionEnd {
  reflectionId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
export interface Reflections {
  create(caller: Caller, input: ReflectionCreate, tx?: Transaction): Promise<Reflection>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<Reflection>;
  list(caller: Caller, tx?: Transaction): Promise<Reflection[]>;
  lens(caller: Caller, id: string, tx?: Transaction): Promise<ReflectionLens>;
  submitLens(
    caller: Caller,
    input: ReflectionLensSubmit,
    tx?: Transaction,
  ): Promise<ReflectionLens>;
  submit(caller: Caller, input: ReflectionSubmit, tx?: Transaction): Promise<Reflection>;
  /** The owner or an operator abandons an unfinished wave, its open lenses with it. */
  end(caller: Caller, input: ReflectionEnd, tx?: Transaction): Promise<Reflection>;
  approved(caller: Caller, id: string, tx?: Transaction): Promise<ApprovedReflection>;
  /** The wave still open in the project, if any: only one reflects at a time. */
  open(caller: Caller, tx?: Transaction): Promise<string | undefined>;
  /** The wave's workflow drawn with its place in it, as Tasks.process draws a task's. */
  process(caller: Caller, id: string): Promise<ProcessGraph>;
  /**
   * The waves on the Running page: the open one, and any other that `include` names, by its
   * key or one of its lenses' keys, because another owner holds it there. Each is one node
   * that absorbs its current lenses.
   */
  running(caller: Caller, include?: Iterable<RunningKey>, tx?: Transaction): Promise<RunningNode[]>;
  /** A wave's Running sidebar, or null for an id that is not a wave, such as one of its lenses. */
  runningPanel(caller: Caller, id: string): Promise<RunningPanelPart | null>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    reflections: Reflections;
  }
}
