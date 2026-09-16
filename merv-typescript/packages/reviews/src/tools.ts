import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import type { Caller, ReviewApplication } from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);

/** Generic review transport; registered target programs apply verdicts transactionally. */
export const reviewToolsPlugin = {
  name: 'merv-review-tools',
  inject: ['tools', 'reviews'],
  apply(ctx: Context) {
    for (const tool of [
      {
        name: 'review.list',
        description:
          'List immutable review requests and their claim/verdict status in the current project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Parameters<typeof ctx.reviews.list>[0]) =>
          await ctx.reviews.list(caller),
      },
      {
        name: 'review.get',
        description:
          'Read a review’s pinned artifact IDs, numbered criteria, target revision, snapshot hash and required verdict formatVersion, with its synopsis, findings, structured evidence and selected returnTo route when submitted.',
        inputSchema: z.object({ reviewId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: async (
          caller: Parameters<typeof ctx.reviews.get>[0],
          input: { reviewId: string },
        ) => await ctx.reviews.get(caller, input.reviewId),
      },
      {
        name: 'review.start',
        description:
          'Claim an available review as an independent reviewer. Returns a claimId required by review.submit, task.context and review checkpoints. Retrying the current claim is safe. A revoked claim is released automatically.',
        inputSchema: z.object({ reviewId: z.string().min(1) }).strict(),
        handler: async (
          caller: Parameters<typeof ctx.reviews.start>[0],
          input: { reviewId: string },
        ) => await ctx.reviews.start(caller, input.reviewId),
      },
      {
        name: 'review.submit',
        description:
          'Apply an independent verdict through the single domain that owns the review, atomically with its state transition. The owning domain determines every verdict’s next state, including whether fail returns for rework or ends work. Optional returnTo selects an explicit return route when that domain requires or permits it; follow its allowed destinations and verdict rules. Task reviews have fixed routes (pass→done, needs_changes→in_progress, fail→failed) and reject returnTo. Claim with review.start and include its claimId. For review formatVersion 2, supply a plain single-paragraph synopsis (40–420 characters) and exactly one finding per criterionNumber: met/not_met/not_verified/waived, evidenceIds from the pinned review, and notes explaining verification, required correction or why a waived check is unnecessary for the goal. Met requires evidence; pass requires all criteria met or explicitly waived and the overall goal achieved. Optional evidence stores structured observations; evidence.outcome supplies the passing outcome. expectedRevision is the pinned subject revision.',
        inputSchema: z
          .object({
            reviewId: id,
            claimId: id,
            verdict: z.enum(['pass', 'needs_changes', 'fail']),
            returnTo: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
              .optional(),
            notes: z.string().min(1),
            synopsis: z.string().min(1).max(420).optional(),
            findings: z
              .array(
                z
                  .object({
                    criterionNumber: z.number().int().positive(),
                    status: z.enum(['met', 'not_met', 'not_verified', 'waived']),
                    evidenceIds: z.array(id),
                    notes: z.string().min(1).max(16000),
                  })
                  .strict(),
              )
              .min(1)
              .optional(),
            evidence: z.record(z.unknown()).optional(),
            expectedRevision: z.number().int().nonnegative(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: ReviewApplication) =>
          await ctx.reviews.apply(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default reviewToolsPlugin;
