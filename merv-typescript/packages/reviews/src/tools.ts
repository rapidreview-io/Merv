import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import { REVIEW_VERDICTS } from './rules.js';
import type { Caller, ReviewRequest } from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);

/** Generic review transport; registered target programs apply verdicts transactionally. */
export const reviewToolsPlugin = {
  name: 'merv-review-tools',
  inject: ['tools', 'reviews'],
  apply(ctx: Context) {
    const reviews = ctx.reviews;
    // The owning domain's verdict rules and return routes travel with the review read or claimed.
    const guided = async (caller: Caller, pending: Promise<ReviewRequest>) => {
      const review = await pending;
      return ctx.tools.guidance(caller, { ...review, ...(await reviews.guide(caller, review)) });
    };
    ctx.effect(() =>
      ctx.tools.noun('review.read', {
        tier: 'core',
        readOnly: true,
        summary: 'Read review requests and verdict guidance.',
        description:
          'Read reviews: list (the project’s review requests, with whether you may claim each) and get (one review’s pinned evidence, criteria, verdict and the owning domain’s verdict guidance).',
        actions: {
          list: {
            description:
              'List the current project’s immutable review requests with their claim/verdict status and claimable: whether the review permission, producer and contributor exclusions let you claim one. review.start may still refuse what the owning domain reserves, such as a review a leased worker’s own lease does not serve. Pass subjectId to list only the reviews of that record.',
            input: z.object({ subjectId: id.optional() }).strict(),
            was: ['review.list'],
            handler: (caller, input) => reviews.list(caller, input),
          },
          get: {
            description:
              'Read a review’s pinned artifact IDs, numbered criteria, target revision, snapshot hash and required verdict formatVersion, with its synopsis, findings, structured evidence and selected returnTo route when submitted, and the owning domain’s verdict guidance. Owner-certified reviews also carry pinned contributor provenance and explain when independent review is unavailable.',
            input: z.object({ reviewId: id }).strict(),
            was: ['review.get'],
            handler: (caller, input) => guided(caller, reviews.get(caller, input.reviewId)),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('review.write', {
        summary: 'Claim, submit or release independent reviews.',
        description:
          'Act on reviews as an independent reviewer: start (claim one, returning its claimId and verdict guidance), submit (apply your verdict through the owning domain) and release (hand a claim back).',
        actions: {
          start: {
            act: { title: 'Claim review' },
            description:
              'Claim an available review as an independent reviewer. Returns the review with a claimId that review.submit and the owning domain’s review steps require, and that domain’s verdict guidance: follow it in review.submit. Retrying the current claim is safe. A revoked claim is released automatically. Your directing authority must not be the producer, and for owner-certified reviews neither you nor it may be a retained contributor.',
            input: z.strictObject({
              reviewId: id,
              override: z
                .literal(true)
                .optional()
                .describe(
                  "The project owner deciding the review themself, which is recorded as the owner's override. Only the owner, acting as themself, may.",
                ),
            }),
            was: ['review.start'],
            handler: (caller, input) =>
              guided(caller, reviews.start(caller, input.reviewId, undefined, input.override)),
          },
          submit: {
            act: { title: 'Submit verdict' },
            summary:
              'Claim with review.start; submit claimId and pinned expectedRevision. Domain guidance from review.start and review.get determines verdict transitions, returnTo and extra fields; unsupported fields are refused. Submission atomically applies verdict/state, rechecking actor/directing authority against pinned contributors. Synopsis: one plain paragraph, 40–420 characters. Exactly one finding per criterionNumber: met/not_met/not_verified/waived, pinned evidenceIds and verification/correction/waiver notes. Met needs evidence; pass needs all criteria met/waived AND goal achieved. Optional evidence records observations; evidence.outcome supplies passing outcome.',
            description:
              'Apply an independent verdict through the single domain that owns the review, atomically with its state transition. The owning domain determines every verdict’s next state, including whether fail returns for rework or ends work, and which returnTo routes and extra fields it accepts: follow the guidance review.start and review.get return. Optional returnTo selects an explicit return route when that domain requires or permits it. Claim with review.start and include its claimId. Your actor and current directing authority are checked against the pinned contributor provenance again when you submit. Supply a plain single-paragraph synopsis (40–420 characters) and exactly one finding per criterionNumber: met/not_met/not_verified/waived, evidenceIds from the pinned review, and notes explaining verification, required correction or why a waived check is unnecessary for the goal. Met requires evidence; pass requires all criteria met or explicitly waived and the overall goal achieved. Optional evidence stores structured observations; evidence.outcome supplies the passing outcome. expectedRevision is the pinned subject revision. Any other field is passed to the owning domain, which validates it; a domain that does not accept it refuses the verdict.',
            input: z
              .object({
                reviewId: id,
                claimId: id,
                verdict: z.enum(REVIEW_VERDICTS),
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
                    z.strictObject({
                      criterionNumber: z.number().int().positive(),
                      status: z.enum(['met', 'not_met', 'not_verified', 'waived']),
                      evidenceIds: z.array(id),
                      notes: z.string().min(1).max(16000),
                    }),
                  )
                  .min(1)
                  .optional(),
                evidence: z.record(z.unknown()).optional(),
                expectedRevision: z.number().int().nonnegative(),
                requestId,
              })
              .catchall(z.unknown()),
            was: ['review.submit'],
            handler: (caller, input) => reviews.apply(caller, input),
          },
          release: {
            act: { title: 'Release review' },
            description:
              'Hand back a claimed review so that another eligible reviewer, or a leased review worker, may claim it. Only the reviewer who claimed it or a project admin may, never a leased worker, whose claim is released with its lease. Pass the reviewId, a reason and a stable requestId; a retry with the same requestId answers the same. Nothing about the work under review changes.',
            input: z.strictObject({
              reviewId: id,
              reason: z.string().trim().min(1).max(500),
              requestId,
            }),
            was: ['review.release'],
            handler: (caller, input) => reviews.release(caller, input),
          },
        },
      }),
    );
  },
};
export default reviewToolsPlugin;
