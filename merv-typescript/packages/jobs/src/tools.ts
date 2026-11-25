import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import type {} from './types.js';

const requestId = z.string().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const move = {
  jobId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  requestId,
};
const plan = z.strictObject({
  title: text(200),
  goal: text(4000),
  doneMeans: text(4000),
  command: text(4000),
  gpu: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,32}$/)
    .default('T4'),
  minutes: z.number().int().min(1).max(720),
  estimateUsd: z.number().positive().max(1000),
});

export const jobsToolsPlugin = {
  name: 'merv-jobs-tools',
  inject: ['jobs', 'tools'],
  apply(ctx: Context) {
    const jobs = ctx.jobs;
    ctx.effect(() =>
      ctx.tools.noun('job.read', {
        tier: 'deferred',
        readOnly: true,
        summary: 'Read the project’s jobs: proposed, running, needing review and done.',
        description:
          'Read the project’s jobs. Each job is plan on your Mac, run on a rented machine at an exact commit, review on your Mac; its record says where it stands, the commit it ran, the run’s cost, capture artifact and final METRIC values, and the review’s verdict.',
        actions: {
          list: {
            description:
              'Every job of the project, newest first, with allowance: the cap, what is spent or held under it and what is left for a run (null, with allowanceReason, when it is not known).',
            input: z.strictObject({}),
            handler: (caller) => jobs.list(caller),
          },
          get: {
            description:
              'One job, with the project’s allowance as list gives it. While it runs, live holds the latest METRIC values its command printed (best effort, else null). After Stop, run.machineReleased says whether its machine is released.',
            input: z.strictObject({ jobId: z.string().min(1) }),
            handler: (caller, input) => jobs.get(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('job.write', {
        tier: 'deferred',
        for: 'people',
        summary: 'Propose, run or stop a job.',
        description:
          'Change the project’s jobs. propose records a job with its command and price; run starts it (its writing step waits for your Mac); stop ends it, cancels its machine and waits until the machine is released.',
        actions: {
          propose: {
            act: { title: 'Propose a job' },
            description:
              'A proposed job: what it is for, the command its machine runs from the repository root, the GPU, its minutes and the estimated cost of the whole machine lease (minutes plus about 7 for renting, fetching and capture). It runs only when you press Run.',
            input: plan.extend({ requestId }),
            handler: (caller, input) => jobs.propose(caller, input),
          },
          run: {
            act: { title: 'Run the job' },
            description:
              'Start a proposed job. Refused, with nothing started, when the project has no compute or its estimate does not fit under the cap.',
            input: z.strictObject(move),
            handler: (caller, input) => jobs.run(caller, input),
          },
          stop: {
            act: { title: 'Stop the job' },
            description:
              'Stop a job. A running one is stopping until its machine is released, then stopped with run.machineReleased true.',
            input: z.strictObject({ ...move, reason: text(2000).optional() }),
            handler: (caller, input) => jobs.stop(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'job.submit_code',
        tier: 'worker',
        description:
          'Job writer only: hand in the code. ref is the branch you pushed to this project’s Merv git, commit the full commit id it points at; Merv checks it and runs exactly that commit on the machine. Stop after calling it.',
        inputSchema: z.strictObject({
          ...move,
          ref: z.string().regex(/^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[A-Za-z0-9._/-]{1,200}$/),
          commit: oid,
        }),
        handler: (caller, input) => jobs.submitCode(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'job.review',
        tier: 'worker',
        description:
          'Job reviewer only: hand in your review of the commit you read (commitRead). accept ends the job, optionally proposing the next job worth running (next, priced as job.write propose); revise sends it back to be written again with summary as what must change. Stop after calling it.',
        inputSchema: z.strictObject({
          ...move,
          verdict: z.enum(['accept', 'revise']),
          commitRead: oid,
          summary: text(4000),
          next: plan.optional(),
        }),
        handler: (caller, input) => jobs.review(caller, input),
      }),
    );
  },
};
export default jobsToolsPlugin;
