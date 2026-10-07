import type {
  Artifact,
  Caller,
  ReviewApplication,
  RunningKey,
  RunningNode,
  RunningPanelPart,
  Transaction,
  WorkRoute,
} from '@merv/contracts';
import type {} from 'cordis';
import type { ProcessGraph } from '@merv/workflows/models';
import type { PaperChanges } from '@merv/paper/types';
import type { ChangeSpec, Reflection, ReflectionLens, ReflectionSummary } from './models.js';
export type * from './models.js';

/** A reflection verdict, with the reviewer's own Methods/Results edits. */
export interface ReflectionReview extends ReviewApplication {
  paperChanges?: PaperChanges;
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
  /**
   * What a wave's page polls: the wave, and the stage it stands at read without running an
   * action's check (its page draws no action).
   */
  page(caller: Caller, id: string): Promise<{ reflection: Reflection; process: ProcessGraph }>;
  /** Every wave as Home reads it, newest first: three statements, however many waves. */
  home(caller: Caller): Promise<ReflectionSummary[]>;
  lens(caller: Caller, id: string, tx?: Transaction): Promise<ReflectionLens>;
  submitLens(
    caller: Caller,
    input: ReflectionLensSubmit,
    tx?: Transaction,
  ): Promise<ReflectionLens>;
  submit(caller: Caller, input: ReflectionSubmit, tx?: Transaction): Promise<Reflection>;
  /** The owner or an operator abandons an unfinished wave, its open lenses with it. */
  end(caller: Caller, input: ReflectionEnd, tx?: Transaction): Promise<Reflection>;
  /** What the wave's approval holds, or null until it is approved: never for one abandoned. */
  approved(caller: Caller, id: string, tx?: Transaction): Promise<ApprovedReflection | null>;
  /** The wave still open in the project, if any: only one reflects at a time. */
  open(caller: Caller, tx?: Transaction): Promise<string | undefined>;
  /**
   * The waves on the Running page: the open one, and any other that `include` names, by its
   * key or one of its lenses' keys, because another owner holds it there. Each is one node
   * that absorbs its current lenses.
   */
  running(caller: Caller, include?: Iterable<RunningKey>, tx?: Transaction): Promise<RunningNode[]>;
  /** A wave's Running sidebar, or null for an id that is not a wave, such as one of its lenses. */
  runningPanel(caller: Caller, id: string, route?: WorkRoute): Promise<RunningPanelPart | null>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    reflections: Reflections;
  }
}
