import { computeGuidance } from '@merv/sessions/compute';
import {
  check,
  type Data,
  type WorkflowCheckContext,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
} from '@merv/contracts';
import { codeWorkspace } from '@merv/code-work/workspace';
import { artifactGrants, grant, literal, reviewGrants, target } from '@merv/workflows/rules';
import { heldLease, insertLease, reviewedLeaseHooks } from '@merv/workflows/lease-rows';
import { directsIndependently, excludedFromReview, reviewActions } from '@merv/reviews/rules';
import { REPORT_TOOLS } from '@merv/reports/prefill';
import type { CustomerExperiments } from './domain.js';
import { SERVICE_EXPERIMENT, plansDocument, postsProgress, writesReport } from './program.js';
import { SERVICE_MODEL, contractDatasets, contractLimits } from './types.js';

/**
 * Whether an executor may end its visit to wait for its compute (session.await_compute), its
 * limit staying agent working time, which a wait uses none of. The owner's decision is pending
 * (2026-10-18); false keeps every wait of a customer run inside its visit.
 */
const executorsAwaitCompute: boolean = true;

/** What version 2's executor is told: the report tools and their persistent draft. */
const reportInstruction =
  'Execute only this accepted contract. Validate every downloaded dataset SHA-256 before use. Select suitable hardware internally, including GPU rentals through the native Sandboxes connection when available. Inspect current inventory and pricing before choosing; the customer does not select or approve a fixed GPU type. Use only the authorized account allowance, bounded job timeouts and rental leases, release unused machines, and do not use paid external APIs or unapproved training. Complete explicit native Capture nodes for remote outputs and wait until their Merv artifact collections are registered before handing off (for a long run, end your visit with session.await_compute on its workflows rather than sleeping or polling: the work comes back to you once they are registered); machine files and temporary Snapshots are not retained evidence. Save code with code.commit and results as artifacts. Write the report with the report tools (subjectKind customer_experiment, subjectId this request): report.open returns a draft prefilled from the contract, its question, inquiry and constraints locked, and the format guide; it persists, so after a review returns the work edit it (report.write) or start over (report.clear) instead of rewriting it. Compute every number from the retained results, review and approve each chart (report.review_visual, report.approve_visual), check the page (report.render), render it with final: true, then call customer_experiment.submit_results with its sourceArtifactId as reportArtifactId and, as artifactIds, the result artifacts you created in this session (this attempt’s native compute captures are added for you; cite a result kept in an earlier session by id in the report). Stop after successful handoff; final capture and independent review follow automatically. If feasibility changes, report it faithfully in the report; do not change scope.';

/** Version 3's executor: the accepted plan document is the specification. */
const documentInstruction = reportInstruction.replace(
  'Execute only this accepted contract. Validate every downloaded dataset SHA-256 before use.',
  "Execute only this accepted contract. Its document is the customer's verified plan and your specification; question, criteria and limits are its frozen summary, and files lists the request files (keys, sizes, ETags) it was accepted with: list them with customer_experiment.files and fetch each through customer_experiment.file_download. Check every downloaded request file against its manifest size and ETag before use. Compute trouble is yours to fix, and nobody can intervene in a customer run. Choose each rental from sandboxes.sandbox_options by price and by maximum lifetime against the job: a machine cannot be renewed past its provider's lifetime (Modal's offers state theirs in their description), so give a longer job to an offer that allows it, or checkpoint the job and resume it on a fresh machine. If a machine is not ready within 10 minutes, delete it and rent elsewhere. This experiment may hold two machines at once, and one still deleting counts until its deletion is confirmed: if a rental is refused for concurrency, wait for that, then retry. Never stop to ask about compute, capacity or providers. Ask a question only when the contract itself cannot be executed, and otherwise report infeasibility in the results. Make the report visual: besides the headline result, chart whatever is clearer drawn than written (breakdowns by task or source, accuracy against latency or cost, where models disagree), and keep its prose short and free of internal ids.",
);

/** Version 4's executor: version 3's, posting to the status page only version 4 grants it. */
const progressInstruction = documentInstruction.replace(
  'Check every downloaded request file against its manifest size and ETag before use.',
  'Check every downloaded request file against its manifest size and ETag before use. The customer watches a status page: post progress with customer_experiment.progress at each milestone (machine ready, files checked, each model or condition started and finished with its score, results being written), a short plain sentence each time.',
);

export function serviceExecution(review: boolean, version = 1): WorkflowExecutionPolicy {
  return {
    readOnly: review,
    workspace: codeWorkspace(review ? 'review' : 'work', 'customer-experiments'),
    platform: { ...SERVICE_MODEL },
    maxDurationSeconds: 86_400,
    maxModelTokens: 500_000_000,
    tools: [
      grant('workflow.status_and_next', { instanceId: target('instanceId') }),
      grant('workflow.assignment', { instanceId: target('instanceId') }),
      grant('customer_experiment.get', { id: target('instanceId') }),
      // v3: the request files frozen into the contract, read-only.
      ...(plansDocument(version)
        ? [
            grant('customer_experiment.files', { id: target('instanceId') }),
            grant('customer_experiment.file_download', { id: target('instanceId') }),
          ]
        : []),
      grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('review.get', { reviewId: { kind: 'oneOf', name: 'reviews' } }),
      ...(review
        ? reviewGrants()
        : [
            ...artifactGrants(),
            grant('code.commit', {}),
            grant('code.operation', {}),
            ...(writesReport(version)
              ? REPORT_TOOLS.map((name) =>
                  grant(name, {
                    subjectKind: literal('customer_experiment'),
                    subjectId: target('instanceId'),
                  }),
                )
              : []),
            // v4: lines on the customer's status page while the run goes.
            ...(postsProgress(version)
              ? [grant('customer_experiment.progress', { id: target('instanceId') })]
              : []),
            grant('customer_experiment.submit_results', {
              id: target('instanceId'),
              expectedRevision: target('revision'),
              artifactIds: { kind: 'subset', name: 'artifacts' },
            }),
          ]),
    ],
  };
}

export function executionPolicy(ctx: CustomerExperiments, version = 1): WorkflowPolicy {
  const facts = (c: WorkflowCheckContext) => ctx.get(c.caller, c.snapshot.id, c.tx);
  const currentReview = async (c: WorkflowCheckContext) => {
    const exp = await facts(c);
    check(exp.review, 'review_required', 'Results review is not ready', 409);
    return exp.review;
  };
  const checkAdmission = async (c: WorkflowCheckContext) => {
    const exp = await facts(c);
    if (!c.caller.session) {
      const usage = await ctx.sessions.usage(c.caller, {
        instanceId: exp.id,
        includeDependencies: false,
      });
      check(
        !usage.liveSessions,
        'prior_visit_running',
        'Wait for the previous experiment visit to close before starting another',
        409,
      );
    }
    check(
      exp.acceptedContractId === exp.contract?.id && !!exp.paymentId,
      'execution_locked',
      'The exact contract needs customer acceptance and confirmed payment',
      409,
    );
    check(
      exp.attempts <= contractLimits(exp.contract!).maxAttempts,
      'attempt_limit',
      'The accepted execution limit is exhausted',
      409,
    );
    if (c.snapshot.state === 'running')
      await ctx.code.requireLeasable(c.caller, { unitId: exp.id, writer: true }, c.tx);
    else {
      check(
        exp.submission?.codeHead,
        'capture_pending',
        'Results review waits for the final code capture',
        409,
      );
      await ctx.scope.require(c.caller, 'review', c.tx);
    }
    if (c.caller.session) await ctx.worker(c.caller, exp, c.tx);
  };
  const lease = reviewedLeaseHooks({
    reviews: ctx.reviews,
    artifacts: ctx.artifacts,
    excluded: excludedFromReview,
    label: async (c) => (await facts(c)).title,
    review: async (c) =>
      c.snapshot.state === 'results_review' ? (await currentReview(c)).id : null,
    captures: async (c) =>
      c.snapshot.state === 'running'
        ? (await ctx.computeEvidence(await facts(c), c.tx)).artifactIds
        : [],
    lease: async (c) =>
      heldLease(
        ctx.state,
        c.tx,
        { projectId: c.caller.projectId, instanceId: c.snapshot.id, revision: c.snapshot.revision },
        c.caller,
      ),
    role: async (c) => {
      check(
        !c.caller.session,
        'forbidden',
        'A worker cannot delegate another experiment worker',
        403,
      );
      await checkAdmission(c);
      if (c.snapshot.state === 'running') {
        await ctx.scope.require(c.caller, 'write', c.tx);
        return 'producer';
      }
      const review = await currentReview(c);
      check(
        review.status === 'requested' && directsIndependently(review, c.caller.actorId),
        'review_unavailable',
        'An independent unclaimed results review is required',
        409,
      );
      return 'reviewer';
    },
    acquire: async (c) => {
      const exp = await ctx.get(c.source, c.snapshot.id, c.tx);
      check(
        c.caller.session?.id === c.leaseId,
        'invalid_lease',
        'The experiment lease must bind its actual worker',
        403,
      );
      const usage = await ctx.sessions.usage(c.source, {
        instanceId: exp.id,
        includeDependencies: false,
      });
      const budget = usage.budgets.find((b) => b.scopeId === exp.id);
      check(
        !usage.liveSessions && !budget?.unreportedSessions && !budget?.unavailable.length,
        'usage_unavailable',
        'Complete accounting is required before another paid experiment visit',
        409,
      );
      const prior = await ctx.priorUsage(exp, c.tx);
      const limits = contractLimits(exp.contract!);
      const remainingSeconds = Math.floor(
        limits.wallMinutes * 60 - (usage.totals.wallMs - prior.wallMs) / 1000,
      );
      const remainingTokens =
        limits.maxTokens - usage.totals.inputTokens - usage.totals.outputTokens + prior.tokens;
      // Keep part of the customer's total allowance for the mandatory results review.
      const reserve = c.snapshot.state === 'running' ? Math.ceil(limits.maxTokens * 0.2) : 0;
      const reserveSeconds =
        c.snapshot.state === 'running' ? Math.ceil(limits.wallMinutes * 60 * 0.2) : 0;
      check(
        remainingSeconds > reserveSeconds && remainingTokens > reserve,
        'budget_exhausted',
        'No execution allowance remains under the accepted contract',
        409,
      );
      let review = null;
      if (c.snapshot.state === 'running')
        await ctx.code.pinBase(
          c.source,
          { unitId: exp.id, leaseId: c.leaseId, writer: true },
          c.tx,
        );
      else review = await ctx.reviews.start(c.caller, (await currentReview(c)).id, c.tx);
      const receipt: Data = {
        leaseId: c.leaseId,
        contractId: exp.contract!.id,
        contractHash: exp.contract!.hash,
        revision: c.snapshot.revision,
        attempt: exp.attempts,
        actorId: c.caller.actorId,
        sourceActorId: c.source.actorId,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
        model: { ...SERVICE_MODEL },
        sessionLimits: {
          durationSeconds: remainingSeconds - reserveSeconds,
          modelTokens: remainingTokens - reserve,
        },
      };
      await insertLease(c.tx, {
        id: c.leaseId,
        projectId: c.caller.projectId,
        snapshot: c.snapshot,
        actorId: c.caller.actorId,
        sourceActorId: c.source.actorId,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
        receipt,
        details: { contractId: exp.contract!.id, model: SERVICE_MODEL },
      });
      return receipt;
    },
  });
  const reviewEdges = ['accept_results', 'repair_execution', 'change_scope'];
  return {
    successStates: ['complete'],
    assignments: ['running', 'results_review'].map((state) => ({
      state,
      check: checkAdmission,
      execution: serviceExecution(state === 'results_review', version),
      lease,
      references: async (c) => {
        const exp = await facts(c);
        const review = exp.review;
        const captures =
          state === 'running' ? (await ctx.computeEvidence(exp, c.tx)).artifactIds : [];
        const base = state === 'running' ? await ctx.code.basePin(c.caller, exp.id, c.tx) : null;
        return {
          computeKind: 'experiment',
          computeProfile: state === 'running' ? 'execute' : 'check',
          ...(!executorsAwaitCompute && { computeWait: 'inside' }),
          artifacts: [
            ...new Set([
              await ctx.contractArtifact(exp, c.tx),
              ...contractDatasets(exp.contract!).map((d) => d.artifactId),
              ...captures,
              ...(review?.artifactIds ?? []),
            ]),
          ],
          reviews: review ? [review.id] : [],
          ...(base ? { base: base.reference } : {}),
          ...(state === 'results_review'
            ? {
                code: exp.submission!.codeHead!,
                reviewId: review!.id,
                ...(review?.claimId ? { claimId: review.claimId } : {}),
              }
            : {}),
        };
      },
      build: async (c) => {
        const exp = await facts(c);
        const review = state === 'results_review';
        const compute = ctx.compute ? computeGuidance(review ? 'check' : 'execute') : '';
        const instruction = review
          ? 'Independently verify the retained results against the frozen customer contract. Submit review.submit with pass, or a precise return route. Never change the plan.'
          : postsProgress(c.snapshot.version)
            ? progressInstruction
            : plansDocument(c.snapshot.version)
              ? documentInstruction
              : writesReport(c.snapshot.version)
                ? reportInstruction
                : 'Execute only this accepted contract. Validate every downloaded dataset SHA-256 before use. Select suitable hardware internally, including GPU rentals through the native Sandboxes connection when available. Inspect current inventory and pricing before choosing; the customer does not select or approve a fixed GPU type. Use only the authorized account allowance, bounded job timeouts and rental leases, release unused machines, and do not use paid external APIs or unapproved training. Complete explicit native Capture nodes for remote outputs and wait until their Merv artifact collections are registered before handing off; machine files and temporary Snapshots are not retained evidence. Save code with code.commit and results/report as artifacts, then call customer_experiment.submit_results. Stop after successful handoff; final capture and independent review follow automatically. If feasibility changes, report it faithfully in the results; do not change scope.';
        return {
          role: review ? 'Independent results reviewer' : 'Experiment executor',
          label: `${review ? 'Review' : 'Run'}: ${exp.title}`,
          name: exp.title,
          brief: `${instruction}${compute}\n\nFixed customer contract:\n${JSON.stringify(exp.contract)}\n\n${exp.submission ? `Submitted results: ${JSON.stringify(exp.submission)}` : ''}\n${exp.review ? `Previous or current review: ${JSON.stringify(exp.review)}` : ''}`,
          references: [
            {
              kind: 'artifact',
              id: await ctx.contractArtifact(exp, c.tx),
              label: 'Customer-accepted contract',
            },
          ],
          handoff: {
            instruction,
            tools: [review ? 'review.submit' : 'customer_experiment.submit_results'],
          },
          execution: { readOnly: review, tools: [] },
          context: null,
        };
      },
    })),
    describe: async (c) => {
      const exp = await facts(c);
      return {
        label: exp.title,
        references: [],
        gate: exp.workflow.state,
        waiting:
          (
            {
              planning: 'The intake agent is collecting an executable agreement.',
              ready: 'The customer must approve the displayed fixed contract.',
              awaiting_payment: 'Execution waits for verified payment.',
              finalizing: 'Wait for the execution session to retain its final code capture.',
            } as Record<string, string>
          )[exp.workflow.state] ?? 'Work runs under the exact accepted contract.',
      };
    },
    actions: [
      ...SERVICE_EXPERIMENT.edges
        .filter((e) => !reviewEdges.includes(e.action))
        .reduce(
          (items, e) => {
            const existing = items.find((i) => i.name === e.action);
            if (existing) existing.states.push(e.from);
            else
              items.push({
                name: e.action,
                states: [e.from],
                transitions: [e.action],
                tool:
                  e.action === 'submit_results'
                    ? 'customer_experiment.submit_results'
                    : 'customer_experiment.get',
                instruction:
                  e.action === 'submit_results'
                    ? 'Retain outputs, submit results, and stop.'
                    : 'The customer service coordinates this gate.',
                suggested: e.action === 'submit_results',
                check: async (c: WorkflowCheckContext) => {
                  if (ctx.checked.found(c)) return;
                  if (e.action === 'submit_results') {
                    await checkAdmission(c);
                    check(
                      !!c.caller.session,
                      'leased_execution_required',
                      'Only the executing worker can hand off results',
                      403,
                    );
                  } else
                    check(
                      false,
                      'service_gate',
                      'This gate is controlled by the customer experiment service',
                      409,
                    );
                },
              });
            return items;
          },
          [] as WorkflowPolicy['actions'],
        ),
      ...reviewActions<WorkflowCheckContext>({
        names: { start: 'start_results_review', submit: 'submit_results_review' },
        states: ['results_review'],
        transitions: reviewEdges,
        instructions: {
          start: 'Claim the independent results review.',
          submit: 'Judge the frozen customer contract and results.',
        },
        reviews: ctx.reviews,
        current: currentReview,
        submit: async (c) => {
          if (ctx.checked.found(c)) return;
          await ctx.worker(c.caller, await facts(c), c.tx);
          await ctx.reviews.checkSubmit(c.caller, (await currentReview(c)).id, undefined, c.tx);
        },
      }),
    ],
  };
}
