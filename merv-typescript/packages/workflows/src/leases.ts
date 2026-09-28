import { check, effectiveWorkspace, MervError, recorded, ROLES, visible } from '@merv/contracts';
import type {
  Caller,
  Role,
  Transaction,
  WorkflowSnapshot,
  WorkflowAssignment,
  WorkflowBegin,
  WorkflowWorkStart,
  WorkflowExecution,
  WorkflowExecutionReferences,
  WorkflowExecutionTarget,
  WorkflowDispatchCandidate,
  WorkflowLease,
  WorkflowLeaseOffer,
  WorkflowAssignmentRule,
} from '@merv/contracts';
import { workflowJson } from './json.js';
import { checkAssignment, readContext, throwStateFault, type EngineContext } from './evaluation.js';
import { buildAssignment, workStartsAt } from './assignments.js';
import { limitStatusesOf } from './limits.js';
import {
  executionDisplay,
  executionFingerprint,
  executionReferences,
  executionMetadata,
} from './execution.js';
import { prerequisites, prerequisitesOf, requireDependencies } from './dependencies.js';
import {
  batches,
  checkInstance,
  checkRevision,
  type InstanceRow,
  type Registration,
} from './engine.js';
import { WorkflowGuidance } from './guidance.js';

/** One step as load() read it: the frozen context every callback of the call is given. */
interface Loaded {
  /** The instance as stored, which the closing recheck compares against. */
  row: InstanceRow;
  snapshot: WorkflowSnapshot;
  registration: Registration;
  rule: WorkflowAssignmentRule;
  context: EngineContext;
}

/** The role a step's lease rule gives its source, once the step's prerequisites are met. */
async function leaseRoleOf(rule: WorkflowAssignmentRule, context: EngineContext): Promise<Role> {
  if (rule.requiresDependencies) requireDependencies(context.dependencies);
  const role = await rule.lease!.role(context);
  check(ROLES.includes(role), 'invalid_workflow_policy', 'Lease role must be declared', 500);
  return role;
}

/** Assignments, leases and dispatch: admitting a step and granting its execution. */
export class WorkflowLeases extends WorkflowGuidance {
  async assignment(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowAssignment> {
    return await this.assignmentInternal(caller, instanceId, undefined, tx);
  }

  async begin(caller: Caller, input: WorkflowBegin, tx?: Transaction): Promise<WorkflowAssignment> {
    checkRevision(input.expectedRevision);
    return await this.assignmentInternal(caller, input.instanceId, input.expectedRevision, tx);
  }

  async dispatchCandidates(
    source: Caller,
    transaction?: Transaction,
    worker?: string,
  ): Promise<WorkflowDispatchCandidate[]> {
    return await this.reading(source, transaction, async (tx, source) => {
      check(!source.session, 'forbidden', 'A leased worker cannot schedule assignments', 403);
      // Only a step with a lease rule can be a candidate; finished work never is, and it is
      // most of a project's history.
      const leasable = (registration: Registration) =>
        (registration.policy?.assignments ?? []).filter((rule) => rule.lease && rule.execution);
      const registered = new Map(
        [...this.registrations].filter(([, registration]) => leasable(registration).length),
      );
      const steps = [...registered.values()].flatMap((registration) =>
        leasable(registration).map((rule) => [
          registration.definition.name,
          registration.definition.version,
          rule.state,
        ]),
      );
      if (!steps.length) return [];
      const rows = await tx.all<InstanceRow>(
        `SELECT * FROM wf_instances WHERE project_id=? AND (workflow,version,state) IN (${steps
          .map(() => '(?,?,?)')
          .join(',')}) ORDER BY created_at,id`,
        source.projectId,
        ...steps.flat(),
      );
      const candidates: WorkflowDispatchCandidate[] = [];
      for (const part of batches(rows)) {
        const found = part.map((row) => {
          const registration = registered.get(`${row.workflow}@${row.version}`)!;
          const rule = leasable(registration).find((rule) => rule.state === row.state)!;
          return { row, registration, rule };
        });
        const limits = await limitStatusesOf(
          tx,
          found.map(({ row, registration }) => ({
            id: row.id,
            state: row.state,
            policy: registration.policy,
          })),
        );
        // A reviewer leased at an exhausted limit could only have a needs_changes verdict
        // refused and rolled back, and the next poll would lease another. The work waits for
        // a human instead, who may still begin it by hand.
        const open = found.filter(({ row }) => !limits.get(row.id)!.some((item) => item.exhausted));
        const dependencies = await prerequisites(
          tx,
          source.projectId,
          open.map(({ row }) => row.id),
        );
        for (const { row, registration, rule } of open) {
          const lease = rule.lease!;
          const execution = rule.execution!;
          const snapshot = this.snapshot(row);
          // One frozen read serves every callback of the row; the recheck below closes them all.
          const context = readContext({
            caller: source,
            snapshot,
            tx,
            dependencies: dependencies.get(row.id)!,
          });
          try {
            const role = await leaseRoleOf(rule, context);
            const label = lease.label
              ? await lease.label(context)
              : `${snapshot.workflow}: ${snapshot.state}`;
            check(
              typeof label === 'string' && visible(label),
              'invalid_workflow_policy',
              'Dispatch labels must be nonempty',
              500,
            );
            const excluded =
              !!worker && !!lease.excludes && (await lease.excludes(context, worker));
            this.requireActive(registration);
            if (excluded) continue;
            candidates.push({
              instanceId: snapshot.id,
              projectId: source.projectId,
              expectedRevision: snapshot.revision,
              workflow: snapshot.workflow,
              version: snapshot.version,
              state: snapshot.state,
              role,
              readOnly: execution.readOnly,
              label,
              policyHash: executionFingerprint(execution),
              registrationId: registration.registrationId,
              workspace: effectiveWorkspace(execution),
              updatedAt: snapshot.updatedAt,
            });
          } catch (error) {
            // Domain admission refusals make a node ineligible. Malformed programs and State
            // faults fail visibly.
            if (!(error instanceof MervError) || ![403, 404, 409, 503].includes(error.status))
              throw error;
            throwStateFault(error);
          }
        }
      }
      // Refused rows too: a callback may write and then refuse.
      await this.recheck(tx, rows, 'Dispatch callbacks must not change the workflow instance');
      // Every row's callbacks have run: a source they revoked is refused here, and the scan
      // rolls back.
      await this.scope.require(source, 'read', tx);
      // Stable sorting preserves the creation/id order within each execution class.
      this.assertOpen();
      return candidates
        .filter(
          (item) =>
            this.registrations.get(`${item.workflow}@${item.version}`)?.registrationId ===
            item.registrationId,
        )
        .sort((left, right) => Number(right.readOnly) - Number(left.readOnly));
    });
  }

  async leaseRole(
    source: Caller,
    { ...target }: WorkflowExecutionTarget,
    transaction?: Transaction,
  ): Promise<Role> {
    source = structuredClone(source);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      const { role, row, registration } = await this.role(source, target, tx);
      await this.recheck(tx, [row], 'Lease role callbacks must not change the workflow instance');
      this.requireActive(registration);
      return role;
    });
  }

  /** The source's lease role, left for the caller's closing recheck. */
  private async role(
    source: Caller,
    target: WorkflowExecutionTarget,
    tx: Transaction,
  ): Promise<Loaded & { role: Role }> {
    const loaded = await this.load(source, target, 'lease', tx);
    const role = await leaseRoleOf(loaded.rule, loaded.context);
    this.requireActive(loaded.registration);
    return { ...loaded, role };
  }

  async offerLease(
    source: Caller,
    worker: Caller,
    { ...target }: WorkflowExecutionTarget & { leaseId: string },
    transaction?: Transaction,
  ): Promise<WorkflowLeaseOffer> {
    ({ source, worker } = structuredClone({ source, worker }));
    return await this.write(transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      const {
        role,
        row,
        snapshot,
        registration,
        rule,
        context: sourced,
      } = await this.role(source, target, tx);
      check(
        (await this.scope.require(worker, 'read', tx)).role === role,
        'invalid_lease',
        'Worker role does not match the assignment',
        403,
      );
      check(
        source.projectId === worker.projectId && worker.session?.id === target.leaseId,
        'invalid_lease',
        'Lease must name its authenticated worker and source project',
        403,
      );
      // The worker sees the step the source was just admitted to; the closing recheck
      // refuses it if any callback below moved it.
      const context = readContext({
        caller: worker,
        snapshot,
        tx,
        dependencies: sourced.dependencies,
      });
      const step: Loaded = { row, snapshot, registration, rule, context };
      const receipt = executionMetadata(
        await rule.lease!.acquire(
          Object.freeze({ ...context, source: structuredClone(source), leaseId: target.leaseId }),
        ),
      );
      check(
        receipt && typeof receipt === 'object' && !Array.isArray(receipt),
        'invalid_workflow_policy',
        'Lease acquisition must return an object receipt',
        500,
      );
      this.requireActive(registration);
      // Only now: the execution's references read what acquire wrote (pinned artifacts, the
      // review claim, the Git base).
      await checkAssignment(rule, context);
      const execution = await this.executionOf(step);
      const lease: WorkflowLease = {
        leaseId: target.leaseId,
        instanceId: snapshot.id,
        expectedRevision: snapshot.revision,
        projectId: worker.projectId,
        actorId: worker.actorId,
        workflow: snapshot.workflow,
        version: snapshot.version,
        state: snapshot.state,
        policyHash: execution.policyHash,
        registrationId: execution.registrationId,
        receipt,
      };
      await rule.lease!.check(context, structuredClone(receipt));
      this.requireActive(registration);
      const assignment = await this.assignmentOf(worker, step, false, tx, execution);
      // The source is authorized again once every callback has run: one that revoked it is
      // refused here, and the offer rolls back.
      await this.scope.require(source, 'read', tx);
      await this.recheck(tx, [row], 'Lease acquisition must not transition the workflow');
      this.requireActive(registration);
      return { lease, assignment, execution };
    });
  }

  async checkLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
    frozen?: WorkflowExecution,
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    if (frozen) frozen = workflowJson(frozen, 'invalid_execution_target', 400);
    return await this.read(transaction, async (tx) => {
      const { rule, registration, row, context } = await this.leaseStep(worker, lease, tx);
      let references: WorkflowExecutionReferences | undefined;
      if (frozen) {
        // The registration may have been reloaded since the offer; its caller fences that
        // with the generation this returns. The policy is fenced by its content.
        check(
          frozen.instanceId === lease.instanceId &&
            frozen.projectId === lease.projectId &&
            frozen.actorId === lease.actorId &&
            frozen.workflow === lease.workflow &&
            frozen.version === lease.version &&
            frozen.state === lease.state &&
            frozen.revision === lease.expectedRevision &&
            frozen.policyHash === lease.policyHash &&
            executionFingerprint(frozen.policy) === lease.policyHash,
          'execution_changed',
          'Frozen dispatch authority does not match this active lease',
          409,
        );
        references = executionMetadata(frozen.references);
        if (rule.lease!.outputs) {
          const extra = executionMetadata(
            await rule.lease!.outputs(context, executionMetadata(lease.receipt)),
          );
          for (const [key, ids] of Object.entries(extra)) {
            check(
              Object.hasOwn(references, key) &&
                Array.isArray(references[key]) &&
                Array.isArray(ids) &&
                ids.every((id) => typeof id === 'string' && id.length > 0),
              'invalid_workflow_policy',
              'Resource receipts may extend only declared reference arrays',
              500,
            );
            references[key] = [...new Set([...(references[key] as string[]), ...ids])].sort();
          }
        }
      }
      await this.recheck(tx, [row], 'Lease callbacks must not change the workflow instance');
      this.requireActive(registration);
      return { registrationId: registration.registrationId, ...(references && { references }) };
    });
  }

  /**
   * The lease's admitted step and its program's lease check, left for the caller's closing
   * recheck. References are read once, at the offer: whatever they refuse is either refused
   * here too, by the step's check and the lease check, or fixed once the offer has passed.
   */
  private async leaseStep(worker: Caller, lease: WorkflowLease, tx: Transaction): Promise<Loaded> {
    check(
      worker.actorId === lease.actorId &&
        worker.projectId === lease.projectId &&
        worker.session?.id === lease.leaseId,
      'invalid_lease',
      'Lease belongs to a different worker',
      403,
    );
    await this.scope.require(worker, 'read', tx);
    const step = await this.load(worker, lease, 'execution', tx);
    const { snapshot, rule, registration, context } = step;
    check(
      lease.policyHash === executionFingerprint(rule.execution!),
      'execution_changed',
      'The captured execution policy does not match this workflow state',
      409,
    );
    await checkAssignment(rule, context);
    check(
      snapshot.workflow === lease.workflow &&
        snapshot.version === lease.version &&
        snapshot.state === lease.state,
      'lease_changed',
      'Lease no longer names this workflow state',
      409,
    );
    check(rule.lease, 'lease_unavailable', 'This assignment no longer supports leases', 409);
    await rule.lease.check(context, executionMetadata(lease.receipt));
    this.requireActive(registration);
    return step;
  }

  async activateLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
  ): Promise<WorkflowWorkStart> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    return await this.write(transaction, async (tx) => {
      const { row, snapshot, registration } = await this.leaseStep(worker, lease, tx);
      await this.recheck(tx, [row], 'Execution callbacks must not change the workflow instance');
      const started = await this.markStarted(worker, snapshot, tx);
      this.requireActive(registration);
      return started;
    });
  }

  async releaseLease(
    lease: WorkflowLease,
    { ...input }: { reason: string },
    transaction?: Transaction,
  ): Promise<void> {
    // The same bounds as the offer that issued it: capping the whole lease as metadata refused
    // the release of a receipt the offer had accepted.
    lease = workflowJson(lease, 'invalid_lease', 400);
    executionMetadata(lease.receipt);
    await this.write(transaction, async (tx) => {
      check(
        typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 500,
        'invalid_reason',
        'Lease release requires a bounded reason',
      );
      const registration = this.definition(lease.workflow, lease.version);
      const rule = registration.policy?.assignments?.find((rule) => rule.state === lease.state);
      check(
        rule?.lease && rule.execution && executionFingerprint(rule.execution) === lease.policyHash,
        'lease_unavailable',
        'The pinned lease release authority is unavailable',
        503,
      );
      await rule.lease.release({ lease, reason: input.reason, tx });
      this.requireActive(registration);
    });
  }

  /** The execution an admitted step grants: its fixed policy and the references it names now. */
  private async executionOf({
    snapshot,
    registration,
    rule,
    context,
  }: Loaded): Promise<WorkflowExecution> {
    const references = await executionReferences(rule, context);
    this.requireActive(registration);
    return {
      instanceId: snapshot.id,
      projectId: context.caller.projectId,
      actorId: context.caller.actorId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      policyHash: executionFingerprint(rule.execution!),
      registrationId: registration.registrationId,
      policy: structuredClone(rule.execution!),
      references,
    };
  }

  /**
   * The one entry read of a lease, execution or assignment: tenancy, the named revision, the
   * installed definition, the step's rule and its dependencies. Each purpose keeps its own
   * refusals.
   */
  private async load(
    caller: Caller,
    target: { instanceId: string; expectedRevision?: number },
    purpose: 'lease' | 'execution' | 'assignment',
    tx: Transaction,
  ): Promise<Loaded> {
    this.assertOpen();
    const row = await this.readRow(tx, caller.projectId, target.instanceId);
    const snapshot = this.snapshot(row);
    const expected = target.expectedRevision;
    // Whose hand moved the record is not the engine's question: Sessions reads a worker's own
    // handoff out of this conflict.
    check(
      expected === undefined || snapshot.revision === expected,
      'revision_conflict',
      {
        lease: 'Workflow changed before lease admission',
        execution: 'Workflow changed; refresh execution metadata before dispatch',
        assignment: `Expected revision ${expected}, found ${snapshot.revision}`,
      }[purpose],
      409,
    );
    const registration = this.definition(snapshot.workflow, snapshot.version);
    check(
      !registration.definition.terminal.includes(snapshot.state),
      'workflow_ended',
      {
        lease: `This work has ended as ${snapshot.state}; it takes no lease`,
        execution: 'This workflow has ended; it has no execution authority',
        assignment: 'This workflow has ended; it has no active assignment',
      }[purpose],
      409,
    );
    const rule = registration.policy?.assignments?.find((rule) => rule.state === snapshot.state);
    if (purpose === 'lease')
      check(
        rule?.lease && rule.execution,
        'lease_unavailable',
        'This assignment does not support leases',
        409,
      );
    else if (purpose === 'execution')
      check(
        rule?.execution,
        'execution_unavailable',
        'No fixed execution policy is registered for this workflow state',
        409,
      );
    check(
      rule,
      'assignment_unavailable',
      'The owning program has no assignment registered for this workflow step',
      409,
    );
    const context = readContext({
      caller,
      snapshot,
      tx,
      dependencies: await prerequisitesOf(tx, caller.projectId, snapshot.id),
    });
    return { row, snapshot, registration, rule, context };
  }

  /** Metadata-only activation shared by interactive begin and leased authentication. */
  private async markStarted(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<WorkflowWorkStart> {
    const previous = (await workStartsAt(tx, caller.projectId, [snapshot])).get(snapshot.id);
    if (previous) return previous;
    const event = await recorded(this.state, tx, caller, 'workflow.work_started', snapshot.id, {
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
    });
    const workStart: WorkflowWorkStart = {
      instanceId: snapshot.id,
      projectId: caller.projectId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      actorId: caller.actorId,
      startedAt: event.createdAt,
      eventId: event.id,
    };
    await tx.run(
      'INSERT INTO wf_work_starts (instance_id,project_id,workflow,version,state,revision,actor_id,started_at,event_id) VALUES (?,?,?,?,?,?,?,?,?)',
      snapshot.id,
      caller.projectId,
      snapshot.workflow,
      snapshot.version,
      snapshot.state,
      snapshot.revision,
      caller.actorId,
      workStart.startedAt,
      workStart.eventId,
    );
    return workStart;
  }

  private async assignmentInternal(
    caller: Caller,
    instanceId: string,
    expectedRevision: number | undefined,
    transaction?: Transaction,
  ): Promise<WorkflowAssignment> {
    this.assertOpen();
    caller = structuredClone(caller);
    checkInstance(instanceId);
    // Only `begin` names a revision, and it records a work start.
    const place = expectedRevision === undefined ? this.read : this.write;
    return await place(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const step = await this.load(caller, { instanceId, expectedRevision }, 'assignment', tx);
      await checkAssignment(step.rule, step.context);
      const assignment = await this.assignmentOf(caller, step, expectedRevision !== undefined, tx);
      await this.recheck(
        tx,
        [step.row],
        'Assignment callbacks must not change the workflow instance',
      );
      this.requireActive(step.registration);
      return assignment;
    });
  }

  /**
   * The packet for an admitted step, marking its start when `begin`. An execution the caller
   * already computed for this step is shown as it is.
   */
  private async assignmentOf(
    caller: Caller,
    step: Loaded,
    begin: boolean,
    tx: Transaction,
    execution?: WorkflowExecution,
  ): Promise<WorkflowAssignment> {
    const { snapshot, rule, context } = step;
    const workStart = begin
      ? await this.markStarted(caller, snapshot, tx)
      : ((await workStartsAt(tx, caller.projectId, [snapshot])).get(snapshot.id) ?? null);
    // A context provider may read guidance. It must see the marker this call is committing.
    const content = await buildAssignment(rule, context);
    if (rule.execution)
      content.execution = executionDisplay(execution ?? (await this.executionOf(step)));
    return {
      ...content,
      instanceId: snapshot.id,
      projectId: caller.projectId,
      actorId: caller.actorId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      workStart,
    };
  }
}
