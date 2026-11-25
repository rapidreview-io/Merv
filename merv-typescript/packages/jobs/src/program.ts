import type {
  Scope,
  WorkflowAssignmentContent,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowDefinition,
  WorkflowExecutionPolicy,
  WorkflowPolicy,
} from '@merv/contracts';
import { check } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { grant, target } from '@merv/workflows/rules';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { JobPlan, JobView } from './types.js';

export const JOB_WORKFLOW = 'job.experiment';
/** How often a review may send the code back to be written again. */
export const REVISIONS = 2;

/**
 * One experiment job: the person's Mac writes the code, a rented machine runs exactly that
 * commit, and a fresh agent on the Mac reviews it. Stopping a running job waits in `stopping`
 * until its machine is released. Edge order is part of the fingerprint; never reorder it.
 */
export const definition: WorkflowDefinition = {
  name: JOB_WORKFLOW,
  version: 1,
  initial: 'proposed',
  states: ['proposed', 'writing', 'running', 'reviewing', 'stopping', 'done', 'stopped'],
  terminal: ['done', 'stopped'],
  edges: [
    { from: 'proposed', action: 'run', to: 'writing' },
    { from: 'writing', action: 'submit_code', to: 'running' },
    { from: 'running', action: 'finish_run', to: 'reviewing' },
    { from: 'reviewing', action: 'accept', to: 'done' },
    { from: 'reviewing', action: 'revise', to: 'writing' },
    { from: 'proposed', action: 'stop', to: 'stopped' },
    { from: 'writing', action: 'stop', to: 'stopped' },
    { from: 'reviewing', action: 'stop', to: 'stopped' },
    { from: 'running', action: 'stop', to: 'stopping' },
    { from: 'stopping', action: 'released', to: 'stopped' },
  ],
};

const moves = { jobId: target('instanceId'), expectedRevision: target('revision') };
const reads = [grant('job.read', {}), grant('artifact.read', {}), grant('project.read', {})];
/** The writer works in its own worktree on the person's Mac: no workspace, no compute here. */
export const writerExecution: WorkflowExecutionPolicy = {
  readOnly: false,
  tools: [grant('job.submit_code', moves), ...reads],
};
/** The reviewer only reads: the code at the commit, the run's record and its capture. */
export const reviewerExecution: WorkflowExecutionPolicy = {
  readOnly: true,
  tools: [grant('job.review', moves), grant('code.read', {}), ...reads],
};

const waiting: Record<string, string> = {
  proposed: 'Proposed: press Run to start it.',
  writing: 'The code is being written on your Mac.',
  running: 'The machine runs the job’s commit.',
  reviewing: 'A fresh agent on your Mac reviews the run.',
  stopping: 'Stopping: waiting for the machine to be released.',
};

export interface JobsContext {
  scope: Scope;
  sessions: Pick<Sessions, 'session'>;
}

export function policy(ctx: JobsContext): WorkflowPolicy {
  const person = async ({ caller, tx }: WorkflowCheckContext) => {
    check(!caller.session, 'people_only', 'Only a person runs or stops a job', 403);
    await ctx.scope.require(caller, 'write', tx);
  };
  const worker = async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
    const own = caller.session && (await ctx.sessions.session(caller, tx)).instanceId;
    check(
      own === snapshot.id,
      'job_worker_only',
      'Only this job’s leased agent hands this in',
      403,
    );
  };
  const machine = async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
    const service = await ctx.scope.serviceActor('jobs', snapshot.projectId, tx);
    check(
      !caller.session && caller.actorId === service.actorId,
      'job_machine_only',
      'Only Merv’s machine step moves a run on',
      403,
    );
  };
  const rule = (
    name: string,
    states: string[],
    transitions: string[],
    tool: string,
    guard: (context: WorkflowCheckContext) => Promise<void>,
    suggested = true,
  ) => ({
    name,
    states,
    transitions,
    tool,
    suggested,
    instruction: waiting[states[0]!] ?? name,
    check: guard,
  });
  const step = (
    state: 'writing' | 'reviewing',
    execution: WorkflowExecutionPolicy,
  ): WorkflowAssignmentRule => ({
    state,
    // Only the person's own Mac takes these steps, by hand: Fleet's machines never do.
    manual: true,
    check: async ({ caller, tx }) => {
      await ctx.scope.require(caller, state === 'writing' ? 'write' : 'review', tx);
    },
    build: ({ snapshot }) => assignment(snapshot, state),
    execution,
    lease: {
      label: ({ snapshot }) => `Job: ${String(snapshot.data.title ?? snapshot.id)}`,
      role: () => (state === 'writing' ? 'producer' : 'reviewer'),
      acquire: ({ leaseId }) => ({ leaseId }),
      check: () => {},
      release: () => {},
    },
  });
  return {
    successStates: ['done'],
    limits: [{ name: 'revisions', from: 'reviewing', actions: ['revise'], max: REVISIONS }],
    describe: ({ snapshot }) => ({
      label: `Job: ${String(snapshot.data.title ?? snapshot.id)}`,
      references: [],
      gate: snapshot.state,
      waiting: waiting[snapshot.state] ?? `The job is ${snapshot.state}.`,
    }),
    actions: [
      rule('run', ['proposed'], ['run'], 'job.write:run', person),
      rule('submit_code', ['writing'], ['submit_code'], 'job.submit_code', worker),
      rule('finish_run', ['running'], ['finish_run'], 'job.machine', machine, false),
      rule('review', ['reviewing'], ['accept', 'revise'], 'job.review', worker),
      rule(
        'stop',
        ['proposed', 'writing', 'running', 'reviewing'],
        ['stop'],
        'job.write:stop',
        person,
        false,
      ),
      rule('released', ['stopping'], ['released'], 'job.machine', machine, false),
    ],
    assignments: [step('writing', writerExecution), step('reviewing', reviewerExecution)],
  };
}

/** What the step's agent on the Mac is told: the job, and how it hands its step in. */
export function assignment(
  snapshot: WorkflowSnapshot,
  state: 'writing' | 'reviewing',
): WorkflowAssignmentContent {
  const job = view(snapshot);
  const plan = [
    `Job: ${job.title}`,
    `Goal: ${job.goal}`,
    `Done means: ${job.doneMeans}`,
    `The machine step runs this command from the repository root at the job’s commit, on one ${job.gpu}, for at most ${job.minutes} minutes: ${job.command}`,
  ];
  const writing = state === 'writing';
  const tool = writing ? 'job.submit_code' : 'job.review';
  const brief = writing
    ? [
        'You write the code for one job, in your own worktree on the person’s Mac.',
        ...plan,
        'The command prints its readings as lines `METRIC {"step": 1, "loss": 1.93}` and writes files to keep under outputs/.',
        ...(job.result?.verdict === 'revise'
          ? [`The review of commit ${job.result.commitRead} sent it back: ${job.result.summary}`]
          : []),
        'When the code is ready, commit it and push the branch to this project’s Merv git (a branch of your own such as desk-run/<name>, never merv/*). Then call job.submit_code with that branch as ref and the full commit id: Merv checks the branch points at it and runs exactly that commit. Then stop.',
      ]
    : [
        'You review one job’s run with fresh eyes. You only read: change nothing.',
        ...plan,
        `Code: branch ${job.code?.ref}, commit ${job.code?.commit}. Read it with code.read at that commit.`,
        `Run: ${JSON.stringify(job.run)}. Its outputs are the artifact captureArtifactId (artifact.read).`,
        `Hand in job.review with commitRead ${job.code?.commit}: verdict accept when it meets what done means (optionally with next, the job worth proposing after it), or revise with what must change (${job.revisionsLeft} left). Then stop.`,
      ];
  return {
    role: writing ? 'producer' : 'reviewer',
    label: writing ? 'Work: write the code for this job' : 'Work: review this job’s run',
    name: job.title,
    brief: brief.join('\n'),
    references: [],
    handoff: {
      instruction: `Hand in ${tool}, then stop.`,
      tools: [tool, 'session.ask_owner'],
    },
    execution: {
      readOnly: !writing,
      tools: [{ name: tool, arguments: { jobId: job.id, expectedRevision: job.revision } }],
    },
    context: null,
  };
}

/** The fields a job's plan keeps; the tools' schemas have checked them. */
export const pick = (plan: JobPlan): JobPlan => {
  const { title, goal, doneMeans, command, gpu, minutes, estimateUsd } = plan;
  return { title, goal, doneMeans, command, gpu, minutes, estimateUsd };
};

/** The job as its tools answer it. */
export function view(snapshot: WorkflowSnapshot): JobView {
  const data = snapshot.data as Record<string, unknown>;
  return {
    id: snapshot.id,
    state: snapshot.state as JobView['state'],
    revision: snapshot.revision,
    ...pick(data as unknown as JobPlan),
    steps: [
      { state: 'writing', place: 'mac' },
      { state: 'running', place: 'machine' },
      { state: 'reviewing', place: 'mac' },
    ],
    code: (data.code as JobView['code']) ?? null,
    run: (data.run as JobView['run']) ?? null,
    result: (data.result as JobView['result']) ?? null,
    revisionsLeft: Math.max(0, REVISIONS - Number(data.revisions ?? 0)),
    previousJobId: (data.previousJobId as string | undefined) ?? null,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}
