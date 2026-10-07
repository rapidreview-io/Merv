import { canonical, check, digest, newId, now, recorded, visible } from '@merv/contracts';
import type {
  Caller,
  Data,
  Transaction,
  WorkflowDefinition,
  WorkflowStart,
  WorkflowTransition,
  WorkflowAddDependencies,
  WorkflowExtendLimit,
} from '@merv/contracts';
import type { WorkflowSnapshot, WorkflowLimitStatus } from './models.js';
import { clearBlockers } from './blockers.js';
import { enforceAction, readContext } from './evaluation.js';
import { limitFor, limitMessage, limitStatus, limitStatusesOf } from './limits.js';
import {
  attachDependencies,
  detachDependencies,
  normalizeDependencies,
  prerequisitesOf,
} from './dependencies.js';
import { checkInstance, checkRevision, type InstanceRow, type Registration } from './engine.js';
import { WorkflowLeases } from './leases.js';

/**
 * An open instance of any stored version whose definition pauses starts of `workflow`. Only
 * that version's nonterminal states are looked for, on the (project, workflow, version, state)
 * index, so the ended instances that make up most of a project are never read; a version with
 * no nonterminal state never pauses anything.
 */
async function openBlocker(
  tx: Transaction,
  projectId: string,
  workflow: string,
): Promise<{ id: string; workflow: string } | undefined> {
  const blocking = (
    await tx.all<{ definition_json: string }>(
      `SELECT definition_json FROM wf_definitions WHERE (definition_json::jsonb -> 'blocksStarts') @> jsonb_build_array(?::text)`,
      workflow,
    )
  )
    .map((row) => JSON.parse(row.definition_json) as WorkflowDefinition)
    .map((definition) => ({
      definition,
      open: definition.states.filter((state) => !definition.terminal.includes(state)),
    }))
    .filter(({ open }) => open.length);
  if (!blocking.length) return undefined;
  return await tx.get<{ id: string; workflow: string }>(
    `SELECT id,workflow FROM wf_instances WHERE project_id=? AND (${blocking
      .map(
        ({ open }) => `(workflow=? AND version=? AND state IN (${open.map(() => '?').join(',')}))`,
      )
      .join(' OR ')}) LIMIT 1`,
    projectId,
    ...blocking.flatMap(({ definition, open }) => [definition.name, definition.version, ...open]),
  );
}

/** The commands that change an instance, with their receipts and history. */
export class WorkflowCommands extends WorkflowLeases {
  /**
   * An engine command rather than a program's, so it reaches managed workflows too. It writes
   * a grant without changing an active assignment's revision, so a pinned review stays valid.
   * An owner may resume suspended work through its hook in this same transaction; if the
   * owner refuses, the allowance and the resume both roll back.
   */
  async extendLimit(
    caller: Caller,
    { ...input }: WorkflowExtendLimit,
    transaction?: Transaction,
  ): Promise<WorkflowLimitStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    check(
      typeof input.limit === 'string' && input.limit.length > 0,
      'invalid_input',
      'A limit name is required',
    );
    check(
      Number.isSafeInteger(input.additional) && input.additional >= 1 && input.additional <= 100,
      'invalid_input',
      'additional must be an integer between 1 and 100',
    );
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    check(
      reason.length > 0 && reason.length <= 500,
      'invalid_input',
      'A reason of 1–500 characters is required',
    );
    const hash = digest({
      operation: 'extend_limit',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      limit: input.limit,
      additional: input.additional,
      reason,
    });
    return await this.write(transaction, async (tx) => {
      check(!caller.session, 'forbidden', 'A leased worker cannot raise its own limit', 403);
      await this.scope.require(caller, 'admin', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, input.instanceId);
      const registered = this.definition(snapshot.workflow, snapshot.version);
      const limit = registered.policy?.limits?.find((item) => item.name === input.limit);
      check(
        limit,
        'unknown_limit',
        `This ${snapshot.workflow} declares no limit ${input.limit}`,
        404,
      );
      const replay = await this.replay<{ id: string; status?: WorkflowLimitStatus }>(
        tx,
        caller.projectId,
        input.requestId,
        hash,
      );
      if (replay) {
        this.requireActive(registered);
        // A grant answers with what it recorded. One recorded before the status was kept
        // stored the instance instead, and is answered with the live status.
        return replay.status ?? (await limitStatus(tx, limit, snapshot.id));
      }
      check(
        !registered.definition.terminal.includes(snapshot.state),
        'invalid_transition',
        'Terminal workflow instances cannot be allowed more rounds',
        409,
      );
      await tx.run(
        'INSERT INTO wf_limit_grants (project_id,request_id,instance_id,limit_name,additional,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
        caller.projectId,
        input.requestId,
        snapshot.id,
        limit.name,
        input.additional,
        reason,
        caller.actorId,
        now(),
      );
      const status = await limitStatus(tx, limit, snapshot.id);
      // The grant has its own record, keyed by the instance like every receipt (the retirement
      // migrations match on its id). An owner's optional resume writes its own transition
      // receipt, so retrying this request cannot advance suspended work twice.
      await this.receipt(tx, caller.projectId, input.requestId, hash, { id: snapshot.id, status });
      await registered.policy?.limitExtended?.(
        { caller, snapshot, tx, input: { reason, requestId: input.requestId } },
        status,
      );
      await recorded(this.state, tx, caller, 'workflow.limit_extended', snapshot.id, {
        workflow: snapshot.workflow,
        version: snapshot.version,
        limit: limit.name,
        additional: input.additional,
        max: status.max,
        used: status.used,
        reason,
      });
      this.requireActive(registered);
      return status;
    });
  }

  protected async startInternal(
    caller: Caller,
    { ...input }: WorkflowStart,
    owner: Registration,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    const { name, version } = owner.definition;
    check(
      input.workflow === name && (input.version === undefined || input.version === version),
      'workflow_handle_mismatch',
      'The program handle only owns its registered workflow version',
      403,
    );
    this.requestId(input.requestId);
    const data = this.data(input.data);
    const dependsOn = normalizeDependencies(input.dependsOn);
    // The fingerprint names the set asked for, so a retry in another order, or with an empty
    // list for an omitted one, replays; the ids are attached in the order given.
    const sorted = [...dependsOn].sort();
    const hash = digest({
      operation: 'start',
      actorId: caller.actorId,
      workflow: name,
      version,
      data,
      ...(sorted.length ? { dependsOn: sorted } : {}),
    });
    return await this.write(tx, async (transaction) => {
      // A program authorizes its own commands, including reviewer-triggered repair.
      await this.scope.require(caller, 'read', transaction);
      // The fingerprint names this handle's workflow and version, so a replay is one of its own.
      const replay = await this.replay<WorkflowSnapshot>(
        transaction,
        caller.projectId,
        input.requestId,
        hash,
      );
      this.requireActive(owner);
      if (replay) return replay;
      const blocker = await openBlocker(transaction, caller.projectId, name);
      check(
        !blocker,
        'workflow_creation_paused',
        `New ${name} work is paused while ${blocker?.workflow} ${blocker?.id} is active. Existing work may continue.`,
        409,
      );
      const time = now();
      const snapshot: WorkflowSnapshot = {
        id: newId('wf'),
        projectId: caller.projectId,
        workflow: name,
        version,
        state: owner.definition.initial,
        revision: 0,
        data,
        createdAt: time,
        updatedAt: time,
      };
      await transaction.run(
        'INSERT INTO wf_instances (id, project_id, workflow, version, state, revision, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        snapshot.id,
        snapshot.projectId,
        snapshot.workflow,
        snapshot.version,
        snapshot.state,
        0,
        canonical(data),
        time,
        time,
      );
      // The id was just minted, so no edge can lead back to it.
      await attachDependencies(transaction, this.contracts, snapshot, dependsOn, { fresh: true });
      await this.record(
        transaction,
        caller,
        owner,
        snapshot,
        input.requestId,
        hash,
        'start',
        null,
        data,
        dependsOn.length ? { dependsOn } : {},
      );
      this.requireActive(owner);
      return snapshot;
    });
  }

  protected async transitionInternal(
    caller: Caller,
    { ...input }: WorkflowTransition,
    owner: Registration,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    check(
      typeof input.action === 'string' && input.action.length > 0,
      'invalid_action',
      'Workflow action is required',
    );
    checkRevision(input.expectedRevision);
    const data = this.data(input.data);
    const proposed = input.input === undefined ? undefined : this.data(input.input);
    const hash = digest({
      operation: 'transition',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      data,
      ...(proposed === undefined ? {} : { input: proposed }),
    });
    return await this.write(tx, async (transaction) => {
      // The program owns action-specific write/review policies; the engine still validates tenancy.
      const { row, before, replay } = await this.enter(transaction, caller, owner, input, hash);
      if (replay) return replay;
      // A stale revision is named before a withdrawn handle, as when the registry was read here.
      this.requireActive(owner);
      const edge = owner.definition.edges.find(
        (edge) => edge.from === before.state && edge.action === input.action,
      );
      check(
        edge,
        'invalid_transition',
        `Action ${input.action} is unavailable from ${before.state}`,
        409,
      );
      // Checked before the owning rule so the caller learns the limit, not whichever domain
      // refusal would also apply, and inside this transaction so the refusal rolls back the
      // whole command that asked for the return.
      const limit = limitFor(owner.policy, before.state, edge.action);
      if (limit) {
        const status = await limitStatus(transaction, limit, before.id);
        check(!status.exhausted, 'loop_limit_reached', limitMessage(status, before.workflow), 409);
      }
      if (owner.policy) {
        const rule = owner.policy.actions.find(
          (rule) => rule.states.includes(before.state) && rule.transitions?.includes(edge.action),
        );
        check(rule, 'invalid_workflow_policy', 'Transition has no registered guard', 500);
        await enforceAction(
          rule,
          readContext({
            caller,
            snapshot: before,
            tx: transaction,
            input: proposed,
            transition: edge.action,
            dependencies: await prerequisitesOf(transaction, caller.projectId, before.id),
          }),
        );
      }
      await this.recheck(
        transaction,
        [row],
        'Transition checks must not change the workflow instance',
      );
      this.requireActive(owner);
      const after: WorkflowSnapshot = {
        ...before,
        state: edge.to,
        revision: before.revision + 1,
        data: { ...before.data, ...data },
        updatedAt: now(),
      };
      const update = await transaction.run(
        'UPDATE wf_instances SET state = ?, revision = ?, data_json = ?, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?',
        after.state,
        after.revision,
        canonical(after.data),
        after.updatedAt,
        after.id,
        caller.projectId,
        before.revision,
      );
      check(
        update.changes === 1,
        'revision_conflict',
        'Workflow changed while applying this action',
        409,
      );
      await this.record(
        transaction,
        caller,
        owner,
        after,
        input.requestId,
        hash,
        input.action,
        before.state,
        data,
      );
      // Ended work waits on nothing, and the provider that spoke may not be loaded to say so.
      if (owner.definition.terminal.includes(after.state))
        await clearBlockers(transaction, after.id);
      // Recorded on arrival, never from a read. A step that stays in the capped state (a
      // reissued review) is not a new arrival and says nothing new.
      if (after.state !== before.state)
        for (const arrived of (
          await limitStatusesOf(transaction, [{ ...after, policy: owner.policy }])
        ).get(after.id)!)
          if (arrived.exhausted)
            await recorded(this.state, transaction, caller, 'workflow.escalated', after.id, {
              workflow: after.workflow,
              version: after.version,
              revision: after.revision,
              state: after.state,
              limit: arrived.name,
              used: arrived.used,
              max: arrived.max,
            });
      this.requireActive(owner);
      return after;
    });
  }

  protected async addDependenciesInternal(
    caller: Caller,
    { ...input }: WorkflowAddDependencies,
    owner: Registration,
    transaction?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    checkRevision(input.expectedRevision);
    const dependsOn = normalizeDependencies(input.dependsOn);
    const drop = normalizeDependencies(input.drop ?? null).filter((id) => !dependsOn.includes(id));
    // Fingerprinted as sets, as at start; the ids are attached and dropped in the order given.
    const hash = digest({
      operation: 'add_dependencies',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      dependsOn: [...dependsOn].sort(),
      ...(drop.length ? { drop: [...drop].sort() } : {}),
    });
    return await this.write(transaction, async (tx) => {
      // As at start and transition: the program authorizes its own commands.
      const { before, replay } = await this.enter(tx, caller, owner, input, hash);
      if (replay) return replay;
      check(
        !owner.definition.terminal.includes(before.state),
        'invalid_transition',
        'Terminal workflow instances cannot receive new dependencies',
        409,
      );
      const added = await attachDependencies(tx, this.contracts, before, dependsOn);
      const dropped = await detachDependencies(tx, before, drop);
      if (!added.length && !dropped.length) {
        await this.receipt(tx, caller.projectId, input.requestId, hash, before);
        this.requireActive(owner);
        return before;
      }
      const after = { ...before, revision: before.revision + 1, updatedAt: now() };
      const changed = await tx.run(
        'UPDATE wf_instances SET revision=?,updated_at=? WHERE id=? AND project_id=? AND revision=?',
        after.revision,
        after.updatedAt,
        after.id,
        caller.projectId,
        before.revision,
      );
      check(
        changed.changes === 1,
        'revision_conflict',
        'Workflow changed while adding dependencies',
        409,
      );
      await this.record(
        tx,
        caller,
        owner,
        after,
        input.requestId,
        hash,
        dropped.length ? 'replan_dependencies' : 'add_dependencies',
        before.state,
        { dependsOn: added, dropped },
        { dependsOn: added, dropped },
      );
      this.requireActive(owner);
      return after;
    });
  }

  /**
   * A handle command's entry on an instance of its own workflow version: the recorded response
   * when the request was already answered, else the instance at the revision the command named.
   */
  private async enter(
    tx: Transaction,
    caller: Caller,
    owner: Registration,
    input: { requestId: string; instanceId: string; expectedRevision: number },
    hash: string,
  ): Promise<{ row: InstanceRow; before: WorkflowSnapshot; replay?: WorkflowSnapshot }> {
    await this.scope.require(caller, 'read', tx);
    const row = await this.readRow(tx, caller.projectId, input.instanceId);
    const before = this.snapshot(row);
    check(
      owner.definition.name === before.workflow && owner.definition.version === before.version,
      'workflow_handle_mismatch',
      'The program handle does not own this workflow instance',
      403,
    );
    const replay = await this.replay<WorkflowSnapshot>(tx, caller.projectId, input.requestId, hash);
    if (replay) {
      this.requireActive(owner);
      return { row, before, replay };
    }
    check(
      before.revision === input.expectedRevision,
      'revision_conflict',
      `Expected revision ${input.expectedRevision}, found ${before.revision}`,
      409,
    );
    return { row, before };
  }

  /** The response a request recorded: a snapshot for a command, `{id, status}` for a grant. */
  private async replay<T>(
    tx: Transaction,
    projectId: string,
    requestId: string,
    hash: string,
  ): Promise<T | undefined> {
    const row = await tx.get<{ fingerprint: string; response_json: string }>(
      'SELECT fingerprint, response_json FROM wf_requests WHERE project_id = ? AND request_id = ?',
      projectId,
      requestId,
    );
    if (!row) return undefined;
    check(
      row.fingerprint === hash,
      'request_conflict',
      'Request id was already used for a different workflow command',
      409,
    );
    return JSON.parse(row.response_json) as T;
  }

  /** Stores a request's response, which a retry of it replays. */
  private async receipt(
    tx: Transaction,
    projectId: string,
    requestId: string,
    hash: string,
    response: unknown,
  ): Promise<void> {
    await tx.run(
      'INSERT INTO wf_requests (project_id,request_id,fingerprint,response_json) VALUES (?,?,?,?)',
      projectId,
      requestId,
      hash,
      canonical(response),
    );
  }

  /**
   * The event says whether the move ended the work and whether it ended well, as the version
   * pins them, so a consumer that acts only on ended work reads nothing for any other move.
   */
  private async record(
    tx: Transaction,
    caller: Caller,
    registration: Registration,
    snapshot: WorkflowSnapshot,
    requestId: string,
    hash: string,
    action: string,
    from: string | null,
    data: Data,
    eventData: Data = {},
  ): Promise<void> {
    await this.receipt(tx, caller.projectId, requestId, hash, snapshot);
    await tx.run(
      'INSERT INTO wf_history (instance_id, project_id, revision, action, actor_id, request_id, from_state, to_state, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      snapshot.id,
      caller.projectId,
      snapshot.revision,
      action,
      caller.actorId,
      requestId,
      from,
      snapshot.state,
      canonical(data),
      snapshot.updatedAt,
    );
    await recorded(this.state, tx, caller, 'workflow.transition', snapshot.id, {
      ...eventData,
      workflow: snapshot.workflow,
      version: snapshot.version,
      revision: snapshot.revision,
      action,
      from,
      to: snapshot.state,
      terminal: registration.definition.terminal.includes(snapshot.state),
      settled: registration.policy?.successStates?.includes(snapshot.state) ?? false,
    });
  }

  private requestId(value: string): void {
    check(
      typeof value === 'string' && visible(value) && value.length <= 256,
      'invalid_request',
      'A nonblank request id of 1–256 characters is required',
    );
  }
}
