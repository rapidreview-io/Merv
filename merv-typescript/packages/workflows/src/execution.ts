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
/** Values a refusal names: enough to drop exactly what was refused, never the whole input. */
const SHOWN = 10;
const label = (value: unknown) =>
  (typeof value === 'string' ? value : String(JSON.stringify(value))).slice(0, 200);
/**
 * The refusal of a choice outside its execution reference. It names the values at fault, so the
 * caller drops exactly those rather than guessing, and says what the reference holds. Only a
 * subset can drop them: a oneOf is a single value, and citing an id in a new artifact does not
 * make an earlier one readable.
 */
function outsideReferences(
  field: string,
  binding: { kind: 'oneOf' | 'subset'; name: string },
  outside: unknown[],
): MervError {
  const { name } = binding;
  const one = outside.length === 1;
  const more = outside.length > SHOWN ? ` and ${outside.length - SHOWN} more` : '';
  const advice =
    binding.kind === 'subset'
      ? ` Leave ${one ? 'it' : 'them'} out of ${field}${
          name === 'artifacts'
            ? '; to rely on an artifact from an earlier session, cite its id in one this session creates'
            : ''
        }.`
      : '';
  return new MervError(
    'execution_arguments_forbidden',
    `${field} is outside the declared execution references: ${outside
      .slice(0, SHOWN)
      .map(label)
      .join(', ')}${more} ${one ? 'is' : 'are'} not among this assignment's ${name}, which ${
      name === 'artifacts'
        ? 'hold what the assignment declared and the artifacts this session created'
        : 'hold only what the assignment declared'
    }.${advice}`,
    403,
    { field, reference: name, outside: outside.slice(0, 100).map(label) },
  );
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
            binding.kind === 'oneOf' || Array.isArray(actual),
            'execution_arguments_forbidden',
            `${field} must be a list chosen from this assignment's ${binding.name}`,
            403,
          );
          const outside = [
            ...new Set(binding.kind === 'oneOf' ? [actual] : (actual as unknown[])),
          ].filter((value) => typeof value !== 'string' || !values.includes(value));
          if (outside.length) throw outsideReferences(field, binding, outside);
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
