import type { WorkflowAssignment, WorkflowExecutionBinding } from './workflows.js';

/** Model-facing projection only. Frozen records, hashes and server authorization stay intact. */
export function agentAssignment(assignment: WorkflowAssignment) {
  if (!['experiment', 'task'].includes(assignment.workflow) || !assignment.execution.policy)
    return assignment;
  const {
    policy,
    policyHash: _hash,
    registrationId: _generation,
    ...execution
  } = assignment.execution;
  const { tools: grants, ...limits } = policy ?? { tools: [] };
  const binding = (value: WorkflowExecutionBinding) => {
    switch (value.kind) {
      case 'literal':
        return value.value;
      case 'target':
        return assignment[value.field];
      case 'reference':
        return `granted ${value.name}`;
      case 'oneOf':
        return `one of granted ${value.name}; see references`;
      case 'subset':
        return `subset of granted ${value.name}; see references`;
    }
  };
  const references = [
    ...new Map(
      [
        ...assignment.references,
        ...(assignment.context?.sources ?? []).map((a) => ({
          kind: 'artifact',
          id: a.id,
          label: a.title,
        })),
      ].map((ref) => [`${ref.kind}:${ref.id}`, ref]),
    ).values(),
  ];
  const context = assignment.context;
  let prompt = context?.prompt;
  for (const a of context?.sources ?? []) {
    prompt = prompt?.replaceAll(
      `artifact ${a.id}, ${a.mediaType}, ${a.size} bytes, sha256 ${a.hash}`,
      `${a.mediaType}, ${a.size} bytes`,
    );
  }
  return {
    ...assignment,
    references,
    execution: {
      ...execution,
      limits,
      tools: execution.tools.map((tool) => ({
        ...tool,
        ...(grants?.find((g) => g.name === tool.name) && {
          constraints: grants
            .find((g) => g.name === tool.name)!
            .alternatives.map((alternative) =>
              Object.fromEntries(
                Object.entries(alternative).map(([key, value]) => [key, binding(value)]),
              ),
            ),
        }),
      })),
    },
    context: context
      ? {
          type: context.type,
          typeVersion: context.typeVersion,
          prompt: prompt!,
          omitted: context.omitted,
        }
      : null,
  };
}
