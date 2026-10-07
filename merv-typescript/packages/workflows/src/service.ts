import { canonical, check, mapAsync, newId } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type {
  Caller,
  Transaction,
  WorkflowCatalogEntry,
  WorkflowDefinition,
  Workflows,
  WorkflowSnapshot,
  WorkflowPolicy,
  WorkflowWorkStart,
  WorkflowHistoryEntry,
  WorkflowDependency,
  WorkflowLimitStatus,
  WorkflowLoopLimit,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowPinned,
  WorkflowRelations,
  WorkflowTransitionCount,
} from '@merv/contracts';
import { readBlockers, replaceBlockers } from './blockers.js';
import { persistContract, readPinned } from './pinned.js';
import { validateDefinition } from './definition.js';
import { validatePolicy } from './evaluation.js';
import { readWorkStarts } from './assignments.js';
import { limitStatusOf, limitStatusesOf } from './limits.js';
import {
  attachDependencies,
  classify,
  dependents,
  instanceRelations,
  normalizeDependencies,
  prerequisites,
} from './dependencies.js';
import { batches, type InstanceRow, type Registration } from './engine.js';
import { WorkflowCommands } from './commands.js';

/** The most instances one dependency closure is walked over. */
const closureLimit = 5000;

/** Durable graph engine. Domain programs enforce their own guards through managed handles. */
export class WorkflowsService extends WorkflowCommands implements Workflows {
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('workflows', postgresMigrations);
    await this.state.read(async (sql) => await this.contracts.preload(sql));
  }

  async register(
    input: WorkflowDefinition,
    policy?: WorkflowPolicy,
  ): Promise<Awaited<ReturnType<Workflows['register']>>> {
    this.assertOpen();
    const definition = validateDefinition(input);
    const validatedPolicy = validatePolicy(definition, policy);
    const key = `${definition.name}@${definition.version}`;
    check(
      !this.registrations.has(key),
      'workflow_already_registered',
      `${key} is already registered`,
      409,
    );
    const pinned = await this.state.transaction(async (tx) => {
      await persistContract(tx, definition, validatedPolicy);
      return await readPinned(tx, definition.name, definition.version);
    });
    this.contracts.keep(pinned!);
    this.assertOpen();
    check(
      !this.registrations.has(key),
      'workflow_already_registered',
      `${key} is already registered`,
      409,
    );
    const registration = {
      definition,
      policy: validatedPolicy,
      registrationId: newId('execution'),
    };
    this.registrations.set(key, registration);
    return {
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
      start: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.startInternal(caller, input, registration, tx);
      },
      transition: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.transitionInternal(caller, input, registration, tx);
      },
      addDependencies: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.addDependenciesInternal(caller, input, registration, tx);
      },
    };
  }

  catalog(): WorkflowCatalogEntry[] {
    this.assertOpen();
    return [...this.registrations.values()]
      .map(({ definition, policy }) => {
        const copy = JSON.parse(canonical(definition)) as WorkflowDefinition;
        // The tool an edge is taken through: the one rule that owns its from:action pair.
        const tool = ({ from, action }: WorkflowDefinition['edges'][number]) =>
          policy?.actions.find(
            (rule) => rule.states.includes(from) && (rule.transitions ?? []).includes(action),
          )?.tool ?? null;
        return { ...copy, edges: copy.edges.map((edge) => ({ ...edge, tool: tool(edge) })) };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async pinned(
    workflow: string,
    version: number,
    transaction?: Transaction,
  ): Promise<WorkflowPinned | null> {
    this.assertOpen();
    return await this.read(transaction, (tx) => this.contracts.get(tx, workflow, version));
  }

  async ends(
    instances: readonly Pick<WorkflowSnapshot, 'workflow' | 'version' | 'state'>[],
    transaction?: Transaction,
  ): Promise<{ settled: boolean; failed: boolean }[]> {
    this.assertOpen();
    return await this.read(transaction, async (tx) =>
      mapAsync(instances, async ({ workflow, version, state }) => {
        const pinned = await this.contracts.get(tx, workflow, version);
        const { settled, failed } = classify(
          { id: '', workflow, version, state },
          pinned?.successStates,
          pinned?.definition.terminal ?? [],
        );
        return { settled, failed };
      }),
    );
  }

  async get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot> {
    return await this.reading(caller, tx, (tx, caller) =>
      this.readSnapshot(tx, caller.projectId, instanceId),
    );
  }

  async find(caller: Caller, instanceIds: readonly string[], tx?: Transaction) {
    return await this.reading(caller, tx, (tx, caller) =>
      this.snapshots(tx, caller.projectId, instanceIds),
    );
  }

  private async snapshots(tx: Transaction, projectId: string, instanceIds: readonly string[]) {
    const found = new Map<string, WorkflowSnapshot>();
    for (const part of batches([...new Set(instanceIds)]))
      for (const row of await tx.all<InstanceRow>(
        `SELECT * FROM wf_instances WHERE project_id=? AND id IN (${part.map(() => '?').join(',')})`,
        projectId,
        ...part,
      ))
        found.set(row.id, this.snapshot(row));
    return found;
  }

  async list(caller: Caller, tx?: Transaction, workflow?: string): Promise<WorkflowSnapshot[]> {
    return await this.reading(caller, tx, async (tx, caller) =>
      (
        await tx.all<InstanceRow>(
          `SELECT * FROM wf_instances WHERE project_id = ?${workflow ? ' AND workflow = ?' : ''} ORDER BY created_at, id`,
          caller.projectId,
          ...(workflow ? [workflow] : []),
        )
      ).map(this.snapshot),
    );
  }

  async history(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowHistoryEntry[]> {
    return await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await this.historyIn(tx, caller.projectId, instanceId, true);
    });
  }

  async open(workflow: string, projectId: string | null, tx?: Transaction) {
    this.assertOpen();
    // Each version's terminal states are read once, from its own pinned definition.
    return await this.read(tx, async (tx) =>
      (
        await tx.all<InstanceRow>(
          `WITH d AS (SELECT version,definition_json::jsonb->'terminal' AS terminal FROM wf_definitions WHERE name=?)
          SELECT i.* FROM wf_instances i JOIN d ON d.version=i.version WHERE i.workflow=? AND NOT d.terminal @> to_jsonb(i.state)
          AND (?::text IS NULL OR i.project_id=?) ORDER BY i.created_at,i.id`,
          workflow,
          workflow,
          projectId,
          projectId,
        )
      ).map(this.snapshot),
    );
  }

  async movedBy(instanceId: string, revision: number, tx?: Transaction) {
    this.assertOpen();
    const sql = 'SELECT actor_id FROM wf_history WHERE instance_id=? AND revision=?';
    return await this.read(
      tx,
      async (tx) =>
        (await tx.get<{ actor_id: string }>(sql, instanceId, revision))?.actor_id ?? null,
    );
  }

  async revisions(projectId: string, instanceIds: readonly string[], tx?: Transaction) {
    this.assertOpen();
    return await this.read(tx, async (tx) => {
      const found = new Map<string, Omit<WorkflowSnapshot, 'data'>>();
      for (const part of batches([...new Set(instanceIds)]))
        for (const row of await tx.all<Omit<InstanceRow, 'data_json'>>(
          `SELECT id,project_id,workflow,version,state,revision,created_at,updated_at FROM wf_instances WHERE project_id=? AND id IN (${part.map(() => '?').join(',')})`,
          projectId,
          ...part,
        )) {
          const { data: _data, ...revision } = this.snapshot({ ...row, data_json: '{}' });
          found.set(row.id, revision);
        }
      return found;
    });
  }

  async transitionCounts(projectId: string, instanceIds: readonly string[], tx?: Transaction) {
    this.assertOpen();
    return await this.read(tx, async (tx) => {
      const found = new Map(instanceIds.map((id) => [id, [] as WorkflowTransitionCount[]]));
      for (const part of batches([...found.keys()]))
        for (const row of await tx.all<{
          instance_id: string;
          action: string;
          from_state: string | null;
          to_state: string;
          n: number;
        }>(
          `SELECT instance_id,action,from_state,to_state,COUNT(*) AS n FROM wf_history WHERE project_id=? AND instance_id IN (${part.map(() => '?').join(',')}) GROUP BY instance_id,action,from_state,to_state`,
          projectId,
          ...part,
        ))
          found.get(row.instance_id)!.push({
            action: row.action,
            fromState: row.from_state,
            toState: row.to_state,
            count: Number(row.n),
          });
      return found;
    });
  }

  async moves(
    projectId: string,
    match: { action: string; keys: readonly string[]; values: readonly string[] },
    tx?: Transaction,
  ): Promise<number> {
    this.assertOpen();
    // History data is stored canonical, so a recorded string field reads `"key":"value"`.
    const patterns = match.keys.flatMap((key) =>
      match.values.map((value) => `%${JSON.stringify(key)}:${JSON.stringify(value)}%`),
    );
    if (!patterns.length) return 0;
    const sql = `SELECT COUNT(*) AS n FROM wf_history WHERE project_id=? AND action=? AND (${patterns.map(() => 'data_json LIKE ?').join(' OR ')})`;
    return await this.read(
      tx,
      async (tx) => (await tx.get<{ n: number }>(sql, projectId, match.action, ...patterns))!.n,
    );
  }

  async workStarts(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowWorkStart[]> {
    return await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return (await readWorkStarts(tx, caller.projectId, [instanceId])).get(instanceId)!;
    });
  }

  async records(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): ReturnType<Workflows['records']> {
    return await this.reading(caller, tx, async (tx, caller) => {
      const snapshots = await this.snapshots(tx, caller.projectId, instanceIds);
      if (!snapshots.size) return new Map();
      const held = [...snapshots.keys()];
      const starts = await readWorkStarts(tx, caller.projectId, held);
      const before = await prerequisites(tx, caller.projectId, held);
      const after = await dependents(tx, this.contracts, caller.projectId, held);
      return new Map(
        held.map((id) => [
          id,
          {
            snapshot: snapshots.get(id)!,
            workStarts: starts.get(id)!,
            dependencies: before.get(id)!,
            dependents: after.get(id)!,
          },
        ]),
      );
    });
  }

  async prerequisites(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>> {
    return await this.reading(caller, tx, (tx, caller) =>
      prerequisites(tx, caller.projectId, [...new Set(instanceIds)]),
    );
  }

  async limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    tx?: Transaction,
  ): Promise<Map<string, WorkflowLimitStatus>> {
    const ids = [...new Set(instanceIds)];
    return await this.reading(caller, tx, async (tx, caller) => {
      if (!ids.length) return new Map();
      // One read of the instances, then two per definition among them, never two per instance.
      const limits = new Map<string, { limit?: WorkflowLoopLimit; ids: string[] }>();
      for (const row of await tx.all<Pick<InstanceRow, 'id' | 'workflow' | 'version'>>(
        `SELECT id,workflow,version FROM wf_instances WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        caller.projectId,
        ...ids,
      )) {
        const at = `${row.workflow}@${row.version}`;
        if (!limits.has(at))
          limits.set(at, {
            limit: this.definition(row.workflow, row.version).policy?.limits?.find(
              (item) => item.name === name,
            ),
            ids: [],
          });
        limits.get(at)!.ids.push(row.id);
      }
      const statuses = new Map<string, WorkflowLimitStatus>();
      for (const { limit, ids: some } of limits.values())
        if (limit)
          for (const [id, status] of await limitStatusOf(tx, limit, some)) statuses.set(id, status);
      return statuses;
    });
  }

  async escalated(caller: Caller, tx?: Transaction): ReturnType<Workflows['escalated']> {
    return await this.reading(caller, tx, async (tx, caller) => {
      // Only states a loaded limit leaves, found by index, then two reads per such limit.
      const capped = [...this.registrations.values()].flatMap(({ definition, policy }) => {
        const states = [...new Set((policy?.limits ?? []).map((limit) => limit.from))];
        return states.length ? [{ definition, policy, states }] : [];
      });
      const items: Awaited<ReturnType<Workflows['escalated']>>['items'] = [];
      if (capped.length) {
        const rows = await tx.all<
          Pick<InstanceRow, 'id' | 'workflow' | 'version' | 'state'> & { revision: number | string }
        >(
          `SELECT id,workflow,version,state,revision FROM wf_instances WHERE project_id=? AND (${capped
            .map(
              ({ states }) =>
                `(workflow=? AND version=? AND state IN (${states.map(() => '?').join(',')}))`,
            )
            .join(' OR ')}) ORDER BY created_at,id`,
          caller.projectId,
          ...capped.flatMap(({ definition, states }) => [
            definition.name,
            definition.version,
            ...states,
          ]),
        );
        const policyOf = new Map(
          capped.map(({ definition, policy }) => [
            `${definition.name}@${definition.version}`,
            policy,
          ]),
        );
        const statuses = await limitStatusesOf(
          tx,
          rows.map((row) => ({
            id: row.id,
            state: row.state,
            policy: policyOf.get(`${row.workflow}@${row.version}`),
          })),
        );
        for (const row of rows) {
          const limit = statuses.get(row.id)!.find((status) => status.exhausted);
          if (limit) items.push({ instanceId: row.id, revision: Number(row.revision), limit });
        }
      }
      return {
        admin:
          !!items.length &&
          !caller.session &&
          !!caller.actorId &&
          (await this.scope.eligible(caller.projectId, caller.actorId, 'admin', tx)),
        items,
      };
    });
  }

  async replaceBlockers(
    input: {
      projectId: string;
      instanceId: string;
      provider: string;
      blockers: WorkflowProvidedBlockerInput[];
    },
    tx: Transaction,
  ): Promise<void> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    await this.readSnapshot(tx, input.projectId, input.instanceId);
    await replaceBlockers(tx, input);
  }

  async blockers(
    caller: Caller,
    instanceId?: string,
    tx?: Transaction,
  ): Promise<WorkflowProvidedBlocker[]> {
    return await this.reading(caller, tx, async (tx, caller) => {
      if (instanceId !== undefined) await this.readSnapshot(tx, caller.projectId, instanceId);
      return await readBlockers(
        tx,
        caller.projectId,
        instanceId === undefined ? undefined : [instanceId],
      );
    });
  }

  systemPrerequisites(provider: string): ReturnType<Workflows['systemPrerequisites']> {
    check(
      typeof provider === 'string' && provider.trim().length > 0,
      'invalid_provider',
      'A provider is required',
    );
    return {
      replace: async (input, tx) => {
        input = structuredClone(input);
        this.assertOpen();
        this.state.assertTransaction(tx);
        const wanted = normalizeDependencies(input.dependencies);
        const source = await this.readSnapshot(tx, input.projectId, input.instanceId);
        const have = (
          await tx.all<{ target_id: string }>(
            "SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind='system' AND owner=?",
            input.projectId,
            input.instanceId,
            provider,
          )
        ).map((row) => row.target_id);
        await attachDependencies(
          tx,
          this.contracts,
          source,
          wanted.filter((id) => !have.includes(id)),
          { owner: provider },
        );
        const gone = have.filter((id) => !wanted.includes(id));
        if (gone.length)
          await tx.run(
            `DELETE FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind='system' AND owner=? AND target_id IN (${gone.map(() => '?').join(',')})`,
            input.projectId,
            input.instanceId,
            provider,
            ...gone,
          );
      },
    };
  }

  /** Read once per snapshot, or per write transaction until it writes; each caller gets a copy. */
  async relations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowRelations | null> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    return structuredClone(
      await this.state.remember(`workflows:relations:${projectId}:${instanceId}`, () =>
        instanceRelations(tx, this.contracts, projectId, instanceId),
      ),
    );
  }

  /**
   * The children each loaded policy names for the instances given, as parent to children: one
   * call per version that declares them and batch of its instances, keeping each answer bounded.
   */
  private async children(
    tx: Transaction,
    projectId: string,
    rows: readonly { id: string; workflow: string; version: number }[],
  ): Promise<Map<string, string[]>> {
    const declaring = new Map<Registration, string[]>();
    for (const row of rows) {
      const registration = this.registrations.get(`${row.workflow}@${row.version}`);
      if (!registration?.policy?.children) continue;
      const ids = declaring.get(registration);
      if (ids) ids.push(row.id);
      else declaring.set(registration, [row.id]);
    }
    const found = new Map<string, string[]>();
    for (const [registration, all] of declaring)
      for (const ids of batches(all)) {
        const named = await registration.policy!.children!({
          projectId,
          instanceIds: Object.freeze(ids),
          tx,
        });
        check(
          typeof named === 'object' && named !== null && !Array.isArray(named),
          'invalid_workflow_policy',
          'Workflow children must be a record of instance id to child ids',
          500,
        );
        for (const id of ids) {
          const children = Object.hasOwn(named, id) ? named[id] : [];
          check(
            Array.isArray(children) && children.every((child) => typeof child === 'string'),
            'invalid_workflow_policy',
            'Workflow children must be lists of instance ids',
            500,
          );
          found.set(id, children);
        }
      }
    return found;
  }

  /** The provider freezes these roots before later dependencies can move a shared charge. */
  async sponsoringRoots(
    projectId: string,
    instanceIds: string[],
    tx: Transaction,
  ): Promise<string[]> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const parents = new Map<string, Set<string>>();
    const link = (child: string, parent: string) => {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child)!.add(parent);
    };
    for (const row of await tx.all<{ source_id: string; target_id: string }>(
      "SELECT source_id,target_id FROM wf_dependencies WHERE project_id=? AND kind='declared'",
      projectId,
    ))
      link(row.target_id, row.source_id);
    // Only an instance of a version whose policy names children can be a parent without an edge.
    const declaring = [...this.registrations.values()].filter(
      (registration) => registration.policy?.children,
    );
    if (declaring.length)
      for (const [parent, children] of await this.children(
        tx,
        projectId,
        await tx.all<{ id: string; workflow: string; version: number }>(
          `SELECT id,workflow,version FROM wf_instances WHERE project_id=? AND (${declaring.map(() => '(workflow=? AND version=?)').join(' OR ')})`,
          projectId,
          ...declaring.flatMap(({ definition }) => [definition.name, definition.version]),
        ),
      ))
        for (const child of children) link(child, parent);
    const seen = new Set<string>(),
      roots = new Set<string>(),
      queue = [...instanceIds];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const above = parents.get(id);
      if (!above?.size) roots.add(id);
      else queue.push(...above);
    }
    // Policy children can form a cycle even though declared dependencies cannot.
    return [...(roots.size ? roots : new Set(instanceIds))].sort();
  }

  /**
   * Walked level by level: each level's instances are read at once, then their edges in one
   * read and their children in one call per version that declares them, so a policy can name
   * the children no dependency edge does. The bound keeps a pathological graph from holding a
   * read open. A closure past it is refused rather than cut short: every caller would act on
   * the part it was given as if it were the whole.
   */
  async dependencyClosure(caller: Caller, instanceId: string, tx?: Transaction): Promise<string[]> {
    return await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      const seen = new Set<string>();
      let frontier = [instanceId];
      while (frontier.length) {
        // A name with no instance here, gone or another project's, is no part of the closure.
        const level: { id: string; workflow: string; version: number }[] = [];
        for (const part of batches(frontier)) {
          level.push(
            ...(await tx.all<{ id: string; workflow: string; version: number }>(
              `SELECT id,workflow,version FROM wf_instances WHERE project_id=? AND id IN (${part.map(() => '?').join(',')})`,
              caller.projectId,
              ...part,
            )),
          );
          check(
            seen.size + level.length <= closureLimit,
            'closure_too_large',
            `This dependency closure covers more than ${closureLimit} workflow instances`,
            409,
          );
        }
        if (!level.length) break;
        for (const row of level) seen.add(row.id);
        const next = (
          await tx.all<{ target_id: string }>(
            `SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id IN (${level.map(() => '?').join(',')})`,
            caller.projectId,
            ...level.map((row) => row.id),
          )
        ).map((item) => item.target_id);
        for (const children of (await this.children(tx, caller.projectId, level)).values())
          next.push(...children);
        frontier = [...new Set(next)].filter((id) => !seen.has(id));
      }
      return [...seen];
    });
  }

  close(): void {
    this.closed = true;
    this.registrations.clear();
  }
}
