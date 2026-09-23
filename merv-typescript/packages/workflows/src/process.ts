import type {
  ProcessEdge,
  ProcessGraph,
  ProcessNode,
  WorkflowActionRule,
  WorkflowDecision,
  WorkflowDefinition,
  WorkflowDependency,
  WorkflowHistoryEntry,
} from '@merv/contracts';

/**
 * The process graph: deployed program code plus the record, derived on read and nothing
 * else. Skeleton from the pinned definition, traversals from wf_history, live status from
 * the same decision the real transition checks, dependency edges from recorded composition.
 * Per-kind detail stays in the domain reads; an edge here means the machinery stepped
 * through a gate, never that the science is right.
 */
export function processGraph(source: {
  definition: WorkflowDefinition;
  rules: WorkflowActionRule[];
  history: WorkflowHistoryEntry[];
  decision: WorkflowDecision;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
}): ProcessGraph {
  const { definition, decision, history } = source;
  // Exactly one rule owns each from:action pair, and a rule may own several transitions,
  // so a review's return edges carry the same live status as the pass beside them.
  const live = (edge: WorkflowDefinition['edges'][number]) => {
    if (edge.from !== decision.state) return undefined;
    const rule = source.rules.find(
      (item) => item.states.includes(edge.from) && (item.transitions ?? []).includes(edge.action),
    );
    return decision.actions.find((item) => item.action === rule?.name);
  };
  const edges: ProcessEdge[] = definition.edges.map((edge) => {
    const status = live(edge);
    return {
      ...edge,
      traversals: history
        .filter(
          (row) =>
            row.action === edge.action && row.fromState === edge.from && row.toState === edge.to,
        )
        .map((row) => ({
          revision: row.revision,
          actorId: row.actorId,
          requestId: row.requestId,
          at: row.createdAt,
        })),
      status: status?.status ?? null,
      tool: status?.tool ?? null,
      blockers: status?.blockers ?? [],
    };
  });
  // Reading order, derived: a walk forward from the initial state, ends last. The stored
  // definition is sorted alphabetically for its fingerprint, which is not an order to read in.
  const walk = [definition.initial];
  for (let index = 0; index < walk.length; index++)
    for (const edge of definition.edges)
      if (edge.from === walk[index] && !walk.includes(edge.to)) walk.push(edge.to);
  const reachable = [...walk, ...definition.states.filter((state) => !walk.includes(state))];
  // Arrivals are counted across edges only: the initial state begins with none, so any
  // entry it has is a return, and a start or a dependency row is not an arrival.
  const nodes: ProcessNode[] = [
    ...reachable.filter((state) => !definition.terminal.includes(state)),
    ...reachable.filter((state) => definition.terminal.includes(state)),
  ].map((state) => {
    const arrivals = edges
      .filter((edge) => edge.to === state)
      .flatMap((edge) => edge.traversals)
      .sort((a, b) => a.revision - b.revision);
    return {
      state,
      initial: state === definition.initial,
      terminal: definition.terminal.includes(state),
      current: state === decision.state,
      entries: arrivals.length,
      firstEnteredAt:
        (state === definition.initial
          ? history.find((row) => row.fromState === null)?.createdAt
          : undefined) ??
        arrivals[0]?.at ??
        null,
      blockers: state === decision.state ? decision.blockers : [],
    };
  });
  return {
    instanceId: decision.instanceId,
    workflow: decision.workflow,
    version: decision.version,
    revision: decision.revision,
    state: decision.state,
    currentGate: decision.currentGate,
    terminal: decision.terminal,
    nodes,
    edges,
    dependencies: [
      ...source.dependencies.map((item) => ({ direction: 'depends_on' as const, ...item })),
      ...source.dependents.map((item) => ({ direction: 'required_by' as const, ...item })),
    ],
  };
}
