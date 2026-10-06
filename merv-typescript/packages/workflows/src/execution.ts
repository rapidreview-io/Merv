/** Pure dispatch admission under a frozen execution: no service, safe for any unit to run. */
import { canonical, check, MervError } from '@merv/contracts';
import type { Data, WorkflowExecution, WorkflowExecutionBinding } from '@merv/contracts';

export interface WorkflowDispatchAdmission {
  tool: string;
  input: Data;
}
/** The value a fixed binding gives its argument; a oneOf or subset choice gives none. */
export function executionArgument(
  binding: WorkflowExecutionBinding,
  execution: WorkflowExecution,
): unknown {
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
/**
 * Admits one tool call under an execution: a declared tool, with arguments its bindings allow
 * and fill in. The input is a detached JSON object its caller has bounded; each alternative
 * binds its own copy.
 */
export function admitDispatch(
  execution: WorkflowExecution,
  tool: string,
  original: Data,
): WorkflowDispatchAdmission {
  const grant = execution.policy.tools.find((grant) => grant.name === tool);
  check(grant, 'execution_tool_forbidden', 'Tool is not declared for this workflow state', 403);
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
          // A choice among one reference is no choice: an omitted field takes it.
          if (binding.kind === 'oneOf' && !Object.hasOwn(result, field) && values.length === 1)
            result[field] = values[0]!;
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
          const expected = executionArgument(binding, execution);
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
