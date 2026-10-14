import {
  check,
  childRequest,
  digest,
  inTransaction,
  newId,
  now,
  plain,
  recorded,
  replayed,
  type Artifacts,
  type Caller,
  type Data,
  type Reviews,
  type ReviewApplication,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { Code } from '@merv/code-work/types';
import type { Sessions } from '@merv/sessions/types';
import type { CaptureEvidence, SandboxCaptureEvidence } from '@merv/sandboxes/sandbox-evidence';
import { CheckedTransitions } from '@merv/workflows/rules';
import { heldLease } from '@merv/workflows/lease-rows';
import { SERVICE_EXPERIMENT } from './program.js';
import { executionPolicy } from './execution.js';
import { migrations, planSchema, submitResultsSchema, validateAgreement } from './schema.js';
import {
  SERVICE_MODEL,
  type CustomerExperiment,
  type ExperimentContract,
  type ExperimentPlan,
  type ResultSubmission,
  type ValidatedDataset,
} from './types.js';

interface Row {
  id: string;
  project_id: string;
  title: string;
  owner_id: string;
  contract_id: string | null;
  accepted_contract_id: string | null;
  accepted_at: string | null;
  email: string | null;
  payment_id: string | null;
  attempts: number;
  submission_id: string | null;
  review_id: string | null;
  code_head: string | null;
  created_at: string;
}
export class CustomerExperiments {
  readonly checked = new CheckedTransitions();
  handle?: Awaited<ReturnType<Workflows['register']>>;
  private releaseOwner?: () => void;
  private closed = false;
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly artifacts: Artifacts,
    readonly workflows: Workflows,
    readonly reviews: Reviews,
    readonly code: Code,
    readonly sessions: Sessions,
    readonly price = { amountCents: 500, currency: 'usd' as const },
    readonly compute?: SandboxCaptureEvidence & {
      settled(
        projectId: string,
        instanceId: string,
        epoch: string,
        notBefore: string,
        tx: Transaction,
      ): Promise<boolean>;
    },
  ) {}
  async initialize(): Promise<void> {
    await this.state.migrate('customer-experiments', migrations);
    this.handle = await this.workflows.register(SERVICE_EXPERIMENT, executionPolicy(this));
    this.releaseOwner = this.reviews.registerSubmitOwner({
      id: 'customer-experiments',
      owns: async (review, tx) =>
        !!(await tx.get(
          'SELECT id FROM customer_experiments WHERE id=? AND project_id=?',
          review.subjectId,
          review.projectId,
        )),
      claim: async (caller, review, tx) => {
        const exp = await this.get(caller, review.subjectId, tx);
        check(
          exp.workflow.state === 'results_review' && exp.review?.id === review.id,
          'stale_review',
          'Only the current results review can be claimed',
          409,
        );
        check(
          !!caller.session,
          'leased_review_required',
          'Customer experiments require an independent Astra review session',
          403,
        );
      },
      submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
      guidance:
        'Review only the submitted results against the customer-accepted immutable contract. Never approve or rewrite the plan. Pass only after independently checking retained evidence and code. A repair keeps the exact contract; a change in scope returns to planning for fresh human acceptance. Failed experiments and negative findings are valid results when faithfully measured and reported.',
      returns: async () => [
        { value: 'running', label: 'Repair execution under the same contract' },
        { value: 'planning', label: 'Changed scope needs new customer acceptance' },
        { value: 'failed', label: 'Cannot deliver within the accepted limits' },
      ],
      gates: async (ids) => Object.fromEntries(ids.map((id) => [id, 'Results'])),
    });
  }
  close(): void {
    this.closed = true;
    this.releaseOwner?.();
    this.handle?.dispose();
  }
  private open(): void {
    check(
      !this.closed && this.handle,
      'customer_experiments_unavailable',
      'Customer experiments is unavailable',
      503,
    );
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<CustomerExperiment> {
    this.open();
    caller = structuredClone(caller);
    return inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await tx.get<Row>(
        'SELECT * FROM customer_experiments WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      );
      check(row, 'not_found', 'Customer experiment not found', 404);
      const contract = row.contract_id
        ? await tx.get<{ record: string }>(
            'SELECT record FROM customer_experiment_contracts WHERE id=?',
            row.contract_id,
          )
        : null;
      const submission = row.submission_id
        ? await tx.get<{ record: string }>(
            'SELECT record FROM customer_experiment_submissions WHERE id=?',
            row.submission_id,
          )
        : null;
      const retained = row.submission_id
        ? await tx.get<{ artifact_ids: string }>(
            'SELECT artifact_ids FROM customer_experiment_retained_outputs WHERE submission_id=?',
            row.submission_id,
          )
        : null;
      return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        ownerId: row.owner_id,
        workflow: await this.workflows.get(caller, id, tx),
        contract: contract ? JSON.parse(contract.record) : null,
        acceptedContractId: row.accepted_contract_id,
        acceptedAt: row.accepted_at,
        email: row.email,
        paymentId: row.payment_id,
        attempts: Number(row.attempts),
        submission: submission
          ? {
              ...JSON.parse(submission.record),
              ...(retained ? { artifactIds: JSON.parse(retained.artifact_ids) } : {}),
              ...(row.code_head ? { codeHead: row.code_head } : {}),
            }
          : null,
        review: row.review_id ? await this.reviews.get(caller, row.review_id, tx) : null,
        createdAt: row.created_at,
      };
    });
  }
  async create(
    caller: Caller,
    input: { title: string; requestId: string },
  ): Promise<CustomerExperiment> {
    this.open();
    caller = structuredClone(caller);
    input = plain(input);
    check(
      input.title.trim().length > 0 && input.title.length <= 160,
      'invalid_title',
      'Provide a title of at most 160 characters',
    );
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      check(
        !caller.session && !caller.conversation,
        'forbidden',
        'Only the trusted request adapter creates isolated experiments',
        403,
      );
      return this.command(caller, 'create', input, tx, async () => {
        check(
          !(await tx.get(
            'SELECT id FROM customer_experiments WHERE project_id=?',
            caller.projectId,
          )),
          'project_not_isolated',
          'Each customer experiment needs a new isolated project',
          409,
        );
        check(
          (await this.workflows.list(caller, tx)).length === 0,
          'project_not_isolated',
          'The customer project must not contain other work',
          409,
        );
        await this.code.ensureRepository(caller, tx);
        const workflow = await this.handle!.start(
          caller,
          {
            workflow: SERVICE_EXPERIMENT.name,
            version: 1,
            requestId: childRequest(caller, 'customer-experiments', 'create', input.requestId),
            data: { name: input.title, workspace: 'git' },
          },
          tx,
        );
        await tx.run(
          'INSERT INTO customer_experiments(id,project_id,title,owner_id,created_at) VALUES(?,?,?,?,?)',
          workflow.id,
          caller.projectId,
          input.title,
          (await this.scope.authorityActor(caller, tx)).id,
          now(),
        );
        await this.code.declareUnit(caller, workflow.id, tx);
        await recorded(this.state, tx, caller, 'customer_experiment.created', workflow.id, {});
        return this.get(caller, workflow.id, tx);
      });
    });
  }
  async propose(
    caller: Caller,
    input: {
      id: string;
      expectedRevision: number;
      plan: ExperimentPlan;
      datasets: ValidatedDataset[];
      requestId: string;
    },
    transaction?: Transaction,
  ): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    input = plain(input);
    input.plan = planSchema.parse(input.plan);
    validateAgreement(input.plan, input.datasets);
    return inTransaction(this.state, transaction, async (tx) =>
      this.command(caller, 'propose', input, tx, async () => {
        const exp = await this.mutable(caller, input.id, input.expectedRevision, tx);
        check(
          ['planning', 'ready'].includes(exp.workflow.state),
          'fixed_contract',
          'The accepted contract cannot be edited',
          409,
        );
        for (const data of input.datasets) {
          const artifact = await this.artifacts.get(caller, data.artifactId, tx);
          check(
            artifact.projectId === caller.projectId,
            'foreign_dataset',
            'Dataset must belong to this experiment',
            403,
          );
        }
        if (exp.workflow.state === 'ready')
          await this.move(caller, exp, 'revise', input.requestId + ':revise', tx);
        const current = await this.get(caller, input.id, tx);
        const version = (exp.contract?.version ?? 0) + 1;
        const body = {
          id: newId('contract'),
          version,
          plan: input.plan,
          datasets: input.datasets,
          model: SERVICE_MODEL,
          price: this.price,
          createdAt: now(),
        };
        const contract: ExperimentContract = { ...body, hash: digest(body) };
        const artifact = await this.artifacts.create(
          caller,
          {
            title: `Accepted offer ${version}: ${input.plan.title}`,
            content: JSON.stringify(contract),
            mediaType: 'application/json',
          },
          tx,
        );
        await tx.run(
          'INSERT INTO customer_experiment_contracts(id,experiment_id,version,hash,artifact_id,record) VALUES(?,?,?,?,?,?)',
          contract.id,
          exp.id,
          version,
          contract.hash,
          artifact.id,
          JSON.stringify(contract),
        );
        await tx.run(
          'UPDATE customer_experiments SET contract_id=?,title=? WHERE id=?',
          contract.id,
          input.plan.title,
          exp.id,
        );
        await this.move(caller, current, 'propose', input.requestId, tx);
        return this.get(caller, exp.id, tx);
      }),
    );
  }
  async revise(
    caller: Caller,
    input: { id: string; expectedRevision: number; requestId: string },
    transaction?: Transaction,
  ): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    input = plain(input);
    return inTransaction(this.state, transaction, async (tx) =>
      this.command(caller, 'revise', input, tx, async () => {
        const exp = await this.mutable(caller, input.id, input.expectedRevision, tx);
        check(
          exp.workflow.state === 'ready',
          'fixed_contract',
          'Only an unaccepted offer can return to intake',
          409,
        );
        await this.move(caller, exp, 'revise', input.requestId, tx);
        return this.get(caller, exp.id, tx);
      }),
    );
  }
  /** Trusted adapter only: the HTTP customer capability, never an intake/worker tool. */
  async approve(
    caller: Caller,
    input: {
      id: string;
      expectedRevision: number;
      contractHash: string;
      email: string;
      requestId: string;
    },
    transaction?: Transaction,
  ): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    input = plain(input);
    check(
      !caller.session && !caller.conversation,
      'forbidden',
      'Only the customer approval adapter can accept a contract',
      403,
    );
    check(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) && input.email.length <= 254,
      'invalid_email',
      'A results email is required',
    );
    return inTransaction(this.state, transaction, async (tx) =>
      this.command(caller, 'approve', input, tx, async () => {
        const exp = await this.mutable(caller, input.id, input.expectedRevision, tx);
        check(
          exp.workflow.state === 'ready' && exp.contract?.hash === input.contractHash,
          'stale_contract',
          'Read and accept the current ready contract',
          409,
        );
        const acceptedAt = now();
        await tx.run(
          'INSERT INTO customer_experiment_acceptances(contract_id,experiment_id,email,accepted_at) VALUES(?,?,?,?)',
          exp.contract.id,
          exp.id,
          input.email,
          acceptedAt,
        );
        await tx.run(
          'UPDATE customer_experiments SET accepted_contract_id=?,accepted_at=?,email=? WHERE id=?',
          exp.contract.id,
          acceptedAt,
          input.email,
          exp.id,
        );
        await this.move(caller, exp, 'approve', input.requestId, tx);
        return this.get(caller, exp.id, tx);
      }),
    );
  }
  /** Called only with a signature-verified provider event; no customer/agent route exposes it. */
  async confirmPayment(
    caller: Caller,
    input: {
      id: string;
      contractHash: string;
      paymentId: string;
      amountCents: number;
      currency: string;
      requestId: string;
    },
    transaction?: Transaction,
  ): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    input = plain(input);
    check(
      !caller.session && !caller.conversation,
      'forbidden',
      'Only the trusted payment adapter can release execution',
      403,
    );
    return inTransaction(this.state, transaction, async (tx) =>
      this.command(caller, 'payment', input, tx, async () => {
        await this.scope.require(caller, 'write', tx);
        const exp = await this.get(caller, input.id, tx);
        const c = exp.contract;
        const prior = await tx.get<{ contract_id: string; amount_cents: number; currency: string }>(
          'SELECT contract_id,amount_cents,currency FROM customer_experiment_payments WHERE payment_id=?',
          input.paymentId,
        );
        if (prior) {
          check(
            prior.contract_id === c?.id && c.hash === input.contractHash,
            'payment_reused',
            'A payment belongs to one exact contract',
            409,
          );
          check(
            Number(prior.amount_cents) === input.amountCents &&
              prior.currency === input.currency.toLowerCase(),
            'payment_mismatch',
            'A repeated payment must preserve the verified amount and currency',
            409,
          );
          return exp;
        }
        check(
          exp.workflow.state === 'awaiting_payment' &&
            c &&
            c.id === exp.acceptedContractId &&
            c.hash === input.contractHash,
          'stale_contract',
          'Payment must name the currently accepted contract',
          409,
        );
        check(
          input.amountCents === c.price.amountCents &&
            input.currency.toLowerCase() === c.price.currency,
          'payment_mismatch',
          'Payment does not match the accepted price',
          409,
        );
        check(
          input.paymentId.trim().length > 0,
          'invalid_payment',
          'A provider payment ID is required',
        );
        const usage = await this.sessions.usage(caller, {
          instanceId: exp.id,
          includeDependencies: false,
        });
        check(
          !usage.liveSessions &&
            !usage.budgets.some((b) => b.unreportedSessions || b.unavailable.length),
          'usage_unavailable',
          'A new contract waits for complete accounting of the previous run',
          409,
        );
        const priorTokens = usage.totals.inputTokens + usage.totals.outputTokens;
        await tx.run(
          'INSERT INTO customer_experiment_payments(payment_id,contract_id,experiment_id,amount_cents,currency,created_at,prior_wall_ms,prior_tokens) VALUES(?,?,?,?,?,?,?,?)',
          input.paymentId,
          c.id,
          exp.id,
          input.amountCents,
          c.price.currency,
          now(),
          usage.totals.wallMs,
          priorTokens,
        );
        await tx.run(
          'UPDATE customer_experiments SET payment_id=?,attempts=1 WHERE id=?',
          input.paymentId,
          exp.id,
        );
        await this.sessions.dispatch.setBudget(
          caller,
          {
            instanceId: exp.id,
            maxWallMinutes: c.plan.limits.wallMinutes + Math.ceil(usage.totals.wallMs / 60000),
            maxTokens: c.plan.limits.maxTokens + priorTokens,
          },
          tx,
        );
        await this.move(caller, exp, 'confirm_payment', input.requestId, tx, {
          contractId: c.id,
          contractHash: c.hash,
          computeEpoch: `${c.id}:1`,
        });
        return this.get(caller, exp.id, tx);
      }),
    );
  }
  async submitResults(caller: Caller, value: unknown): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    const input = submitResultsSchema.parse(value);
    return this.state.transaction(async (tx) =>
      this.command(caller, 'submit_results', input, tx, async () => {
        const exp = await this.mutable(caller, input.id, input.expectedRevision, tx);
        await this.worker(caller, exp, tx);
        check(
          exp.workflow.state === 'running',
          'invalid_state',
          'Only the executing worker submits results',
          409,
        );
        const captures = new Set((await this.computeEvidence(exp, tx)).artifactIds);
        const ids = [...new Set([...input.artifactIds, ...captures])];
        const artifacts = await this.artifacts.getAll(caller, ids, tx);
        check(
          artifacts.every((a) => captures.has(a.id) || a.createdBy === caller.actorId),
          'invalid_evidence_author',
          'Results must be retained by the executing worker or this attempt’s native compute',
          403,
        );
        const outputs = new Set(
          (await this.artifacts.executionOutputs(caller, tx)).map((a) => a.id),
        );
        check(
          ids.every((id) => captures.has(id) || outputs.has(id)),
          'invalid_evidence_origin',
          'Results must be outputs of this execution session or this attempt’s native compute',
          403,
        );
        check(
          ids.some((id) => !captures.has(id) && outputs.has(id)),
          'result_report_required',
          'Retain an authored result report alongside any native compute captures',
          409,
        );
        const submission: ResultSubmission = {
          id: newId('submission'),
          contractId: exp.acceptedContractId!,
          artifactIds: ids,
          summary: input.summary,
          producerId: caller.actorId,
          sessionId: caller.session!.id,
          executionRevision: exp.workflow.revision,
          createdAt: now(),
        };
        await tx.run(
          'INSERT INTO customer_experiment_submissions(id,experiment_id,record) VALUES(?,?,?)',
          submission.id,
          exp.id,
          JSON.stringify(submission),
        );
        await tx.run(
          'UPDATE customer_experiments SET submission_id=?,code_head=NULL WHERE id=?',
          submission.id,
          exp.id,
        );
        await this.move(caller, exp, 'submit_results', input.requestId, tx);
        return this.get(caller, exp.id, tx);
      }),
    );
  }
  /** Poll/startup recovery: a finalizing node cannot dispatch or review before final capture. */
  async reconcile(caller: Caller, id: string): Promise<CustomerExperiment> {
    caller = structuredClone(caller);
    return this.state.transaction(async (tx) => {
      const exp = await this.get(caller, id, tx);
      if (['running', 'results_review'].includes(exp.workflow.state)) {
        const usage = await this.sessions.usage(caller, {
          instanceId: id,
          includeDependencies: false,
        });
        // A visit still owns its full reservation until it has closed and reported its use.
        if (usage.liveSessions) return exp;
        const prior = await this.priorUsage(exp, tx);
        const limit = exp.contract!.plan.limits;
        const reserve = exp.workflow.state === 'running' ? 0.2 : 0;
        const wallRemaining = limit.wallMinutes * 60 - (usage.totals.wallMs - prior.wallMs) / 1000;
        const tokensRemaining =
          limit.maxTokens - usage.totals.inputTokens - usage.totals.outputTokens + prior.tokens;
        const accountingComplete = !usage.budgets.some(
          (b) => b.unreportedSessions || b.unavailable.length,
        );
        if (
          wallRemaining <= Math.ceil(limit.wallMinutes * 60 * reserve) ||
          (accountingComplete && tokensRemaining <= Math.ceil(limit.maxTokens * reserve))
        ) {
          await this.scope.require(caller, 'write', tx);
          if (exp.review && ['requested', 'started'].includes(exp.review.status))
            await this.reviews.supersede(caller, exp.review.id, tx);
          const failureReason =
            exp.workflow.state === 'running'
              ? 'Execution stopped before delivering results within the accepted time and token allowance. No additional run or charge was authorized.'
              : 'Independent results review could not finish within the accepted allowance. The results have not been approved.';
          await this.move(
            caller,
            exp,
            'fail',
            `allowance-exhausted:${exp.contract!.id}:${exp.workflow.revision}`,
            tx,
            { failureReason },
          );
          return this.get(caller, id, tx);
        }
        return exp;
      }
      if (exp.workflow.state !== 'finalizing') return exp;
      await this.scope.require(caller, 'write', tx);
      const sub = exp.submission!;
      if (this.compute) {
        const session = await this.sessions.get(caller, sub.sessionId);
        // A code capture alone does not prove remote work and evidence publication settled.
        if (
          !session.closedAt ||
          !(await this.compute.settled?.(
            exp.projectId,
            exp.id,
            `${exp.acceptedContractId}:${exp.attempts}`,
            session.closedAt,
            tx,
          ))
        )
          return exp;
      }
      const capture = await this.code.capture(
        caller,
        { kind: 'session-final', sessionId: sub.sessionId },
        tx,
      );
      if (capture.status === 'pending' || capture.status === 'none') return exp;
      if (capture.status === 'failed') {
        await this.move(caller, exp, 'fail', `capture-failed:${sub.id}`, tx, {
          failureReason:
            'The execution ended without a usable final code capture, so its results could not be independently verified.',
        });
        return this.get(caller, id, tx);
      }
      check(
        capture.workspace &&
          capture.provenance.instanceId === id &&
          capture.provenance.revision === sub.executionRevision &&
          capture.provenance.actorId === sub.producerId &&
          capture.provenance.workflow.name === SERVICE_EXPERIMENT.name &&
          capture.provenance.workflow.state === 'running' &&
          !capture.provenance.readOnly,
        'invalid_code_capture',
        'Final code must belong to the exact submitted execution',
        409,
      );
      const contractArtifact = await this.contractArtifact(exp, tx);
      const compute = await this.computeEvidence(exp, tx);
      const retainedOutputs = [...new Set([...sub.artifactIds, ...compute.artifactIds])];
      const receipt = await this.artifacts.create(
        caller,
        {
          title: 'Retained execution code',
          content: JSON.stringify({
            submission: sub.id,
            contractHash: exp.contract!.hash,
            ref: capture.ref,
            provenance: capture.provenance,
            workspace: capture.workspace,
            model: SERVICE_MODEL,
            computeEpoch: exp.workflow.data.computeEpoch,
            compute,
          }),
          mediaType: 'application/json',
        },
        tx,
      );
      await tx.run(
        'INSERT INTO customer_experiment_retained_outputs(submission_id,artifact_ids,receipt_id) VALUES(?,?,?)',
        sub.id,
        JSON.stringify(retainedOutputs),
        receipt.id,
      );
      const pinned = [
        contractArtifact,
        receipt.id,
        ...exp.contract!.datasets.map((d) => d.artifactId),
        ...compute.artifactIds,
      ];
      const review = await this.reviews.request(
        caller,
        {
          subjectId: id,
          subjectRevision: exp.workflow.revision + 1,
          producerId: sub.producerId,
          administrativeActorId: exp.ownerId,
          artifactIds: [...new Set([...pinned, ...retainedOutputs])],
          pinnedInputIds: [...new Set(pinned)],
          criteria: [
            'Execution implements the exact customer-accepted contract and data manifest without undisclosed scope changes.',
            'Retained code, logs and measurements support the reported metric and baseline comparison.',
            'The conclusion answers the customer decision, reports uncertainty and failures honestly, and supplies every agreed deliverable.',
          ],
          requiredCriteria: [1, 2, 3],
          requestId: `results:${sub.id}`,
        },
        tx,
      );
      await tx.run(
        'UPDATE customer_experiments SET review_id=?,code_head=? WHERE id=?',
        review.id,
        capture.workspace.headOid,
        id,
      );
      await this.move(caller, exp, 'retain_results', `retain:${sub.id}`, tx);
      return this.get(caller, id, tx);
    });
  }
  async submitReview(
    caller: Caller,
    input: ReviewApplication,
    tx: Transaction,
  ): Promise<CustomerExperiment> {
    const review = await this.reviews.get(caller, input.reviewId, tx);
    return this.command(caller, 'review', input, tx, async () => {
      const exp = await this.get(caller, review.subjectId, tx);
      this.revision(exp, input.expectedRevision);
      await this.worker(caller, exp, tx);
      check(
        exp.workflow.state === 'results_review' && exp.review?.id === input.reviewId,
        'stale_review',
        'Review must name the current immutable results',
        409,
      );
      let action = 'accept_results';
      if (input.verdict !== 'pass') {
        check(
          ['running', 'planning', 'failed'].includes(input.returnTo ?? ''),
          'return_required',
          'Choose repair, changed scope or failure',
        );
        action =
          input.returnTo === 'planning'
            ? 'change_scope'
            : input.returnTo === 'failed'
              ? 'fail'
              : 'repair_execution';
        if (action === 'repair_execution')
          check(
            exp.attempts < exp.contract!.plan.limits.maxAttempts,
            'attempt_limit',
            'This contract has no repair attempts left; report failure or request a new scope',
            409,
          );
      }
      await this.reviews.submit(caller, input, tx);
      if (action === 'repair_execution')
        await tx.run('UPDATE customer_experiments SET attempts=attempts+1 WHERE id=?', exp.id);
      if (action === 'change_scope')
        await tx.run(
          'UPDATE customer_experiments SET accepted_contract_id=NULL,accepted_at=NULL,payment_id=NULL WHERE id=?',
          exp.id,
        );
      await this.move(
        caller,
        exp,
        action,
        input.requestId,
        tx,
        action === 'repair_execution'
          ? { computeEpoch: `${exp.contract!.id}:${exp.attempts + 1}` }
          : action === 'change_scope'
            ? { computeEpoch: `${exp.contract!.id}:planning:${exp.workflow.revision + 1}` }
            : {},
        input as unknown as Data,
      );
      return this.get(caller, exp.id, tx);
    });
  }
  async contractArtifact(exp: CustomerExperiment, tx: Transaction): Promise<string> {
    const row = await tx.get<{ artifact_id: string }>(
      'SELECT artifact_id FROM customer_experiment_contracts WHERE id=?',
      exp.contract?.id ?? '',
    );
    check(row, 'contract_required', 'A frozen contract is required', 409);
    return row.artifact_id;
  }
  /** Native evidence is scoped to this instance and accepted attempt, never another request. */
  async computeEvidence(exp: CustomerExperiment, tx: Transaction): Promise<CaptureEvidence> {
    if (!this.compute || !exp.acceptedContractId) return { artifactIds: [], refused: [] };
    return (
      (
        await this.compute.evidence(
          exp.projectId,
          [{ instanceId: exp.id, attempts: [`${exp.acceptedContractId}:${exp.attempts}`] }],
          tx,
        )
      ).get(exp.id) ?? { artifactIds: [], refused: [] }
    );
  }
  async priorUsage(
    exp: CustomerExperiment,
    tx: Transaction,
  ): Promise<{ wallMs: number; tokens: number }> {
    const row = await tx.get<{ prior_wall_ms: number; prior_tokens: number }>(
      'SELECT prior_wall_ms,prior_tokens FROM customer_experiment_payments WHERE payment_id=? AND contract_id=?',
      exp.paymentId ?? '',
      exp.acceptedContractId ?? '',
    );
    check(row, 'payment_required', 'A paid contract is required for an execution allowance', 409);
    return { wallMs: Number(row.prior_wall_ms), tokens: Number(row.prior_tokens) };
  }
  async worker(caller: Caller, exp: CustomerExperiment, tx: Transaction): Promise<void> {
    await heldLease(
      this.state,
      tx,
      { projectId: caller.projectId, instanceId: exp.id, revision: exp.workflow.revision },
      caller,
    );
    check(
      exp.acceptedContractId === exp.contract?.id && !!exp.paymentId,
      'execution_locked',
      'Only the accepted and paid contract can execute',
      409,
    );
  }
  async mutable(
    caller: Caller,
    id: string,
    revision: number,
    tx: Transaction,
  ): Promise<CustomerExperiment> {
    await this.scope.require(caller, 'write', tx);
    const exp = await this.get(caller, id, tx);
    this.revision(exp, revision);
    return exp;
  }
  revision(exp: CustomerExperiment, revision: number): void {
    check(
      exp.workflow.revision === revision,
      'revision_conflict',
      'The experiment changed; refresh the current plan',
      409,
    );
  }
  async move(
    caller: Caller,
    exp: CustomerExperiment,
    action: string,
    requestId: string,
    tx: Transaction,
    data: Data = {},
    input?: Data,
  ): Promise<void> {
    this.open();
    await this.checked.take(
      tx,
      { instanceId: exp.id, revision: exp.workflow.revision, action },
      () =>
        this.handle!.transition(
          caller,
          {
            instanceId: exp.id,
            expectedRevision: exp.workflow.revision,
            action,
            requestId: childRequest(caller, 'customer-experiments', action, requestId),
            data,
            input,
          },
          tx,
        ),
    );
    await recorded(this.state, tx, caller, `customer_experiment.${action}`, exp.id, {
      contractId: exp.contract?.id ?? null,
    });
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    run: () => Promise<T>,
  ): Promise<T> {
    this.open();
    await this.scope.require(caller, operation === 'review' ? 'review' : 'write', tx);
    return replayed(tx, 'customer_experiment_commands', caller, operation, input, run);
  }
}
