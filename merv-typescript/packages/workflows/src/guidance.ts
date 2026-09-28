import { check, mapAsync } from '@merv/contracts';
import type {
  Caller,
  Transaction,
  WorkflowDefinition,
  WorkflowEvaluationInput,
  WorkflowDecision,
  WorkflowOverview,
  WorkflowWorkStart,
  WorkflowDependency,
  WorkflowLimitStatus,
  WorkflowProvidedBlocker,
  ProcessGraph,
} from '@merv/contracts';
import { processGraph } from './process.js';
import { readBlockers } from './blockers.js';
import { decision, readContext } from './evaluation.js';
import { workStartsAt } from './assignments.js';
import { limitStatusesOf } from './limits.js';
import { prerequisites, relations } from './dependencies.js';
import { WorkflowEngine, batches, type InstanceRow, type Registration } from './engine.js';

/** What one decision reads besides the instance, read for many instances at once. */
interface Facts {
  /** Whose callbacks decide, resolved once so the limits read and the decision agree. */
  registration?: Registration;
  /** The installed graph, else the pinned one: guidance still draws an unloaded version. */
  definition: WorkflowDefinition;
  dependencies: WorkflowDependency[];
  workStart: WorkflowWorkStart | null;
  limits: WorkflowLimitStatus[];
  blockers: WorkflowProvidedBlocker[];
}

/** Guidance: each instance's decision, read for many at once. */
export class WorkflowGuidance extends WorkflowEngine {
  /**
   * Computed from records on every read, in one snapshot; a stored copy could only drift.
   * With `checks: false` no program callback runs: the edges out of the current state carry
   * no status, and the gate is what the record says by itself. A view that draws only where
   * the work stands reads it so, because an action's check may read a submission's bytes.
   * A version whose program is not loaded is drawn from its pinned graph, with no status on
   * any edge.
   */
  async process(
    caller: Caller,
    instanceId: string,
    { checks = true }: { checks?: boolean } = {},
    tx?: Transaction,
  ): Promise<ProcessGraph> {
    return await this.reading(caller, tx, async (tx, caller) => {
      const [{ decision, facts }] = await this.guidance(
        caller,
        [await this.readRow(tx, caller.projectId, instanceId)],
        {},
        tx,
        checks,
      );
      const { dependencies, dependents } = await relations(
        tx,
        this.contracts,
        caller.projectId,
        instanceId,
      );
      const history = await this.historyIn(tx, caller.projectId, instanceId, false);
      return processGraph({
        definition: facts.definition,
        rules: facts.registration?.policy?.actions ?? [],
        history,
        decision,
        dependencies,
        dependents,
      });
    });
  }

  async evaluate(
    caller: Caller,
    instanceId: string,
    { ...query }: WorkflowEvaluationInput = {},
    tx?: Transaction,
  ): Promise<WorkflowDecision> {
    this.assertOpen();
    check(
      query.input === undefined || typeof query.action === 'string',
      'invalid_input',
      'Preflight input requires an action',
    );
    if (query.action !== undefined)
      check(
        typeof query.action === 'string' && query.action.length,
        'invalid_action',
        'Action is required',
      );
    const input = query.input === undefined ? undefined : this.data(query.input);
    return await this.reading(caller, tx, async (tx, caller) => {
      const row = await this.readRow(tx, caller.projectId, instanceId);
      if (input && Object.hasOwn(input, 'expectedRevision'))
        check(
          input.expectedRevision === row.revision,
          'revision_conflict',
          'Workflow changed; refresh guidance before acting',
          409,
        );
      return (await this.guidance(caller, [row], { ...query, input }, tx, true))[0].decision;
    });
  }

  async overview(caller: Caller, tx?: Transaction): Promise<WorkflowOverview> {
    return await this.reading(caller, tx, async (tx, caller) => {
      const rows = await tx.all<InstanceRow>(
        'SELECT * FROM wf_instances WHERE project_id=? ORDER BY created_at,id',
        caller.projectId,
      );
      const workflows = (await this.guidance(caller, rows, {}, tx, true)).map(
        (item) => item.decision,
      );
      // Work whose prerequisite ended without succeeding: the engine resolves that gate
      // itself, to the ending action its program declares. Such a record is not ready for
      // anything and nothing will be dispatched for it, and counting it as ready is what
      // makes a project with nothing left to do look busy. Work at an exhausted loop limit
      // still names an action, since a human may accept or end it, but nothing will be
      // dispatched for it and it is not ready for a worker.
      const gated = (gate: string) =>
        new Set(
          workflows
            .filter((item) => item.available && !item.terminal && item.currentGate === gate)
            .map((item) => item.instanceId),
        );
      const stalled = gated('dependency_failed');
      const escalated = gated('loop_limit_reached');
      const waiting = (id: string) => stalled.has(id) || escalated.has(id);
      return {
        projectId: caller.projectId,
        workflows,
        ready: workflows
          .filter((item) => item.nextAction && !waiting(item.instanceId))
          .map((item) => item.instanceId),
        blocked: workflows
          .filter(
            (item) =>
              item.available && !item.terminal && !item.nextAction && !waiting(item.instanceId),
          )
          .map((item) => item.instanceId),
        stalled: [...stalled],
        escalated: [...escalated],
        terminal: workflows.filter((item) => item.terminal).map((item) => item.instanceId),
        unavailable: workflows
          .filter((item) => !item.available && !item.terminal)
          .map((item) => item.instanceId),
      };
    });
  }

  /**
   * What guidance reads besides each instance, for all of them at once: prerequisites in two
   * reads, the work starts at their revisions in one, published blockers in one, and each
   * loaded limit in two however many instances stand where it counts.
   */
  private async facts(
    tx: Transaction,
    projectId: string,
    rows: readonly InstanceRow[],
  ): Promise<Map<string, Facts>> {
    const found = new Map<string, Facts>();
    for (const part of batches(rows)) {
      const ids = part.map((row) => row.id);
      const registered = part.map((row) =>
        this.registrations.get(`${row.workflow}@${row.version}`),
      );
      const dependencies = await prerequisites(tx, projectId, ids);
      const starts = await workStartsAt(tx, projectId, part);
      const blockers = new Map(ids.map((id) => [id, [] as WorkflowProvidedBlocker[]]));
      for (const item of await readBlockers(tx, projectId, ids))
        blockers.get(item.instanceId)!.push(item);
      const limits = await limitStatusesOf(
        tx,
        part.map((row, index) => ({
          id: row.id,
          state: row.state,
          policy: registered[index]?.policy,
        })),
      );
      for (const [index, row] of part.entries()) {
        const registration = registered[index];
        const definition =
          registration?.definition ??
          (await this.contracts.get(tx, row.workflow, row.version))?.definition;
        check(definition, 'workflow_unavailable', 'The pinned definition is unavailable', 503);
        found.set(row.id, {
          registration,
          definition,
          dependencies: dependencies.get(row.id)!,
          workStart: starts.get(row.id) ?? null,
          limits: limits.get(row.id)!,
          blockers: blockers.get(row.id)!,
        });
      }
    }
    return found;
  }

  /**
   * The decision for each of several instances an authorized caller read: their facts at once,
   * then each one's callbacks in turn, and one recheck after all of them.
   */
  private async guidance(
    caller: Caller,
    rows: readonly InstanceRow[],
    query: WorkflowEvaluationInput,
    tx: Transaction,
    checks: boolean,
  ): Promise<{ decision: WorkflowDecision; facts: Facts }[]> {
    const facts = await this.facts(tx, caller.projectId, rows);
    const decided = await mapAsync(rows, async (row) => {
      const known = facts.get(row.id)!;
      const context = readContext({
        caller,
        snapshot: this.snapshot(row),
        tx,
        dependencies: known.dependencies,
      });
      return {
        facts: known,
        decision: await decision(
          known.definition,
          known.registration?.policy,
          context,
          query,
          known.workStart,
          known.limits,
          known.blockers,
          checks,
        ),
      };
    });
    // Without a registration no program callback ran.
    const installed = new Set(decided.flatMap(({ facts }) => facts.registration ?? []));
    if (installed.size)
      await this.recheck(tx, rows, 'Guidance callbacks must not change the workflow instance');
    for (const registration of installed) this.requireActive(registration);
    this.assertOpen();
    return decided;
  }
}
