import { folded, visible, type Limits } from '@merv/contracts';
import { z } from 'zod';

const id = z.string().min(1);
/** The brief renders the title and each check on its own numbered line. */
const line = (what: string, max?: number) =>
  (max === undefined ? z.string().min(1) : z.string().min(1).max(max))
    .regex(/^[^\r\n]*$/, `${what} is one line`)
    .refine(visible, `${what} must be nonblank`);
const goal = z.string().min(1);
const distinct = (checks: string[]) => new Set(checks.map(folded)).size === checks.length;

/**
 * Task creation, parsed inside createTask so service tasks from Code and Research pass through
 * it too. It has no goal bound: a code-research resolution goal can reach about 25,000
 * characters, and the rendered brief's 32,000-character cap is the service's limit.
 */
export const taskCreateSchema = z.object({
  title: line('A title', 300),
  goal: goal.refine(visible, 'The goal must be nonblank'),
  checks: z.array(line('A check')).min(1).refine(distinct, 'Done-when checks must be distinct'),
  briefId: id.optional(),
  type: z.string().min(1).optional(),
  typeVersion: z.number().int().positive().optional(),
  contextInputs: z.record(z.array(id)).optional(),
  // Workflows judges dependencies (invalid_dependencies) when the task starts.
  dependsOn: z.custom<string[] | string | null | undefined>(() => true),
  workspace: z.enum(['none', 'git']).optional(),
  baseTaskId: id.optional(),
  requestId: z.string().min(1).max(200).refine(visible, 'requestId must be nonblank'),
});
/** The public tool keeps its tighter caps for agents. */
export const taskCreateToolSchema = taskCreateSchema
  .extend({
    dependsOn: z
      .union([z.array(z.string()), z.string()])
      .nullable()
      .optional(),
    goal: goal.max(16000).refine(visible, 'The goal must be nonblank'),
    checks: z
      .array(line('A check', 2000))
      .min(1)
      .max(20)
      .refine(distinct, 'Done-when checks must be distinct'),
  })
  .strict();
/** The codes direct callers have always received for each field. */
export const taskCreateFields = {
  title: 'invalid_brief',
  goal: 'invalid_brief',
  checks: 'invalid_checks',
  briefId: 'invalid_brief',
  contextInputs: 'invalid_context',
  workspace: 'invalid_workspace',
  baseTaskId: 'invalid_workspace',
  requestId: 'invalid_request',
} satisfies Limits['fields'];
