import { z } from 'zod';
import { canonical, check, digest, envName, MervError, RESERVED_KEYS } from '@merv/contracts';
import type {
  Data,
  WorkflowAssignmentContent,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowExecution,
  WorkflowExecutionPolicy,
  WorkflowExecutionReferences,
} from '@merv/contracts';
import { toolName, valid } from './definition.js';
import { executionArgument } from './execution.js';
import { DATA_LIMITS, freezeData, workflowJson } from './json.js';

const field = envName.refine((value) => !RESERVED_KEYS.includes(value));
const binding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('literal'),
      value: z.custom<unknown>((value) => value !== undefined),
    })
    .strict(),
  z
    .object({ kind: z.literal('target'), field: z.enum(['instanceId', 'revision', 'projectId']) })
    .strict(),
  z.object({ kind: z.literal('reference'), name: field }).strict(),
  z.object({ kind: z.literal('oneOf'), name: field }).strict(),
  z.object({ kind: z.literal('subset'), name: field }).strict(),
]);
const workspaceNamespace = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/)
  .refine((value) => !['.', '..'].includes(value));
const workspaceBase = z.union([
  z.literal('central'),
  z
    .string()
    .startsWith('reference:')
    .refine((value) => field.safeParse(value.slice('reference:'.length)).success),
]);
/** Which workspace driver prepares the checkout; opaque here. Absent means the runner's own. */
const workspaceDriver = z
  .string()
  .regex(/^[a-z][a-z0-9.]{0,39}$/)
  .optional();
const workspaceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('ephemeral'),
      namespace: workspaceNamespace,
      base: workspaceBase,
      retain: z.boolean(),
      driver: workspaceDriver,
    })
    .strict(),
  z
    .object({
      mode: z.literal('persistent'),
      namespace: workspaceNamespace,
      base: workspaceBase,
      perBase: z.boolean(),
      retain: z.boolean(),
      advancesCentral: z.boolean(),
      driver: workspaceDriver,
    })
    .strict(),
]);
const policySchema = z
  .object({
    readOnly: z.boolean(),
    workspace: workspaceSchema.optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(toolName),
            alternatives: z.array(z.record(field, binding)).min(1).max(32),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
const referencesSchema = z.record(
  field,
  z.union([z.string().min(1), z.array(z.string().min(1)).max(4096)]),
);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function json<T>(value: T, code: string, status: number): T {
  return workflowJson(value, code, status, DATA_LIMITS);
}

export function executionMetadata<T>(value: T): T {
  return json(value, 'invalid_workflow_policy', 500);
}

export function validateExecution(value: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  const parsed = policySchema.safeParse(json(value, 'invalid_workflow_policy', 400));
  valid(parsed.success, 'Invalid fixed execution manifest');
  const names = parsed.data.tools.map((tool) => tool.name);
  valid(new Set(names).size === names.length, 'Execution tool names must be unique');
  const tools = parsed.data.tools
    .map((tool) => {
      const alternatives = tool.alternatives.map((value) => JSON.parse(canonical(value)));
      const keys = alternatives.map(canonical);
      valid(new Set(keys).size === keys.length, 'Execution alternatives must be distinct');
      alternatives.sort((a, b) => compare(canonical(a), canonical(b)));
      return { name: tool.name, alternatives };
    })
    .sort((a, b) => compare(a.name, b.name));
  valid(
    !parsed.data.readOnly ||
      parsed.data.workspace?.mode !== 'persistent' ||
      !parsed.data.workspace.advancesCentral,
    'Read-only execution cannot publish a central workspace advance',
  );
  return freezeData({
    readOnly: parsed.data.readOnly,
    ...(parsed.data.workspace === undefined ? {} : { workspace: parsed.data.workspace }),
    tools,
  }) as WorkflowExecutionPolicy;
}

export function executionFingerprint(policy: WorkflowExecutionPolicy | null): string {
  return digest({ formatVersion: 1, policy });
}

export async function executionReferences(
  rule: WorkflowAssignmentRule,
  context: WorkflowCheckContext,
): Promise<WorkflowExecutionReferences> {
  const value = rule.references ? await rule.references(context) : {};
  const parsed = referencesSchema.safeParse(json(value, 'invalid_workflow_policy', 500));
  check(parsed.success, 'invalid_workflow_policy', 'Invalid execution reference metadata', 500);
  return parsed.data;
}

/** Stable tool names come from declarations; readiness and prompt sources cannot add grants. */
export function executionDisplay(
  execution: WorkflowExecution,
): WorkflowAssignmentContent['execution'] {
  return {
    readOnly: execution.policy.readOnly,
    policy: structuredClone(execution.policy),
    policyHash: execution.policyHash,
    registrationId: execution.registrationId,
    tools: execution.policy.tools.map((tool) => {
      const candidates = tool.alternatives.map((alternative) => {
        const args: Data = {};
        for (const [field, binding] of Object.entries(alternative)) {
          if (binding.kind === 'oneOf') {
            const values = execution.references[binding.name];
            if (Array.isArray(values) && values.length === 1) args[field] = values[0]!;
            continue;
          }
          if (binding.kind === 'subset') continue;
          try {
            args[field] = structuredClone(executionArgument(binding, execution)) as Data[string];
          } catch (error) {
            if (!(error instanceof MervError) || error.code !== 'execution_reference_unavailable')
              throw error;
          }
        }
        return args;
      });
      const common: Data = {};
      for (const [field, value] of Object.entries(candidates[0]!))
        if (
          candidates.every(
            (args) => Object.hasOwn(args, field) && canonical(args[field]) === canonical(value),
          )
        )
          common[field] = value;
      return { name: tool.name, arguments: common };
    }),
  };
}
