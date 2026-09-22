import type {
  Caller,
  CodeUnit,
  CodeUnitPublication,
  Scope,
  State,
  Tasks,
  WorkflowDefinition,
  Workflows,
} from '@merv/contracts';
import type { ResearchService } from '@merv/research';

/** What the test says main lacks and where a unit's publication stands; changed as it goes. */
export interface Main {
  unitIds: string[];
  quarantined?: string[];
  publication?: CodeUnitPublication | null;
}

/**
 * Code as Research sees it for a hosted project, answered by the test. Tasks stays real,
 * with a workspace-free stand-in for the service creator, so the injected consolidation task
 * is one the test finishes or fails like any other. Returns the units marked to publish.
 */
export function hostedCode(
  research: ResearchService,
  ctx: { state: State; tasks: Tasks },
  owner: Caller,
  main: Main,
): string[] {
  const published: string[] = [];
  research.bindCode({
    hosted: async () => true,
    acceptedSince: async () => ({
      unitIds: main.unitIds,
      quarantined: main.quarantined ?? [],
      main: 'main',
      hash: 'reading',
    }),
    publishOnAcceptance: async (_caller, { unitId }, tx) => {
      ctx.state.assertTransaction(tx);
      published.push(unitId);
      return { unitId } as CodeUnit;
    },
    unit: async (_caller, unitId) =>
      ({ unitId, publication: main.publication ?? null }) as CodeUnit,
  });
  const serviceTasks = (): ReturnType<Tasks['serviceTasks']> => ({
    create: async (input, tx) =>
      await ctx.tasks.create(
        owner,
        {
          title: input.title,
          goal: input.goal,
          checks: input.checks,
          dependsOn: input.dependsOn ?? [],
          requestId: input.requestId,
        },
        tx,
      ),
  });
  // Everything else stays the real service's, prototype methods included.
  research.bindTasks(
    new Proxy(ctx.tasks, {
      get: (tasks, key) => (key === 'serviceTasks' ? serviceTasks : Reflect.get(tasks, key)),
    }),
  );
  return published;
}

export interface LegacyCycle {
  version?: 2 | 5;
  name?: string;
  dependsOn?: string[];
  consolidationWorkspace?: 'none' | 'git';
  consolidationDependencies?: string[];
  /** Also authorize the cycle to advance itself, as `automatic: true` did on creation. */
  automatic?: { maxCycles: number };
}

/**
 * A cycle on a research version `research.create` no longer starts, seeded through that
 * version's persisted graph, never by relabelling a current instance or bypassing the
 * immutable definition checks. The Research service must not hold the version's handle while
 * this runs: close it, or unload the plugin, and bring it back afterwards.
 */
export async function legacyCycle(
  ctx: { state: State; scope: Scope; workflows: Workflows },
  owner: Caller,
  requestId: string,
  {
    version = 2,
    name = 'Retained research',
    dependsOn = [],
    consolidationWorkspace = 'none',
    consolidationDependencies = [],
    automatic,
  }: LegacyCycle = {},
): Promise<string> {
  const stored = await ctx.state.read(
    async (sql) =>
      (await sql.get<{ definition_json: string }>(
        "SELECT definition_json FROM wf_definitions WHERE name='research' AND version=?",
        version,
      ))!,
  );
  const definition = JSON.parse(stored.definition_json) as WorkflowDefinition;
  const handle = await ctx.workflows.register(definition, {
    successStates: ['complete'],
    actions: definition.edges.map((edge) => ({
      name: `${edge.action}_${edge.from}`,
      states: [edge.from],
      transitions: [edge.action],
      tool: 'research.advance',
      instruction: 'Advance the legacy research cycle.',
      check: () => {},
    })),
  });
  try {
    return await ctx.state.transaction(async (tx) => {
      const workflow = await handle.start(
        owner,
        { workflow: 'research', version, requestId, dependsOn, data: { name } },
        tx,
      );
      await tx.run(
        'INSERT INTO research_cycles(id,project_id,record) VALUES(?,?,?)',
        workflow.id,
        owner.projectId,
        JSON.stringify({
          id: workflow.id,
          projectId: owner.projectId,
          ownerId: owner.actorId,
          name,
          createdAt: workflow.createdAt,
          researchDependencies: dependsOn,
          consolidationWorkspace,
          consolidationDependencies,
        }),
      );
      if (automatic)
        await tx.run(
          'INSERT INTO research_automation(research_id,project_id,source_json,root_id,cycle_index,max_cycles) VALUES(?,?,?,?,?,?)',
          workflow.id,
          owner.projectId,
          JSON.stringify(await ctx.scope.delegationSource(owner, tx)),
          workflow.id,
          1,
          automatic.maxCycles,
        );
      return workflow.id;
    });
  } finally {
    handle.dispose();
  }
}
