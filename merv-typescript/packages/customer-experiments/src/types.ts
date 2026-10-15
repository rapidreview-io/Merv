import type { ReviewRequest } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';

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
export interface ExperimentContract {
  id: string;
  version: number;
  hash: string;
  plan: ExperimentPlan;
  datasets: ValidatedDataset[];
  model: typeof SERVICE_MODEL;
  price: { amountCents: number; currency: 'usd' };
  createdAt: string;
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
/** service_experiment@3: the request's files as frozen into an accepted contract. */
export interface RequestFiles {
  manifest(id: string): Promise<{ key: string; size: number; etag: string }[]>;
}
