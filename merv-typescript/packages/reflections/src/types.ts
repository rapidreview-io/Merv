import type {
  Artifact,
  Caller,
  ReviewRequest,
  Transaction,
  WorkflowSnapshot,
} from '@merv/contracts';
import type {} from 'cordis';
import type { PaperWorkspace, PaperProposal } from '@merv/paper/types';

/** Minimal reader for retained version-1 snapshots; no live Knowledge dependency. */
export interface HistoricalReflectionCorpus {
  [field: string]: unknown;
  selection: {
    [field: string]: unknown;
    artifacts: (
      { id: string; status: 'retained'; artifact: Artifact } | { id: string; status: 'missing' }
    )[];
    experiments: { id: string }[];
  };
}
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
  /** Only present in retained plans from before claims were retired. */
  testedClaimIds?: string[];
  /** Keys of task items in the same plan: an experiment waits only on tasks. */
  dependsOn: string[];
  rationale: string;
}
export type WorkItem = ChangeSpecTask | ChangeSpecExperiment;
/** A change specification submitted as application/json: the next wave's work, stated as records. */
export interface ChangeSpec {
  version: 1;
  /** What a text change specification says: scope, claim and consolidation changes, as prose. */
  changes: string;
  next:
    | { decision: 'continue'; name: string; rationale: string }
    | {
        decision: 'stop';
        reason: 'goal_met' | 'no_worthwhile_next_step' | 'needs_owner';
        rationale: string;
      };
  items: WorkItem[];
  /** Existing tasks and experiments the next research cycle still waits on. */
  carriedOver: { workflowId: string; reason: string }[];
  rejected: { title: string; reason: string }[];
}
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
  paperProposal: PaperProposal | null;
  id: string;
  projectId: string;
  title: string;
  ownerId: string;
  createdAt: string;
  attempt: number;
  corpus: HistoricalReflectionCorpus | null;
  experimentIds: string[];
  paper: Pick<PaperWorkspace, 'documents' | 'citations'> | null;
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
  paperProposal?: PaperProposal;
  id: string;
  projectId: string;
  revision: number;
  corpus: HistoricalReflectionCorpus | null;
  experimentIds: string[];
  paper: Pick<PaperWorkspace, 'documents' | 'citations'> | null;
  report: Artifact;
  /** Legacy only: waves approved before the 2026-09-16 ruling pinned an authored project graph. Never written going forward. */
  graph?: Artifact;
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
  approved(caller: Caller, id: string, tx?: Transaction): Promise<ApprovedReflection>;
  /** The wave still open in the project, if any: only one reflects at a time. */
  open(caller: Caller, tx: Transaction): Promise<string | undefined>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    reflections: Reflections;
  }
}
