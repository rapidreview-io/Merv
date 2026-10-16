import { z } from 'zod';
import { check } from '@merv/contracts';
import type { ExperimentPlan, ValidatedDataset } from './types.js';

const text = z.string().trim().min(1).max(12000);
const names = z.array(z.string().min(1).max(120)).max(100);
export const dataRequirementSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    label: text,
    role: z.enum(['training', 'validation', 'evaluation', 'reference']),
    format: z.enum(['csv', 'jsonl']),
    columns: names.min(1),
    labelColumn: z.string().min(1).max(120).optional(),
    minRows: z.number().int().min(1).max(100000),
  })
  .strict();
export const planSchema = z
  .object({
    title: text.max(160),
    question: text,
    decision: text,
    rationale: text,
    hypothesis: text,
    method: z.array(text).min(1).max(20),
    baseline: text,
    metric: text,
    successCriteria: z.array(text).min(1).max(20),
    research: z.array(z.object({ title: text, url: z.string().url().max(2000) }).strict()).max(30),
    code: z
      .object({ repository: z.string().url(), revision: z.string().regex(/^[a-fA-F0-9]{40,64}$/) })
      .strict()
      .nullable(),
    models: z.array(z.object({ name: text, revision: text }).strict()).max(20),
    dataRequirements: z.array(dataRequirementSchema).max(10),
    limits: z
      .object({
        wallMinutes: z.number().int().min(1).max(1440),
        maxTokens: z.number().int().min(1000).max(500_000_000),
        maxAttempts: z.number().int().min(1).max(2),
      })
      .strict(),
    turnaround: text,
    deliverables: z.array(text).min(1).max(20),
    executionSpec: text,
    feasibility: text,
  })
  .strict();
export const limitsSchema = planSchema.shape.limits;
/** A v3 plan document: free Markdown the customer and the intake agent co-edit. */
export const planDocumentSchema = z.string().max(200_000);
/** plan_verify's input: one object (tool inputs are objects), its fields required per decision. */
export const planVerifySchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    decision: z.enum(['accept', 'changes_requested']),
    feedback: text.optional(),
    question: text.optional(),
    criteria: z.array(text).min(1).max(20).optional(),
    limits: limitsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const required =
      value.decision === 'accept' ? (['question', 'criteria', 'limits'] as const) : ['feedback'];
    for (const field of required)
      if (value[field as keyof typeof value] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required to ${value.decision === 'accept' ? 'accept' : 'request changes'}`,
        });
  });
export type PlanVerification =
  | {
      revision: number;
      decision: 'accept';
      feedback?: string;
      question: string;
      criteria: string[];
      limits: ExperimentPlan['limits'];
    }
  | { revision: number; decision: 'changes_requested'; feedback: string };
export const datasetSchema = z
  .object({
    requirementId: z.string().min(1),
    artifactId: z.string().min(1),
    bucket: z.string().min(1),
    key: z.string().min(1),
    filename: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    rows: z.number().int().positive(),
    columns: names,
    validationId: z.string().min(1),
    validatedAt: z.string().datetime(),
  })
  .strict();
/** One customer-visible progress line from the executing worker. */
export const progressSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1).max(200),
    /** A finished item's score, e.g. one model's correct answers out of the cases. */
    result: z
      .object({
        name: z.string().trim().min(1).max(80),
        score: z.number().finite(),
        total: z.number().finite().positive(),
      })
      .strict()
      .optional(),
    /** How far through the planned items the run is. */
    step: z
      .object({ done: z.number().int().min(0), total: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export type ProgressInput = z.infer<typeof progressSchema>;

export const submitResultsSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    artifactIds: z.array(z.string().min(1)).max(30).default([]),
    /** service_experiment@2: the Markdown artifact report.render(final) returned; its PDF and
     *  pages join the results. */
    reportArtifactId: z.string().min(1).optional(),
    /** Defaults to the report's answer and the description under its result chart. */
    summary: text.optional(),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export function validateAgreement(plan: ExperimentPlan, datasets: ValidatedDataset[]): void {
  planSchema.parse(plan);
  z.array(datasetSchema).max(10).parse(datasets);
  check(
    new Set(plan.dataRequirements.map((r) => r.id)).size === plan.dataRequirements.length,
    'duplicate_requirement',
    'Data requirements need distinct IDs',
  );
  check(
    new Set(datasets.map((d) => d.requirementId)).size === datasets.length,
    'duplicate_dataset',
    'Each requirement has exactly one validated dataset',
  );
  check(
    datasets.length === plan.dataRequirements.length,
    'data_not_ready',
    'Every data requirement needs its validated file',
    409,
  );
  check(
    datasets.reduce((n, d) => n + d.size, 0) <= 100 * 1024 * 1024,
    'data_limit',
    'The initial offer supports at most 100 MiB of data',
  );
  for (const req of plan.dataRequirements) {
    const data = datasets.find((d) => d.requirementId === req.id);
    check(
      data &&
        data.rows >= req.minRows &&
        req.columns.every((c) => data.columns.includes(c)) &&
        (!req.labelColumn || data.columns.includes(req.labelColumn)),
      'data_not_ready',
      `Validated data does not satisfy ${req.label}`,
      409,
    );
  }
  const training = datasets.filter(
    (d) => plan.dataRequirements.find((r) => r.id === d.requirementId)?.role === 'training',
  );
  const evaluation = datasets.filter(
    (d) => plan.dataRequirements.find((r) => r.id === d.requirementId)?.role === 'evaluation',
  );
  check(
    !training.some((t) => evaluation.some((e) => e.sha256 === t.sha256)),
    'data_leakage',
    'Training and evaluation cannot use identical files',
  );
}

export const migrations = {
  1: `
CREATE TABLE customer_experiments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, owner_id TEXT NOT NULL,
 contract_id TEXT, accepted_contract_id TEXT, accepted_at TEXT, email TEXT, payment_id TEXT,
 attempts BIGINT NOT NULL DEFAULT 0, submission_id TEXT, review_id TEXT, code_head TEXT, created_at TEXT NOT NULL
);
CREATE TABLE customer_experiment_contracts (
 id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, version BIGINT NOT NULL, hash TEXT NOT NULL,
 artifact_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(experiment_id,version)
);
CREATE TABLE customer_experiment_acceptances (
 contract_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, email TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE TABLE customer_experiment_payments (
 payment_id TEXT PRIMARY KEY, contract_id TEXT NOT NULL UNIQUE, experiment_id TEXT NOT NULL,
 amount_cents BIGINT NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
 prior_wall_ms BIGINT NOT NULL, prior_tokens BIGINT NOT NULL
);
CREATE TABLE customer_experiment_submissions (
 id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE customer_experiment_commands (
 project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE FUNCTION customer_experiments_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Customer experiment receipts are immutable', ERRCODE='23514'; END;
$merv$;
CREATE TRIGGER customer_contract_immutable BEFORE UPDATE OR DELETE ON customer_experiment_contracts FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
CREATE TRIGGER customer_acceptance_immutable BEFORE UPDATE OR DELETE ON customer_experiment_acceptances FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
CREATE TRIGGER customer_payment_immutable BEFORE UPDATE OR DELETE ON customer_experiment_payments FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
CREATE TRIGGER customer_submission_immutable BEFORE UPDATE OR DELETE ON customer_experiment_submissions FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
CREATE TRIGGER customer_command_immutable BEFORE UPDATE OR DELETE ON customer_experiment_commands FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
`,
  2: `
CREATE TABLE customer_experiment_retained_outputs (
 submission_id TEXT PRIMARY KEY, artifact_ids TEXT NOT NULL, receipt_id TEXT NOT NULL
);
CREATE TRIGGER customer_retained_outputs_immutable BEFORE UPDATE OR DELETE ON customer_experiment_retained_outputs FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
`,
  3: `
CREATE TABLE customer_experiment_plans (
 experiment_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, status TEXT NOT NULL, feedback TEXT,
 submitted_revision BIGINT, updated_at TEXT NOT NULL
);
CREATE TABLE customer_experiment_plan_revisions (
 experiment_id TEXT NOT NULL, revision BIGINT NOT NULL, document TEXT NOT NULL, updated_by TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(experiment_id,revision)
);
CREATE TRIGGER customer_plan_revision_immutable BEFORE UPDATE OR DELETE ON customer_experiment_plan_revisions FOR EACH ROW EXECUTE FUNCTION customer_experiments_immutable();
`,
  4: `
CREATE TABLE customer_experiment_progress (
 id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, attempt BIGINT NOT NULL, text TEXT NOT NULL,
 result_name TEXT, result_score DOUBLE PRECISION, result_total DOUBLE PRECISION,
 step_done BIGINT, step_total BIGINT, created_at TEXT NOT NULL
);
CREATE INDEX customer_experiment_progress_by_experiment ON customer_experiment_progress(experiment_id, created_at);
`,
};
