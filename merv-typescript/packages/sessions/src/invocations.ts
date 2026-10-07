import { AsyncLocalStorage } from 'node:async_hooks';
import {
  canonical,
  check,
  MervError,
  newId,
  plain,
  record,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowExecution,
  type WorkflowExecutionReferences,
} from '@merv/contracts';
import { admitDispatch, type WorkflowDispatchAdmission } from '@merv/workflows/execution';
import { clone, ordinary, safeError } from './common.js';
import type { AgentObservations } from './observations.js';
import type { Session, SessionInvocation, SessionInvocationPolicy } from './types.js';

const snapshotInput = (input: Data): Data =>
  plain(input, 'invalid_input', {
    keys: 'any',
    strings: 'json',
    undefined: 'reject',
    nullPrototype: false,
  });
/** Refusals that say only that the policy does not bind a call, which a read does not need. */
const unbound = [
  'execution_tool_forbidden',
  'execution_arguments_forbidden',
  'execution_reference_unavailable',
];
/**
 * Admits one tool call under a session's execution. With `read`, the tool only reads, and a
 * session reads whatever its project holds (founder, 2026-09-17: no read constraints). The
 * policy still fills in what it names, so a read called as declared is admitted as declared;
 * one it does not name, or names differently, is admitted as given, bounded by the project
 * alone. Every write holds as published.
 */
function admitCall(
  execution: WorkflowExecution,
  tool: string,
  input: Data,
  read = false,
): WorkflowDispatchAdmission {
  // A detached copy, bounded as the engine bounds a caller's data.
  const encoded = canonical(
    plain(input, 'invalid_input', {
      depth: 32,
      nodes: 16_000,
      keys: 'any',
      strings: 'json',
      undefined: 'reject',
      nullPrototype: false,
    }),
  );
  check(encoded.length <= 4_000_000, 'invalid_input', 'Input is too large');
  const original = JSON.parse(encoded) as Data;
  check(record(original), 'invalid_input', 'Tool input must be a JSON object');
  // The project overview is asked for by leaving the instance out. A fixed binding would
  // fill it in and answer for this worker's own record instead — a narrower question than
  // the one asked, and the only read a session cannot otherwise express.
  if (read && tool === 'workflow.status_and_next' && !Object.hasOwn(original, 'instanceId'))
    return { tool, input: original };
  try {
    return admitDispatch(execution, tool, original);
  } catch (error) {
    if (read && error instanceof MervError && unbound.includes(error.code))
      return { tool, input: original };
    throw error;
  }
}
interface InvocationState {
  public: SessionInvocation;
  sessionId: string;
  registrationId: string;
  running: boolean;
  used: boolean;
  input: Data;
  validated: boolean;
  /** The tool only reads, so the project is its bound rather than the policy. */
  read: boolean;
}
/** What tool-call admission uses of Sessions: its open state, snapshots and lease checks. */
export interface InvocationHost {
  open(): void;
  closed(): boolean;
  reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  session(caller: Caller, tx: Transaction): Promise<Session>;
  valid(
    session: Session,
    tx: Transaction,
    frozen?: Session['execution'],
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }>;
  /** Refuses while a queued operator message waits for the worker's acknowledgement. */
  acknowledged(sessionId: string, tx: Transaction): Promise<void>;
}

/**
 * Tools every worker has whatever its assignment names, which need only its live lease:
 * acknowledging a message, and ending its visit with a question for its owner.
 */
const workerTools = new Set(['session.message.ack', 'session.ask_owner']);
/** Sessions' tool policy: each MCP call of a leased worker, admitted, validated and run once. */
export class SessionInvocations implements SessionInvocationPolicy {
  readonly instructions =
    'You are a leased Merv worker in one fixed project and workflow revision. Use the available tools for your current assignment. Tool arguments are bound by the server; omitted fixed identifiers are supplied automatically. Follow workflow.assignment and its handoff guidance. This session credential is valid only on this MCP endpoint.';
  /** The invocation whose handler runs, which Sessions' guard reads. */
  readonly toolHandler = new AsyncLocalStorage<string>();
  private readonly invocations = new WeakMap<SessionInvocation, InvocationState>();
  /** Live invocations by id, which Sessions' guard and close read. */
  readonly invocationIds = new Map<string, InvocationState>();
  constructor(
    private readonly observations: AgentObservations,
    private readonly clock: () => number,
    private readonly host: InvocationHost,
  ) {}
  /** Tool names per session, read once: a policy is frozen at offer, and the tool listing
   *  asks about every registered tool, which under load meant one locked transaction each. */
  private readonly toolNames = new Map<string, { names: Set<string>; at: number }>();
  async allowsTool(caller: Caller, name: string, read?: boolean): Promise<boolean> {
    ordinary(caller);
    caller = structuredClone(caller);
    if (read || workerTools.has(name)) return true;
    const id = caller.session?.id;
    const cached = id ? this.toolNames.get(id) : undefined;
    if (cached && this.clock() - cached.at < 60_000) return cached.names.has(name);
    const names = await this.host.reading(async (tx) => {
      const session = await this.host.session(caller, tx);
      return new Set(session.execution.policy.tools.map((tool) => tool.name));
    });
    if (id) {
      if (this.toolNames.size >= 1000) this.toolNames.clear();
      this.toolNames.set(id, { names, at: this.clock() });
    }
    return names.has(name);
  }
  private async admit(
    caller: Caller,
    tool: string,
    input: Data,
    tx: Transaction,
    registrationId?: string,
    read?: boolean,
  ) {
    const session = await this.host.session(caller, tx);
    // A worker's own tools are always admitted; they need only a live lease. The lease
    // is checked before the input is bounded, so when both are bad the lease error wins.
    const ack = workerTools.has(tool);
    const current = await this.host.valid(session, tx, ack ? undefined : session.execution);
    if (registrationId !== undefined)
      check(
        current.registrationId === registrationId,
        'execution_replaced',
        'Workflow implementation changed during invocation',
        409,
      );
    const admission = ack
      ? { tool, input: structuredClone(input) }
      : admitCall({ ...session.execution, references: current.references! }, tool, input, read);
    return { admission, registrationId: current.registrationId, session };
  }
  async prepare(
    caller: Caller,
    tool: string,
    input: Data,
    read?: boolean,
  ): Promise<SessionInvocation> {
    ordinary(caller);
    caller = structuredClone(caller);
    input = snapshotInput(input);
    const prepared = await this.host.reading(
      async (tx) => await this.admit(caller, tool, input, tx, undefined, read),
    );
    this.host.open();
    const invocationId = newId('invocation');
    const invocation: SessionInvocation = Object.freeze({
      caller: Object.freeze({
        actorId: caller.actorId,
        projectId: caller.projectId,
        session: Object.freeze({
          id: prepared.session.id,
          threadId: prepared.session.threadId,
          invocationId,
        }),
      }),
      tool,
      input: clone(prepared.admission.input),
    });
    const state: InvocationState = {
      public: invocation,
      sessionId: prepared.session.id,
      registrationId: prepared.registrationId,
      running: false,
      used: false,
      input: clone(prepared.admission.input),
      validated: false,
      read: !!read,
    };
    this.invocations.set(invocation, state);
    this.invocationIds.set(invocationId, state);
    return invocation;
  }
  async validate(caller: Caller, tool: string, input: Data): Promise<void> {
    ordinary(caller);
    caller = structuredClone(caller);
    input = snapshotInput(input);
    await this.host.reading(async (tx) => {
      const state = caller.session?.invocationId
        ? this.invocationIds.get(caller.session.invocationId)
        : undefined;
      check(
        state && !state.used && state.public.tool === tool,
        'session_invocation',
        'Session invocation is unavailable',
        403,
      );
      if (state.validated)
        check(
          canonical(state.input) === canonical(input),
          'session_invocation',
          'Session invocation arguments changed',
          403,
        );
      const admitted = await this.admit(caller, tool, input, tx, state.registrationId, state.read);
      this.host.open();
      check(!state.used, 'session_invocation', 'Session invocation is unavailable', 403);
      check(
        canonical(admitted.admission.input) === canonical(input),
        'session_invocation',
        'Session arguments no longer match their bindings',
        403,
      );
      // The first validation follows schema parsing. Unbound defaults/stripping are permitted;
      // fixed bindings are independently re-authorized before retaining the parsed snapshot.
      if (!state.validated) {
        state.input = clone(input);
        state.validated = true;
      }
    });
  }
  async run<T>(
    invocation: SessionInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    const state = this.invocations.get(invocation);
    check(
      state && !state.used && !state.running,
      'session_invocation',
      'Session invocation is unavailable',
      403,
    );
    // Claim once before yielding so concurrent callers cannot execute one preparation twice.
    state.running = true;
    try {
      // The registry authorized this call right before run; storing the observation yields,
      // so it is authorized again below before the tool runs.
      await this.observations.start(
        invocation.caller.session!.invocationId!,
        state.sessionId,
        invocation.tool,
        state.input,
      );
      await this.validate(invocation.caller, invocation.tool, state.input);
      if (invocation.tool !== 'session.messages' && invocation.tool !== 'session.message.ack')
        await this.host.reading(async (tx) => await this.host.acknowledged(state.sessionId, tx));
      // A session has one assignment, the frozen one it was offered; another record's
      // assignment is an admission of somebody else, so the question is refused by name.
      const own =
        invocation.tool === 'workflow.assignment'
          ? await this.host.reading(async (tx) => await this.host.session(invocation.caller, tx))
          : undefined;
      const asked = (state.input as { instanceId?: string }).instanceId;
      check(
        !own || asked === undefined || asked === own.instanceId,
        'execution_arguments_forbidden',
        `This session's assignment is ${own?.instanceId}; read another record with workflow.status_and_next`,
        403,
      );
      const result = own
        ? (clone(own.assignment) as T)
        : await this.toolHandler.run(
            invocation.caller.session!.invocationId!,
            async () => await handler(invocation.caller, clone(state.input)),
          );
      // MCP may return a tool error without throwing. Native values have no such envelope.
      const failed =
        invocation.tool.startsWith('_') &&
        result &&
        typeof result === 'object' &&
        'isError' in result &&
        result.isError === true;
      state.running = false;
      // The call has committed: a record that fails to say so is left running for the
      // startup sweep, and the worker still gets its result.
      if (!this.host.closed())
        await this.observations
          .finish(invocation.caller.session!.invocationId!, failed ? 'failed' : 'succeeded', result)
          .catch((error) =>
            process.stderr.write(
              `${JSON.stringify({ event: 'session.observation_unrecorded', code: safeError(error).code })}\n`,
            ),
          );
      return result;
    } finally {
      await this.cancel(invocation);
    }
  }
  async cancel(invocation: SessionInvocation): Promise<void> {
    const state = this.invocations.get(invocation);
    if (!state || state.used) return;
    const running = state.running;
    state.used = true;
    state.running = false;
    this.invocationIds.delete(invocation.caller.session!.invocationId!);
    if (running && !this.host.closed())
      await this.observations.finish(invocation.caller.session!.invocationId!, 'failed');
  }
}
