import type {
  WorkflowCheckContext,
  WorkflowDefinition,
  WorkflowExecutionPolicy,
  WorkflowPolicy,
} from '@merv/contracts';
import { check } from '@merv/contracts';
import { grant, target } from '@merv/workflows/rules';
import type { AutoresearchContext } from './index.js';

/**
 * The manager's workflow, one instance a project. The manager works in `managing`, as a leased
 * worker that Sessions dispatches; every later visit there continues the same thread and its
 * conversation. Between visits it is `waiting` for the work it started, `paused` for the
 * person, or `idle` between rounds. Edge order is part of the fingerprint; never reorder it.
 */
export const definition: WorkflowDefinition = {
  name: 'autoresearch',
  version: 1,
  initial: 'managing',
  states: ['managing', 'waiting', 'paused', 'idle', 'off'],
  terminal: ['off'],
  edges: [
    { from: 'managing', action: 'wait', to: 'waiting' },
    { from: 'managing', action: 'end_round', to: 'idle' },
    { from: 'managing', action: 'pause', to: 'paused' },
    { from: 'waiting', action: 'wake', to: 'managing' },
    { from: 'waiting', action: 'hear', to: 'managing' },
    { from: 'waiting', action: 'pause', to: 'paused' },
    { from: 'paused', action: 'resume', to: 'managing' },
    { from: 'waiting', action: 'end_round', to: 'idle' },
    { from: 'paused', action: 'end_round', to: 'idle' },
    { from: 'idle', action: 'start_round', to: 'managing' },
    { from: 'managing', action: 'turn_off', to: 'off' },
    { from: 'waiting', action: 'turn_off', to: 'off' },
    { from: 'paused', action: 'turn_off', to: 'off' },
    { from: 'idle', action: 'turn_off', to: 'off' },
  ],
};

/** The manager's role: it writes work records, so it holds a producer's lease. */
export const MANAGER_ROLE = 'producer' as const;

/**
 * What a manager visit may call: read the project, schedule tasks and experiments through their
 * own tools (the cap is Autoresearch's start admission), and hand in its decision. Asking the
 * person (`session.ask_owner`) is every continuing worker's own tool.
 */
export const managerExecution: WorkflowExecutionPolicy = {
  readOnly: false,
  tools: [
    grant('autoresearch.decide', {
      autoresearchId: target('instanceId'),
      expectedRevision: target('revision'),
    }),
    grant('autoresearch.read', {}),
    grant('task.create', {}),
    grant('experiment.create', {}),
    grant('task.read', {}),
    grant('task.list', {}),
    grant('task.get', {}),
    grant('experiment.read', {}),
    grant('experiment.list', {}),
    grant('experiment.get_state', {}),
    grant('research.read', {}),
    grant('paper.read', {}),
    grant('artifact.read', {}),
    grant('artifact.list', {}),
    grant('artifact.get', {}),
    grant('workflow.read', {}),
    grant('workflow.status_and_next', {}),
    grant('workflow.assignment', { instanceId: target('instanceId') }),
    grant('project.read', {}),
  ],
};

const waiting: Record<string, string> = {
  managing: 'The manager is reading what finished and deciding what comes next.',
  waiting: 'The manager waits for the work it started; it wakes when one ends.',
  paused: 'Automatic research is paused until the person resumes it.',
  idle: 'The round ended. Start another round to continue.',
};

export function policy(ctx: AutoresearchContext): WorkflowPolicy {
  /** A person's move, or the loop's own under the delegation of whoever turned it on. */
  const person = async ({ caller, tx }: WorkflowCheckContext) => {
    check(!caller.session, 'manager_only_decides', 'A leased worker cannot move autoresearch', 403);
    await ctx.scope.require(caller, 'write', tx);
  };
  const action = (name: string, states: string[], transitions: string[], tool: string) => ({
    name,
    states,
    transitions,
    tool,
    suggested: false,
    instruction: waiting[states[0]!] ?? name,
    check: person,
  });
  return {
    describe: async ({ snapshot, tx }) => {
      const row = await ctx.row(snapshot.projectId, tx);
      return {
        label: 'Autoresearch manager',
        owner: {
          actorId: row?.updated_by ?? '',
          leased: ['wait', 'end_round'],
        },
        gate: snapshot.state,
        waiting: waiting[snapshot.state] ?? 'Autoresearch is off.',
        references: [],
      };
    },
    actions: [
      {
        name: 'decide',
        states: ['managing'],
        transitions: ['wait', 'end_round'],
        tool: 'autoresearch.decide',
        instruction:
          'Read what finished, schedule the next tasks and experiments within the spend cap, then hand in your decision: wait for the work you started, or end the round with a summary.',
        arguments: (context: WorkflowCheckContext) => ({
          autoresearchId: context.snapshot.id,
          expectedRevision: context.snapshot.revision,
        }),
        check: async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
          check(
            caller.session,
            'manager_only_decides',
            'Only the leased manager hands in its decision',
            403,
          );
          await ctx.scope.require(caller, 'write', tx);
          const session = await ctx.sessions.session(caller, tx);
          check(
            session.instanceId === snapshot.id,
            'manager_only_decides',
            'Only the leased manager hands in its decision',
            403,
          );
        },
      },
      action('pause', ['managing', 'waiting'], ['pause'], 'autoresearch.write:pause'),
      action('resume', ['paused'], ['resume'], 'autoresearch.write:resume'),
      action('wake', ['waiting'], ['wake', 'hear'], 'autoresearch.write:resume'),
      action('start_round', ['idle'], ['start_round'], 'autoresearch.write:start_round'),
      action('end_round', ['waiting', 'paused'], ['end_round'], 'autoresearch.write:end_round'),
      action(
        'turn_off',
        ['managing', 'waiting', 'paused', 'idle'],
        ['turn_off'],
        'autoresearch.write:configure',
      ),
    ],
    assignments: [
      {
        state: 'managing',
        check: async ({ caller, tx }) => {
          await ctx.scope.require(caller, 'write', tx);
        },
        build: async (context) => await ctx.assignment(context),
        execution: managerExecution,
        lease: {
          label: () => 'Autoresearch manager',
          role: () => MANAGER_ROLE,
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
}
