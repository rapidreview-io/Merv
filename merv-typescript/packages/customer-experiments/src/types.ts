import type { ReviewRequest } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { RequestRecord } from './store.js';

export const SERVICE_MODEL = { harness: 'codex', model: 'gpt-6-astra', effort: 'medium' } as const;
export interface DataRequirement {
  id: string;
  label: string;
  role: 'training' | 'validation' | 'evaluation' | 'reference';
  format: 'csv' | 'jsonl';
  columns: string[];
  labelColumn?: string;
  minRows: number;
}
/** Only the upload validator, never the external agent, constructs these records. */
export interface ValidatedDataset {
  requirementId: string;
  artifactId: string;
  bucket: string;
  key: string;
  filename: string;
  sha256: string;
  size: number;
  rows: number;
  columns: string[];
  validationId: string;
  validatedAt: string;
}
export interface ExperimentPlan {
  title: string;
  question: string;
  decision: string;
  rationale: string;
  hypothesis: string;
  method: string[];
  baseline: string;
  metric: string;
  successCriteria: string[];
  research: { title: string; url: string }[];
  code: { repository: string; revision: string } | null;
  models: { name: string; revision: string }[];
  dataRequirements: DataRequirement[];
  /** Customer-facing execution bounds. Hardware selection belongs to Merv's executing agent. */
  limits: { wallMinutes: number; maxTokens: number; maxAttempts: number };
  turnaround: string;
  deliverables: string[];
  executionSpec: string;
  feasibility: string;
}
export type PlanLimits = ExperimentPlan['limits'];
interface ContractTerms {
  id: string;
  version: number;
  hash: string;
  model: typeof SERVICE_MODEL;
  price: { amountCents: number; currency: 'usd' };
  createdAt: string;
}
/** service_experiment@1-2: the structured offer and its validated datasets. */
export interface StructuredContract extends ContractTerms {
  plan: ExperimentPlan;
  datasets: ValidatedDataset[];
}
/** One object in the request's bucket, as frozen into a v3 contract. */
export interface RequestFile {
  key: string;
  size: number;
  etag: string;
}
/** The request bucket's current objects (FilesService); a v3 acceptance freezes them. */
export interface RequestFiles {
  manifest(id: string): Promise<RequestFile[]>;
  /** True once the request's files were deleted: nothing may accept or pay against them. */
  deleted(id: string): Promise<boolean>;
  /** Prepares the request's bucket ahead of its first upload (v3; no-op where there is none). */
  warm?(record: RequestRecord): Promise<void>;
  /** A window of one request file's text, for the intake agent (see FilesService.read). */
  read?(id: string, key: string, offset?: number): Promise<unknown>;
  /** A short-lived download link for one request file, for the intake agent's terminal. */
  link?(id: string, key: string): Promise<{ key: string; url: string; expiresAt: string }>;
}
/** service_experiment@3: the verified plan document is the specification. Only its summary
 *  (question, criteria, limits) is structured, filled by the intake agent at verification. */
export interface DocumentContract extends ContractTerms {
  document: string;
  revision: number;
  question: string;
  criteria: string[];
  limits: PlanLimits;
  files: RequestFile[];
}
export type ExperimentContract = StructuredContract | DocumentContract;
export const isDocumentContract = (c: ExperimentContract): c is DocumentContract => 'document' in c;
export const contractLimits = (c: ExperimentContract): PlanLimits =>
  isDocumentContract(c) ? c.limits : c.plan.limits;
export const contractTitle = (c: ExperimentContract): string =>
  isDocumentContract(c) ? c.question : c.plan.title;
/** Validated dataset artifacts; v3 request files live in the request bucket instead. */
export const contractDatasets = (c: ExperimentContract): ValidatedDataset[] =>
  isDocumentContract(c) ? [] : c.datasets;

export type PlanStatus = 'drafting' | 'verifying' | 'changes_requested' | 'accepted';
export interface PlanView {
  revision: number;
  document: string;
  /** Null only before the first revision. */
  updatedBy: 'customer' | 'agent' | null;
  updatedAt: string | null;
  status: PlanStatus;
  feedback: string | null;
  /** The revision last handed in for verification; it cannot be handed in again unchanged. */
  submittedRevision: number | null;
  contract: null | {
    version: number;
    priceCents: number;
    currency: 'usd';
    limits: PlanLimits;
  };
}
export interface ResultSubmission {
  id: string;
  contractId: string;
  artifactIds: string[];
  summary: string;
  /** The rendered report the results were submitted with. */
  report?: { sourceArtifactId: string; pdfArtifactId: string; pageArtifactIds: string[] };
  producerId: string;
  sessionId: string;
  executionRevision: number;
  createdAt: string;
  codeHead?: string;
}
export interface CustomerExperiment {
  id: string;
  projectId: string;
  title: string;
  ownerId: string;
  workflow: WorkflowSnapshot;
  contract: ExperimentContract | null;
  acceptedContractId: string | null;
  acceptedAt: string | null;
  email: string | null;
  paymentId: string | null;
  attempts: number;
  submission: ResultSubmission | null;
  review: ReviewRequest | null;
  createdAt: string;
}

/** One customer-visible progress line the executing worker reported. */
export interface ProgressLine {
  at: string;
  attempt: number;
  text: string;
  result?: { name: string; score: number; total: number };
  step?: { done: number; total: number };
}
