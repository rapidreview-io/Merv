import { z } from 'zod';
import { check, mapAsync, MervError, stateFault } from '@merv/contracts';
import type {
  WorkflowActionRule,
  WorkflowActionStatus,
  WorkflowCheckContext,
  WorkflowDecision,
  WorkflowDependency,
  WorkflowDefinition,
  WorkflowEvaluationInput,
  WorkflowLimitStatus,
  WorkflowPolicy,
  WorkflowProvidedBlocker,
  WorkflowAssignmentRule,
  WorkflowWorkStart,
} from '@merv/contracts';
import { identifier, toolName, valid } from './definition.js';
import { freezeData, workflowJson } from './json.js';
import { requireDependencies } from './dependencies.js';
import { validateExecution } from './execution.js';
import { limitMessage, validateLimits } from './limits.js';

const descriptionSchema = z.object({
  label: z.string(),
  gate: z.string().optional(),
  waiting: z.string().optional(),
  references: z.array(
    z.object({ kind: z.string(), id: z.string(), label: z.string() }).passthrough(),
  ),
});

function callback(value: unknown): void {
  valid(typeof value === 'function', 'Workflow callbacks must be functions');
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
  valid(Array.isArray(policy.actions), 'Workflow actions are required');
  if (policy.successStates !== undefined)
    valid(
      Array.isArray(policy.successStates) &&
        policy.successStates.length > 0 &&
        new Set(policy.successStates).size === policy.successStates.length &&
        policy.successStates.every((state) => definition.terminal.includes(state)),
      'Success states must be distinct declared terminal states',
    );
  const names = new Set<string>();
  const guarded = new Set<string>();
  const actions = policy.actions.map((action) => {
    valid(
      typeof action.name === 'string' && identifier.test(action.name) && !names.has(action.name),
      'Action names must be unique identifiers',
    );
    names.add(action.name);
    valid(
      typeof action.tool === 'string' &&
        toolName.test(action.tool) &&
        typeof action.instruction === 'string' &&
        action.instruction.trim(),
      'Each action needs a tool and instructions',
    );
    valid(
      Array.isArray(action.states) &&
        action.states.length &&
        new Set(action.states).size === action.states.length &&
        action.states.every(
          (state) => definition.states.includes(state) && !definition.terminal.includes(state),
        ),
      'Action states must be declared nonterminal states',
    );
    valid(
      action.suggested === undefined || typeof action.suggested === 'boolean',
      'suggested must be boolean',
    );
    valid(
      action.requiresDependencies === undefined || typeof action.requiresDependencies === 'boolean',
      'requiresDependencies must be boolean',
    );
    const transitions = action.transitions ?? [];
    const requiredInput = action.requiredInput ?? [];
    valid(
      Array.isArray(transitions) && new Set(transitions).size === transitions.length,
      'Transition mappings must be unique',
    );
    if (typeof requiredInput === 'function') callback(requiredInput);
    else inputFields(requiredInput);
    for (const transition of transitions) {
      const edges = definition.edges.filter(
        (edge) => edge.action === transition && action.states.includes(edge.from),
      );
      valid(edges.length, `Unknown transition mapping: ${transition}`);
      for (const edge of edges) {
        const key = `${edge.from}:${edge.action}`;
        valid(!guarded.has(key), `Multiple rules own ${key}`);
        guarded.add(key);
      }
    }
    callback(action.check);
    if (action.arguments) callback(action.arguments);
    return {
      ...action,
      states: [...action.states],
      transitions: [...transitions],
      requiredInput: typeof requiredInput === 'function' ? requiredInput : [...requiredInput],
    };
  });
  valid(
    definition.edges.every((edge) => guarded.has(`${edge.from}:${edge.action}`)),
    'A registered policy must guard every graph transition',
  );
  if (policy.describe) callback(policy.describe);
  if (policy.children) callback(policy.children);
  valid(
    policy.assignments === undefined || Array.isArray(policy.assignments),
    'Assignments must be an array',
  );
  const assignmentStates = new Set<string>();
  const assignments = policy.assignments?.map((assignment) => {
    valid(
      assignment &&
        definition.states.includes(assignment.state) &&
        !definition.terminal.includes(assignment.state) &&
        !assignmentStates.has(assignment.state),
      'Assignments must name distinct declared nonterminal states',
    );
    assignmentStates.add(assignment.state);
    valid(
      assignment.requiresDependencies === undefined ||
        typeof assignment.requiresDependencies === 'boolean',
      'requiresDependencies must be boolean',
    );
    callback(assignment.check);
    callback(assignment.build);
    if (assignment.references !== undefined) callback(assignment.references);
    if (assignment.lease !== undefined) {
      valid(
        assignment.lease && typeof assignment.lease === 'object',
        'Lease hooks must be an object',
      );
      callback(assignment.lease.role);
      if (assignment.lease.label !== undefined) callback(assignment.lease.label);
      callback(assignment.lease.acquire);
      callback(assignment.lease.check);
      if (assignment.lease.outputs) callback(assignment.lease.outputs);
      callback(assignment.lease.release);
      valid(assignment.execution !== undefined, 'Leasing requires fixed execution authority');
    }
    const execution =
      assignment.execution === undefined ? undefined : validateExecution(assignment.execution);
    valid(
      assignment.references === undefined || execution !== undefined,
      'Execution references require a fixed execution manifest',
    );
    valid(
      !execution?.tools.some((tool) =>
        tool.alternatives.some((alternative) =>
          Object.values(alternative).some((binding) =>
            ['reference', 'oneOf', 'subset'].includes(binding.kind),
          ),
        ),
      ) || assignment.references !== undefined,
      'Named execution bindings require a metadata reference resolver',
    );
    return {
      ...assignment,
      ...(execution === undefined ? {} : { execution }),
      ...(assignment.lease ? { lease: { ...assignment.lease } } : {}),
    };
  });
  valid(
    !assignments?.length || !names.has('begin'),
    'The begin action is reserved for workflow assignments',
  );
  valid(
    policy.dependencyFailureAction === undefined || names.has(policy.dependencyFailureAction),
    'Dependency failure action must name a registered action',
  );
  const limits =
    policy.limits === undefined ? undefined : validateLimits(definition, policy.limits);
  return {
    actions,
    describe: policy.describe,
    ...(policy.children === undefined ? {} : { children: policy.children }),
    ...(limits === undefined ? {} : { limits }),
    ...(assignments === undefined ? {} : { assignments }),
    ...(policy.successStates === undefined
      ? {}
      : { successStates: [...policy.successStates].sort() }),
    ...(policy.limitExtended ? { limitExtended: policy.limitExtended } : {}),
    ...(policy.dependencyFailureAction === undefined
      ? {}
      : { dependencyFailureAction: policy.dependencyFailureAction }),
  };
}

/** The engine always supplies the dependencies it has read; programs see them as optional. */
export type EngineContext = WorkflowCheckContext & { dependencies: WorkflowDependency[] };

/** Never hand a callback the engine's mutable state or the caller's argument object. */
export function readContext<C extends WorkflowCheckContext>(context: C): C {
  const { tx, ...data } = context;
  return Object.freeze({ ...freezeData(structuredClone(data)), tx }) as unknown as C;
}

/**
 * A callback's refusal is read as a blocker; a State fault never is. A write under a read is a
 * broken program, and a conflicting, busy or closed store says nothing about the work.
 */
export function throwStateFault(error: MervError): void {
  if (error.code === 'read_only_scope')
    throw new MervError(
      'invalid_workflow_policy',
      'Workflow callbacks must not write while the workflow is read',
      500,
    );
  if (stateFault(error)) throw error;
}

export async function evaluateAction(
  rule: WorkflowActionRule,
  context: EngineContext,
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
    result.arguments = workflowJson(rule.arguments ? await rule.arguments(context) : {});
    check(
      result.arguments && typeof result.arguments === 'object' && !Array.isArray(result.arguments),
      'invalid_workflow_policy',
      'Workflow arguments must be a JSON object',
      500,
    );
    // A leased worker's call is made with these arguments bound over whatever it typed, so a
    // question about that call is answered against the same thing: a reviewer asking whether
    // submit_review was ready was told its claim was stale, because the claim is bound rather
    // than typed, while the call it was asking about succeeded. Nobody else has bindings, so
    // for every other caller the question is answered against exactly what it typed.
    await rule.check(
      context.caller.session && context.input !== undefined
        ? { ...context, input: { ...context.input, ...(result.arguments as object) } }
        : context,
    );
    if (rule.requiresDependencies) requireDependencies(context.dependencies);
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
        message: `Supply ${result.requiredInput.join(', ')} and a stable requestId when calling ${rule.tool}.`,
      });
    }
  } catch (error) {
    if (!(error instanceof MervError) || error.status >= 500) throw error;
    throwStateFault(error);
    result.status = 'blocked';
    result.blockers.push({ code: error.code, message: error.message, status: error.status });
  }
  return result;
}

export async function enforceAction(
  rule: WorkflowActionRule,
  context: EngineContext,
): Promise<void> {
  const result = await evaluateAction(rule, context);
  const blocker = result.blockers[0];
  if (blocker) throw new MervError(blocker.code, blocker.message, blocker.status);
}

/** Node admission is independent of whether its completion action has enough evidence. */
export async function checkAssignment(
  rule: WorkflowAssignmentRule,
  context: EngineContext,
): Promise<void> {
  await rule.check(context);
  if (rule.requiresDependencies) requireDependencies(context.dependencies);
}

/**
 * What another plugin published outranks the owner's next step, because the owner's hooks
 * will refuse that step for the same reason and an overview that called the work ready
 * would send someone to find that out. A named action is still answered on its own terms,
 * so ending blocked work stays possible, and the two gates under which nothing is
 * dispatched anyway keep their own explanation. Without `checks` no program callback runs.
 */
export async function decision(
  definition: WorkflowDefinition,
  policy: WorkflowPolicy | undefined,
  context: EngineContext,
  query: WorkflowEvaluationInput,
  workStart: WorkflowWorkStart | null = null,
  limits: WorkflowLimitStatus[] = [],
  provided: WorkflowProvidedBlocker[] = [],
  checks = true,
): Promise<WorkflowDecision> {
  const result = await ownDecision(definition, policy, context, query, workStart, limits, checks);
  result.providerBlockers = structuredClone(provided);
  if (
    !provided.length ||
    result.terminal ||
    !result.available ||
    query.action ||
    ['dependency_failed', 'loop_limit_reached'].includes(result.currentGate)
  )
    return result;
  result.nextAction = null;
  result.currentGate = provided[0].code;
  result.blockers = [
    ...provided.map(({ code, message, status }) => ({ code, message, status })),
    ...result.blockers,
  ];
  result.instruction = `${provided[0].message} ${provided[0].next}`;
  return result;
}

async function ownDecision(
  definition: WorkflowDefinition,
  policy: WorkflowPolicy | undefined,
  context: EngineContext,
  query: WorkflowEvaluationInput,
  workStart: WorkflowWorkStart | null,
  limits: WorkflowLimitStatus[],
  checks: boolean,
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
    providerBlockers: [],
    references: [],
    dependencies: structuredClone(context.dependencies),
    limits: [],
    workStart: workStart === null ? null : structuredClone(workStart),
  };
  let gate: string | undefined;
  let waiting: string | undefined;
  if (checks && policy?.describe) {
    const description = workflowJson(
      await policy.describe(context),
      'invalid_workflow_policy',
      500,
      {
        undefined: 'omit-root',
      },
    );
    check(
      descriptionSchema.safeParse(description).success,
      'invalid_workflow_policy',
      'Invalid workflow description',
      500,
    );
    result.label = description.label;
    result.references = description.references;
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
  result.limits = structuredClone(limits);
  // Every return a limit allows has been used. The actions stay as they are, because a human
  // may still accept or end the work; what changes is that the read says why nothing more
  // will happen by itself. A failed prerequisite is the stronger reason and keeps its gate.
  const exhausted = query.action ? undefined : limits.find((limit) => limit.exhausted);
  const escalate = (): WorkflowDecision => {
    if (!exhausted || result.currentGate === 'dependency_failed') return result;
    const message = limitMessage(exhausted, snapshot.workflow);
    result.currentGate = 'loop_limit_reached';
    result.blockers = [{ code: 'loop_limit_reached', status: 409, message }, ...result.blockers];
    result.instruction = `${message} ${result.instruction}`;
    return result;
  };
  const rules = policy.actions.filter((rule) => rule.states.includes(snapshot.state));
  const assignment = policy.assignments?.find((rule) => rule.state === snapshot.state);
  // A worker received its assignment with its lease and holds no workflow.begin, so begin is
  // neither offered to it nor answered for it.
  const beginOffered = !!assignment && !context.caller.session;
  if (query.action)
    check(
      rules.some((rule) => rule.name === query.action) ||
        (query.action === 'begin' && beginOffered),
      'invalid_action',
      'Action is unavailable in this workflow state',
      409,
    );
  // Unchecked, the record alone says where the work stands: no action carries a status, and
  // the gate is the state, or a prerequisite still open or failed where every step offered
  // here waits on it, or every return used.
  if (!checks) {
    const offered = rules.filter((rule) => rule.suggested !== false);
    if (offered.length && offered.every((rule) => rule.requiresDependencies))
      try {
        requireDependencies(context.dependencies);
      } catch (error) {
        if (!(error instanceof MervError)) throw error;
        result.currentGate = error.code;
        result.instruction = error.message;
        result.blockers = [{ code: error.code, message: error.message, status: error.status }];
      }
    return escalate();
  }
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
  // Guidance checks admission only. Building a packet may itself read guidance.
  // beginOffered implies an assignment; testing both narrows `assignment` for the packet below.
  if (assignment && beginOffered) {
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
      throwStateFault(error);
      begin.status = 'blocked';
      begin.blockers = [{ code: error.code, message: error.message, status: error.status }];
    }
    result.actions.push(begin);
    if (query.action === 'begin') candidates = [begin];
    if (!query.action && !workStart && begin.status === 'ready') {
      result.nextAction = begin;
      result.currentGate = gate ?? snapshot.state;
      result.instruction = begin.instruction;
      return escalate();
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
      requireDependencies(context.dependencies);
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
  return escalate();
}
