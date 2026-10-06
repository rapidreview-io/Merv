import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import type {
  Caller,
  ReviewApplication,
  ReviewGuide,
  ReviewRequest,
  Reviews,
} from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);

/** The owning domain's verdict rules and return routes travel with the review read or claimed. */
async function guided(
  reviews: Reviews,
  caller: Caller,
  review: ReviewRequest,
): Promise<ReviewRequest & ReviewGuide> {
  return { ...review, ...(await reviews.guide(caller, review)) };
}

/** Generic review transport; registered target programs apply verdicts transactionally. */
export const reviewToolsPlugin = {
  name: 'merv-review-tools',
  inject: ['tools', 'reviews'],
  apply(ctx: Context) {
    for (const tool of [
      {
        name: 'review.list',
        description:
          'List immutable review requests, their claim/verdict status, whether you may claim them in the current project. Pass subjectId to list only the reviews of that record.',
        inputSchema: z.object({ subjectId: z.string().min(1).optional() }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { subjectId?: string }) =>
          await ctx.reviews.list(caller, input),
      },
      {
        name: 'review.get',
        description:
          'Read a review’s pinned artifact IDs, numbered criteria, target revision, snapshot hash and required verdict formatVersion, with its synopsis, findings, structured evidence and selected returnTo route when submitted, and the owning domain’s verdict guidance. Owner-certified reviews also carry pinned contributor provenance and explain when independent review is unavailable.',
        inputSchema: z.object({ reviewId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { reviewId: string }) =>
          await guided(ctx.reviews, caller, await ctx.reviews.get(caller, input.reviewId)),
      },
      // A claim shuts out every other reviewer, and a verdict decides the work: from a
      // conversation both are the person's to run.
      {
        name: 'review.start',
        conversation: 'propose' as const,
        description:
          'Claim an available review as an independent reviewer. Returns the review with a claimId that review.submit and the owning domain’s review steps require, and that domain’s verdict guidance: follow it in review.submit. Retrying the current claim is safe. A revoked claim is released automatically. Your directing authority must not be the producer, and for owner-certified reviews neither you nor it may be a retained contributor.',
        inputSchema: z
          .object({ reviewId: z.string().min(1), override: z.literal(true).optional() })
          .strict(),
        handler: async (caller: Caller, input: { reviewId: string; override?: true }) =>
          await guided(
            ctx.reviews,
            caller,
            await ctx.reviews.start(caller, input.reviewId, undefined, input.override),
          ),
      },
      {
        name: 'review.submit',
        conversation: 'propose' as const,
        description:
          'Apply an independent verdict through the single domain that owns the review, atomically with its state transition. The owning domain determines every verdict’s next state, including whether fail returns for rework or ends work, and which returnTo routes and extra fields it accepts: follow the guidance review.start and review.get return. Optional returnTo selects an explicit return route when that domain requires or permits it. Claim with review.start and include its claimId. Your actor and current directing authority are checked against the pinned contributor provenance again when you submit. Supply a plain single-paragraph synopsis (40–420 characters) and exactly one finding per criterionNumber: met/not_met/not_verified/waived, evidenceIds from the pinned review, and notes explaining verification, required correction or why a waived check is unnecessary for the goal. Met requires evidence; pass requires all criteria met or explicitly waived and the overall goal achieved. Optional evidence stores structured observations; evidence.outcome supplies the passing outcome. expectedRevision is the pinned subject revision. Any other field is passed to the owning domain, which validates it; a domain that does not accept it refuses the verdict.',
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
            notes: z.string().min(1).max(16000),
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
          .catchall(z.unknown()),
        handler: async (caller: Caller, input: ReviewApplication) =>
          await ctx.reviews.apply(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default reviewToolsPlugin;
