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
/** An execution reference the workspace preparation resolves to an exact commit. */
const workspaceBase = z
  .string()
  .startsWith('reference:')
  .refine((value) => field.safeParse(value.slice('reference:'.length)).success);
/** Which workspace driver prepares the checkout; opaque here. */
const workspaceDriver = z.string().regex(/^[a-z][a-z0-9.]{0,39}$/);
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
      // Always false; registered versions' pinned fingerprints hold both.
      perBase: z.literal(false),
      retain: z.boolean(),
      advancesCentral: z.literal(false),
      driver: workspaceDriver,
    })
    .strict(),
]);
const policySchema = z
  .object({
    readOnly: z.boolean(),
    workspace: workspaceSchema.optional(),
    platform: z
      .object({
        harness: z.enum(['codex', 'claude']),
        model: z.string().min(1).max(200),
        effort: z.string().min(1).max(50),
      })
      .strict()
      .optional(),
    maxDurationSeconds: z.number().int().min(300).max(604800).optional(),
    maxModelTokens: z.number().int().min(1).max(1_000_000_000).optional(),
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

export function executionMetadata<T>(value: T): T {
  return workflowJson(value, 'invalid_workflow_policy', 500, DATA_LIMITS);
}

export function validateExecution(value: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  const parsed = policySchema.safeParse(
    workflowJson(value, 'invalid_workflow_policy', 400, DATA_LIMITS),
  );
  valid(parsed.success, 'Invalid fixed execution manifest');
  const names = parsed.data.tools.map((tool) => tool.name);
  valid(new Set(names).size === names.length, 'Execution tool names must be unique');
  const tools = parsed.data.tools
    .map((tool) => {
      const alternatives = tool.alternatives.map(canonical);
      valid(
        new Set(alternatives).size === alternatives.length,
        'Execution alternatives must be distinct',
      );
      return {
        name: tool.name,
        alternatives: alternatives.sort(compare).map((value) => JSON.parse(value)),
      };
    })
    .sort((a, b) => compare(a.name, b.name));
  return freezeData({
    readOnly: parsed.data.readOnly,
    ...(parsed.data.workspace === undefined ? {} : { workspace: parsed.data.workspace }),
    ...(parsed.data.platform === undefined ? {} : { platform: parsed.data.platform }),
    ...(parsed.data.maxDurationSeconds === undefined
      ? {}
      : { maxDurationSeconds: parsed.data.maxDurationSeconds }),
    ...(parsed.data.maxModelTokens === undefined
      ? {}
      : { maxModelTokens: parsed.data.maxModelTokens }),
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
  const parsed = referencesSchema.safeParse(executionMetadata(value));
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
