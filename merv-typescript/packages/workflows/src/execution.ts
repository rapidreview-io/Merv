import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type {
  Data,
  Sql,
  WorkflowAssignmentContent,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowDefinition,
  WorkflowDispatchAdmission,
  WorkflowExecution,
  WorkflowExecutionBinding,
  WorkflowExecutionPolicy,
  WorkflowExecutionReferences,
  WorkflowPolicy,
} from '@merv/contracts';
import { canonical, fingerprint } from './definition.js';

const field = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
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
    .regex(/^reference:[A-Za-z_][A-Za-z0-9_]{0,127}$/)
    .refine((value) => field.safeParse(value.slice('reference:'.length)).success),
]);
const workspaceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('ephemeral'),
      namespace: workspaceNamespace,
      base: workspaceBase,
      retain: z.boolean(),
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
            name: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/),
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

/** Reject accessors, cycles and values JSON would silently erase at this provider boundary. */
function json<T>(value: T, code: string, status: number, limit = 256_000): T {
  let count = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    check(++count <= 16000 && depth <= 32, code, 'Execution metadata is too complex', status);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      check(Number.isFinite(item), code, 'Execution metadata must be finite JSON', status);
      return;
    }
    check(
      item && typeof item === 'object' && !ancestors.has(item),
      code,
      'Execution metadata must be acyclic JSON',
      status,
    );
    check(
      Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype,
      code,
      'Execution metadata must use plain JSON objects',
      status,
    );
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    check(
      keys.every((key) => typeof key === 'string'),
      code,
      'Execution metadata cannot contain symbols',
      status,
    );
    if (Array.isArray(item)) {
      check(
        item.length <= 16000 && keys.length === item.length + 1,
        code,
        'Execution arrays must be dense and contain no extra properties',
        status,
      );
      for (let i = 0; i < item.length; i++)
        check(Object.hasOwn(item, i), code, 'Execution arrays must be dense', status);
    }
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      check(
        'value' in descriptor && descriptor.enumerable,
        code,
        'Execution metadata cannot contain accessors or hidden properties',
        status,
      );
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = canonical(value);
  check(encoded.length <= limit, code, 'Input is too large', status);
  return JSON.parse(encoded) as T;
}

export function executionMetadata<T>(value: T): T {
  return json(value, 'invalid_workflow_policy', 500);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateExecution(value: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  const parsed = policySchema.safeParse(json(value, 'invalid_workflow_policy', 400));
  check(parsed.success, 'invalid_workflow_policy', 'Invalid fixed execution manifest');
  const names = parsed.data.tools.map((tool) => tool.name);
  check(
    new Set(names).size === names.length,
    'invalid_workflow_policy',
    'Execution tool names must be unique',
  );
  const tools = parsed.data.tools
    .map((tool) => {
      const alternatives = tool.alternatives.map((value) => JSON.parse(canonical(value)));
      const keys = alternatives.map(canonical);
      check(
        new Set(keys).size === keys.length,
        'invalid_workflow_policy',
        'Execution alternatives must be distinct',
      );
      alternatives.sort((a, b) => compare(canonical(a), canonical(b)));
      return { name: tool.name, alternatives };
    })
    .sort((a, b) => compare(a.name, b.name));
  check(
    !parsed.data.readOnly ||
      parsed.data.workspace?.mode !== 'persistent' ||
      !parsed.data.workspace.advancesCentral,
    'invalid_workflow_policy',
    'Read-only execution cannot publish a central workspace advance',
  );
  return freeze({
    readOnly: parsed.data.readOnly,
    ...(parsed.data.workspace === undefined ? {} : { workspace: parsed.data.workspace }),
    tools,
  }) as WorkflowExecutionPolicy;
}

/** Null is a pinned declaration too: omission must never restore dynamic dispatch grants. */
export async function persistExecution(
  sql: Sql,
  definition: WorkflowDefinition,
  policy?: WorkflowPolicy,
): Promise<void> {
  for (const state of definition.states.filter((state) => !definition.terminal.includes(state))) {
    const manifest = policy?.assignments?.find((rule) => rule.state === state)?.execution ?? null;
    const hash = executionFingerprint(manifest);
    const previous = await sql.get<{ fingerprint: string }>(
      'SELECT fingerprint FROM wf_execution_policies WHERE workflow=? AND version=? AND state=?',
      definition.name,
      definition.version,
      state,
    );
    check(
      !previous || previous.fingerprint === hash,
      'workflow_version_conflict',
      `Execution policy for ${definition.name}@${definition.version}/${state} changed; publish a new version`,
      409,
    );
    if (!previous)
      await sql.run(
        'INSERT INTO wf_execution_policies(workflow,version,state,fingerprint,manifest_json) VALUES(?,?,?,?,?)',
        definition.name,
        definition.version,
        state,
        hash,
        canonical(manifest),
      );
  }
}

export function executionFingerprint(policy: WorkflowExecutionPolicy | null): string {
  return fingerprint({ formatVersion: 1, policy });
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

function fixed(binding: WorkflowExecutionBinding, execution: WorkflowExecution): unknown {
  if (binding.kind === 'literal') return binding.value;
  if (binding.kind === 'target') return execution[binding.field];
  if (binding.kind === 'reference') {
    const reference = Object.hasOwn(execution.references, binding.name)
      ? execution.references[binding.name]
      : undefined;
    check(
      typeof reference === 'string',
      'execution_reference_unavailable',
      `Execution reference ${binding.name} is unavailable`,
      409,
    );
    return reference;
  }
  return undefined;
}

export function admitDispatch(
  execution: WorkflowExecution,
  tool: string,
  input: Data,
): WorkflowDispatchAdmission {
  const grant = execution.policy.tools.find((grant) => grant.name === tool);
  check(grant, 'execution_tool_forbidden', 'Tool is not declared for this workflow state', 403);
  // A worker's tool input is bounded like anyone's request body, not like policy metadata.
  const original = json(input, 'invalid_input', 400, 4_000_000);
  check(
    original && typeof original === 'object' && !Array.isArray(original),
    'invalid_input',
    'Tool input must be a JSON object',
  );
  const matches = new Map<string, Data>();
  const errors: MervError[] = [];
  for (const alternative of grant.alternatives) {
    try {
      const result = structuredClone(original);
      for (const [field, binding] of Object.entries(alternative)) {
        if (binding.kind === 'oneOf' || binding.kind === 'subset') {
          const values = Object.hasOwn(execution.references, binding.name)
            ? execution.references[binding.name]
            : undefined;
          check(
            Array.isArray(values),
            'execution_reference_unavailable',
            `Execution reference ${binding.name} is unavailable`,
            409,
          );
          // Omitting a subset means selecting no resources, never all available resources.
          if (binding.kind === 'subset' && !Object.hasOwn(result, field)) result[field] = [];
          check(
            Object.hasOwn(result, field),
            'execution_arguments_forbidden',
            `Choose ${field} from the declared execution references`,
            403,
          );
          const actual = result[field];
          check(
            binding.kind === 'oneOf'
              ? typeof actual === 'string' && values.includes(actual)
              : Array.isArray(actual) &&
                  actual.every((value) => typeof value === 'string' && values.includes(value)),
            'execution_arguments_forbidden',
            `${field} is outside the declared execution references`,
            403,
          );
        } else {
          const expected = fixed(binding, execution);
          if (Object.hasOwn(result, field))
            check(
              canonical(result[field]) === canonical(expected),
              'execution_arguments_forbidden',
              `${field} conflicts with this workflow assignment`,
              403,
            );
          else result[field] = structuredClone(expected) as Data[string];
        }
      }
      matches.set(canonical(result), result);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
      errors.push(error);
    }
  }
  check(
    matches.size <= 1,
    'execution_arguments_ambiguous',
    'Supply the fixed fields needed to select one execution alternative',
  );
  if (!matches.size)
    throw errors.find((error) => error.code === 'execution_arguments_forbidden') ?? errors[0]!;
  return { tool, input: [...matches.values()][0]! };
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
          if (binding.kind === 'oneOf' || binding.kind === 'subset') continue;
          try {
            args[field] = structuredClone(fixed(binding, execution)) as Data[string];
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
