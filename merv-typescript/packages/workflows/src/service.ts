import { canonical, check, newId } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type {
  Caller,
  Transaction,
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
} from '@merv/contracts';
import { readBlockers, replaceBlockers } from './blockers.js';
import { persistContract, readPinned } from './pinned.js';
import { validateDefinition } from './definition.js';
import { validatePolicy } from './evaluation.js';
import { readWorkStarts } from './assignments.js';
import { limitStatus, limitStatusOf } from './limits.js';
import {
  attachDependencies,
  instanceRelations,
  normalizeDependencies,
  prerequisites,
  prerequisitesOf,
  relations,
  requireDependencies,
} from './dependencies.js';
import { batches, type InstanceRow, type Registration } from './engine.js';
import { WorkflowCommands } from './commands.js';

const migrations = Object.entries(postgresMigrations).map(([version, sql]) => ({
  version: Number(version),
  sql,
}));

/** The most instances one dependency closure is walked over. */
const closureLimit = 5000;

/** Durable graph engine. Domain programs enforce their own guards through managed handles. */
export class WorkflowsService extends WorkflowCommands implements Workflows {
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('workflows', migrations);
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

  catalog(): WorkflowDefinition[] {
    this.assertOpen();
    return [...this.registrations.values()]
      .map(({ definition }) => JSON.parse(canonical(definition)) as WorkflowDefinition)
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

  async get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot> {
    return await this.reading(caller, tx, (tx, caller) =>
      this.readSnapshot(tx, caller.projectId, instanceId),
    );
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
    const sql = 'SELECT actor_id FROM wf_history WHERE instance_id=? AND revision=?';
    return await this.read(
      tx,
      async (tx) =>
        (await tx.get<{ actor_id: string }>(sql, instanceId, revision))?.actor_id ?? null,
    );
  }

  async workStarts(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowWorkStart[]> {
    return await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await readWorkStarts(tx, caller.projectId, instanceId);
    });
  }

  async limitStatus(
    caller: Caller,
    instanceId: string,
    name: string,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus> {
    return await this.reading(caller, tx, async (tx, caller) => {
      const snapshot = await this.readSnapshot(tx, caller.projectId, instanceId);
      const limit = this.definition(snapshot.workflow, snapshot.version).policy?.limits?.find(
        (item) => item.name === name,
      );
      check(limit, 'unknown_limit', 'This workflow has no such limit', 404);
      return await limitStatus(tx, limit, instanceId);
    });
  }

  async dependencies(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): ReturnType<Workflows['dependencies']> {
    return await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await relations(tx, this.contracts, caller.projectId, instanceId);
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

  async relations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowRelations | null> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    return await instanceRelations(tx, this.contracts, projectId, instanceId);
  }

  /** Reads only what the instance depends on, never what depends on it. */
  async checkDependencies(caller: Caller, instanceId: string, tx?: Transaction): Promise<void> {
    await this.reading(caller, tx, async (tx, caller) => {
      await this.readSnapshot(tx, caller.projectId, instanceId);
      requireDependencies(await prerequisitesOf(tx, caller.projectId, instanceId));
    });
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
