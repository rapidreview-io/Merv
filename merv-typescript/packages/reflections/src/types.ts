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
  lenses: { id: string; perspective: string; artifact: Artifact; producerId: string }[];
  producerId: string;
  reviewId: string;
  reviewerId: string;
  approvedAt: string;
}
export interface ReflectionCreate {
  requestId: string;
  title?: string;
}
export interface ReflectionLensSubmit {
  lensId: string;
  artifactId: string;
  expectedRevision: number;
  requestId: string;
}
export interface ReflectionSubmit {
  paperChangesArtifactId?: string;
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
