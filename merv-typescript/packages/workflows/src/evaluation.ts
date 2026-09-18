import { check, mapAsync, MervError } from '@merv/contracts';
import type {
  WorkflowActionRule,
  WorkflowActionStatus,
  WorkflowCheckContext,
  WorkflowDecision,
  WorkflowDefinition,
  WorkflowEvaluationInput,
  WorkflowPolicy,
  WorkflowAssignmentRule,
  WorkflowWorkStart,
} from '@merv/contracts';
import { canonical } from './definition.js';
import { requireDependencies } from './dependencies.js';
import { validateExecution } from './execution.js';

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
// Match the public Tools naming contract, including reserved mounted namespaces.
const toolName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

function callback(value: unknown): void {
  check(
    typeof value === 'function',
    'invalid_workflow_policy',
    'Workflow callbacks must be functions',
  );
}

function inputFields(value: unknown, status = 400): asserts value is string[] {
  check(
    Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((name) => typeof name === 'string' && identifier.test(name)),
    'invalid_workflow_policy',
    'Input fields must be unique identifiers',
    status,
  );
}

/** Graph JSON remains version-pinned; callbacks are deployed program code, like command handlers. */
export function validatePolicy(
  definition: WorkflowDefinition,
  policy?: WorkflowPolicy,
): WorkflowPolicy | undefined {
  if (!policy) return;
  check(Array.isArray(policy.actions), 'invalid_workflow_policy', 'Workflow actions are required');
  if (policy.successStates !== undefined)
    check(
      Array.isArray(policy.successStates) &&
        policy.successStates.length > 0 &&
        new Set(policy.successStates).size === policy.successStates.length &&
        policy.successStates.every((state) => definition.terminal.includes(state)),
      'invalid_workflow_policy',
      'Success states must be distinct declared terminal states',
    );
  const names = new Set<string>();
  const guarded = new Set<string>();
  const actions = policy.actions.map((action) => {
    check(
      typeof action.name === 'string' && identifier.test(action.name) && !names.has(action.name),
      'invalid_workflow_policy',
      'Action names must be unique identifiers',
    );
    names.add(action.name);
    check(
      typeof action.tool === 'string' &&
        toolName.test(action.tool) &&
        typeof action.instruction === 'string' &&
        action.instruction.trim(),
      'invalid_workflow_policy',
      'Each action needs a tool and instructions',
    );
    check(
      Array.isArray(action.states) &&
        action.states.length &&
        new Set(action.states).size === action.states.length &&
        action.states.every(
          (state) => definition.states.includes(state) && !definition.terminal.includes(state),
        ),
      'invalid_workflow_policy',
      'Action states must be declared nonterminal states',
    );
    check(
      action.suggested === undefined || typeof action.suggested === 'boolean',
      'invalid_workflow_policy',
      'suggested must be boolean',
    );
    check(
      action.requiresDependencies === undefined || typeof action.requiresDependencies === 'boolean',
      'invalid_workflow_policy',
      'requiresDependencies must be boolean',
    );
    const transitions = action.transitions ?? [];
    const requiredInput = action.requiredInput ?? [];
    check(
      Array.isArray(transitions) && new Set(transitions).size === transitions.length,
      'invalid_workflow_policy',
      'Transition mappings must be unique',
    );
    if (typeof requiredInput === 'function') callback(requiredInput);
    else inputFields(requiredInput);
    for (const transition of transitions) {
      const edges = definition.edges.filter(
        (edge) => edge.action === transition && action.states.includes(edge.from),
      );
      check(edges.length, 'invalid_workflow_policy', `Unknown transition mapping: ${transition}`);
      for (const edge of edges) {
        const key = `${edge.from}:${edge.action}`;
        check(!guarded.has(key), 'invalid_workflow_policy', `Multiple rules own ${key}`);
        guarded.add(key);
      }
    }
    callback(action.check);
    if (action.arguments) callback(action.arguments);
    return Object.freeze({
      ...action,
      states: Object.freeze([...action.states]) as unknown as string[],
      transitions: Object.freeze([...transitions]) as unknown as string[],
      requiredInput:
        typeof requiredInput === 'function'
          ? requiredInput
          : (Object.freeze([...requiredInput]) as unknown as string[]),
    });
  });
  check(
    definition.edges.every((edge) => guarded.has(`${edge.from}:${edge.action}`)),
    'invalid_workflow_policy',
    'A registered policy must guard every graph transition',
  );
  if (policy.describe) callback(policy.describe);
  check(
    policy.assignments === undefined || Array.isArray(policy.assignments),
    'invalid_workflow_policy',
    'Assignments must be an array',
  );
  const assignmentStates = new Set<string>();
  const assignments = policy.assignments?.map((assignment) => {
    check(
      assignment &&
        definition.states.includes(assignment.state) &&
        !definition.terminal.includes(assignment.state) &&
        !assignmentStates.has(assignment.state),
      'invalid_workflow_policy',
      'Assignments must name distinct declared nonterminal states',
    );
    assignmentStates.add(assignment.state);
    check(
      assignment.requiresDependencies === undefined ||
        typeof assignment.requiresDependencies === 'boolean',
      'invalid_workflow_policy',
      'requiresDependencies must be boolean',
    );
    callback(assignment.check);
    callback(assignment.build);
    if (assignment.references !== undefined) callback(assignment.references);
    if (assignment.lease !== undefined) {
      check(
        assignment.lease && typeof assignment.lease === 'object',
        'invalid_workflow_policy',
        'Lease hooks must be an object',
      );
      callback(assignment.lease.role);
      if (assignment.lease.label !== undefined) callback(assignment.lease.label);
      callback(assignment.lease.acquire);
      callback(assignment.lease.check);
      if (assignment.lease.outputs) callback(assignment.lease.outputs);
      callback(assignment.lease.release);
      check(
        assignment.execution !== undefined,
        'invalid_workflow_policy',
        'Leasing requires fixed execution authority',
      );
    }
    const execution =
      assignment.execution === undefined ? undefined : validateExecution(assignment.execution);
    check(
      assignment.references === undefined || execution !== undefined,
      'invalid_workflow_policy',
      'Execution references require a fixed execution manifest',
    );
    check(
      !execution?.tools.some((tool) =>
        tool.alternatives.some((alternative) =>
          Object.values(alternative).some((binding) =>
            ['reference', 'oneOf', 'subset'].includes(binding.kind),
          ),
        ),
      ) || assignment.references !== undefined,
      'invalid_workflow_policy',
      'Named execution bindings require a metadata reference resolver',
    );
    return Object.freeze({
      ...assignment,
      ...(execution === undefined ? {} : { execution }),
      ...(assignment.lease ? { lease: Object.freeze({ ...assignment.lease }) } : {}),
    });
  });
  check(
    !assignments?.length || !names.has('begin'),
    'invalid_workflow_policy',
    'The begin action is reserved for workflow assignments',
  );
  check(
    policy.dependencyFailureAction === undefined || names.has(policy.dependencyFailureAction),
    'invalid_workflow_policy',
    'Dependency failure action must name a registered action',
  );
  return Object.freeze({
    actions: Object.freeze(actions) as unknown as WorkflowActionRule[],
    describe: policy.describe,
    ...(assignments === undefined
      ? {}
      : { assignments: Object.freeze(assignments) as unknown as WorkflowAssignmentRule[] }),
    ...(policy.successStates === undefined
      ? {}
      : { successStates: Object.freeze([...policy.successStates].sort()) as unknown as string[] }),
    ...(policy.dependencyFailureAction === undefined
      ? {}
      : { dependencyFailureAction: policy.dependencyFailureAction }),
  });
}

/** Never hand a callback the engine's mutable state or the caller's argument object. */
export function readContext(context: WorkflowCheckContext): WorkflowCheckContext {
  const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return Object.freeze({
    ...context,
    caller: freeze(structuredClone(context.caller)),
    snapshot: freeze(structuredClone(context.snapshot)),
    ...(context.dependencies === undefined
      ? {}
      : { dependencies: freeze(structuredClone(context.dependencies)) }),
    ...(context.input === undefined ? {} : { input: freeze(structuredClone(context.input)) }),
  });
}

export async function evaluateAction(
  rule: WorkflowActionRule,
  context: WorkflowCheckContext,
): Promise<WorkflowActionStatus> {
  const result: WorkflowActionStatus = {
    action: rule.name,
    tool: rule.tool,
    instruction: rule.instruction,
    status: 'ready',
    arguments: {},
    requiredInput: [],
    blockers: [],
  };
  try {
    await rule.check(context);
    if (rule.requiresDependencies) {
      check(
        context.dependencies !== undefined,
        'invalid_workflow_policy',
        'Dependency checks require an engine context',
        500,
      );
      requireDependencies(context.dependencies);
    }
    result.arguments = rule.arguments ? await rule.arguments(context) : {};
    check(
      result.arguments && typeof result.arguments === 'object' && !Array.isArray(result.arguments),
      'invalid_workflow_policy',
      'Workflow arguments must be a JSON object',
      500,
    );
    // Validate and detach returned data before exposing it to a caller.
    result.arguments = JSON.parse(canonical(result.arguments));
    const requiredInput =
      typeof rule.requiredInput === 'function'
        ? await rule.requiredInput(context)
        : (rule.requiredInput ?? []);
    inputFields(requiredInput, 500);
    result.requiredInput = requiredInput.filter(
      (key) => !Object.hasOwn(context.input ?? result.arguments, key),
    );
    if (result.requiredInput.length) {
      result.status = 'needs_input';
      result.blockers.push({
        code: 'input_required',
        status: 400,
        message: `Supply ${result.requiredInput.join(', ')} when calling ${rule.tool}.`,
      });
    }
  } catch (error) {
    if (!(error instanceof MervError) || error.status >= 500) throw error;
    result.status = 'blocked';
    result.blockers.push({ code: error.code, message: error.message, status: error.status });
  }
  return result;
}

export async function enforceAction(
  rule: WorkflowActionRule,
  context: WorkflowCheckContext,
): Promise<void> {
  const result = await evaluateAction(rule, context);
  const blocker = result.blockers[0];
  if (blocker) throw new MervError(blocker.code, blocker.message, blocker.status);
}

/** Node admission is independent of whether its completion action has enough evidence. */
export async function checkAssignment(
  rule: WorkflowAssignmentRule,
  context: WorkflowCheckContext,
): Promise<void> {
  await rule.check(context);
  if (rule.requiresDependencies) {
    check(
      context.dependencies !== undefined,
      'invalid_workflow_policy',
      'Dependency checks require an engine context',
      500,
    );
    requireDependencies(context.dependencies);
  }
}

export async function decision(
  definition: WorkflowDefinition,
  policy: WorkflowPolicy | undefined,
  context: WorkflowCheckContext,
  query: WorkflowEvaluationInput,
  workStart: WorkflowWorkStart | null = null,
): Promise<WorkflowDecision> {
  const snapshot = context.snapshot;
  const terminal = definition.terminal.includes(snapshot.state);
  const result: WorkflowDecision = {
    instanceId: snapshot.id,
    workflow: snapshot.workflow,
    version: snapshot.version,
    state: snapshot.state,
    revision: snapshot.revision,
    label: snapshot.workflow,
    terminal,
    available: !!policy,
    currentGate: snapshot.state,
    nextAction: null,
    instruction: '',
    actions: [],
    blockers: [],
    references: [],
    dependencies: structuredClone(context.dependencies ?? []),
    workStart: workStart === null ? null : structuredClone(workStart),
  };
  let gate: string | undefined;
  let waiting: string | undefined;
  if (policy?.describe) {
    const description = await policy.describe(context);
    check(
      typeof description.label === 'string' &&
        (description.gate === undefined || typeof description.gate === 'string') &&
        (description.waiting === undefined || typeof description.waiting === 'string') &&
        Array.isArray(description.references) &&
        description.references.every(
          (ref) =>
            typeof ref.kind === 'string' &&
            typeof ref.id === 'string' &&
            typeof ref.label === 'string',
        ),
      'invalid_workflow_policy',
      'Invalid workflow description',
      500,
    );
    result.label = description.label;
    result.references = JSON.parse(canonical(description.references));
    gate = description.gate;
    waiting = description.waiting;
  }
  if (terminal) {
    check(!query.action, 'invalid_action', 'This workflow has ended', 409);
    result.currentGate = 'terminal';
    result.instruction = 'This workflow has ended. No further action is required.';
    return result;
  }
  if (!policy) {
    result.currentGate = 'workflow_unavailable';
    result.instruction =
      'The owning program has no active guidance registration. Restore it before continuing.';
    result.blockers = [{ code: 'workflow_unavailable', status: 503, message: result.instruction }];
    return result;
  }
  const rules = policy.actions.filter((rule) => rule.states.includes(snapshot.state));
  const assignment = policy.assignments?.find((rule) => rule.state === snapshot.state);
  if (query.action)
    check(
      rules.some((rule) => rule.name === query.action) || (query.action === 'begin' && assignment),
      'invalid_action',
      'Action is unavailable in this workflow state',
      409,
    );
  result.actions = await mapAsync(
    rules,
    async (rule) =>
      await evaluateAction(
        rule,
        readContext({ ...context, input: rule.name === query.action ? query.input : undefined }),
      ),
  );
  let candidates = result.actions.filter((action, index) =>
    query.action ? action.action === query.action : rules[index].suggested !== false,
  );
  // Guidance checks admission only. Building a packet may itself read guidance. A worker
  // received its assignment with its lease and holds no workflow.begin, so none is offered.
  if (assignment && !context.caller.session) {
    const begin: WorkflowActionStatus = {
      action: 'begin',
      tool: 'workflow.begin',
      instruction: 'Begin this workflow step to receive its assignment and starting context.',
      status: 'ready',
      arguments: { instanceId: snapshot.id, expectedRevision: snapshot.revision },
      requiredInput: [],
      blockers: [],
    };
    try {
      await checkAssignment(assignment, context);
    } catch (error) {
      // Unavailable assignment resources are a blocker, not a failure to read the task.
      if (!(error instanceof MervError) || (error.status >= 500 && error.status !== 503))
        throw error;
      begin.status = 'blocked';
      begin.blockers = [{ code: error.code, message: error.message, status: error.status }];
    }
    result.actions.push(begin);
    if (query.action === 'begin') candidates = [begin];
    if (!query.action && !workStart && begin.status === 'ready') {
      result.nextAction = begin;
      result.currentGate = gate ?? snapshot.state;
      result.instruction = begin.instruction;
      return result;
    }
  }
  result.nextAction = candidates.find((action) => action.status !== 'blocked') ?? null;
  let dependencyBlocker = candidates
    .flatMap((action) => action.blockers)
    .find(
      (blocker) => blocker.code === 'dependency_failed' || blocker.code === 'dependencies_pending',
    );
  // An operator can understand why work waits even when its own completion
  // permission fails earlier. Recovery keeps its independently checked permission.
  if (
    !dependencyBlocker &&
    rules.some(
      (rule) =>
        rule.requiresDependencies &&
        (query.action ? rule.name === query.action : rule.suggested !== false),
    )
  ) {
    try {
      requireDependencies(context.dependencies ?? []);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
      dependencyBlocker = { code: error.code, message: error.message, status: error.status };
    }
  }
  if (
    !query.action &&
    !result.nextAction &&
    dependencyBlocker?.code === 'dependency_failed' &&
    policy.dependencyFailureAction
  ) {
    result.nextAction =
      result.actions.find(
        (action) => action.action === policy.dependencyFailureAction && action.status !== 'blocked',
      ) ?? null;
    if (result.nextAction) {
      result.currentGate = dependencyBlocker.code;
      result.blockers = [dependencyBlocker, ...result.nextAction.blockers];
      result.instruction = `${dependencyBlocker.message} ${result.nextAction.instruction}`;
      return result;
    }
  }
  if (result.nextAction) {
    result.currentGate =
      gate ?? (result.nextAction.status === 'needs_input' ? 'input_required' : snapshot.state);
    result.blockers = result.nextAction.blockers;
    result.instruction = result.nextAction.instruction;
  } else {
    result.currentGate = gate ?? 'waiting';
    result.blockers = candidates
      .flatMap((action) => action.blockers)
      .filter(
        (blocker, index, all) =>
          all.findIndex(
            (other) => other.code === blocker.code && other.message === blocker.message,
          ) === index,
      );
    if (query.action && result.blockers[0]) result.currentGate = result.blockers[0].code;
    result.instruction =
      waiting ??
      'No action is currently available to this actor. Check the blockers or wait for the responsible actor.';
    if (dependencyBlocker) {
      result.currentGate = dependencyBlocker.code;
      result.instruction = dependencyBlocker.message;
      if (!result.blockers.some((blocker) => blocker.code === dependencyBlocker.code))
        result.blockers.unshift(dependencyBlocker);
    }
  }
  return result;
}
